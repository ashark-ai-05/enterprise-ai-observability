/**
 * Lineage resolution — joining workflow steps across boundaries that cannot carry trace context.
 *
 * Where a layer propagates an identifier (W3C traceparent through your own services, a commit
 * trailer, an Amp thread ID) the link is a fact. Where none crosses — a Copilot CLI process
 * emitting its own trace IDs, a Jira issue, a merged PR — the link must be *inferred*, and an
 * inferred link that presents itself as a fact is how an audit trail becomes a plausible story.
 *
 * Everything here is deliberately free of workflow-specific stage names. The resolver knows about
 * identifiers, actors, repositories, files and time; it knows nothing about "feature" or
 * "investigation". Stage vocabulary is tenant-defined and validated by the workflow contract.
 */

export const RESOLVER_VERSION = "1" as const;

/** How a link was established. Deterministic means an identifier genuinely crossed the boundary. */
export type LinkMethod = "deterministic" | "evidence";

/**
 * A single identifier a step carries. Deterministic matching is exact equality on
 * `(kind, value)` — never across kinds, so a Jira key can never match a commit SHA.
 */
export interface LineageIdentifier {
  /** e.g. `traceparent`, `workflow`, `amp.thread`, `git.commit`, `jira.key`, `github.pr`. */
  kind: string;
  value: string;
}

/** Observable facts used for evidence matching when no identifier crosses the boundary. */
export interface LineageSignals {
  /** Resolved enterprise identity, not a display name. */
  principalId?: string;
  repo?: string;
  branch?: string;
  /** Repo-relative paths touched. Order-insensitive; compared by overlap. */
  files?: string[];
  /** Host or workspace, to avoid joining two developers' concurrent work. */
  host?: string;
}

/**
 * A step the resolver can link. Mirrors the workflow contract's step identity but stays
 * structurally independent: the resolver accepts anything carrying identity, time and signals.
 */
export interface LineageNode {
  stepId: string;
  /** Absent for un-instrumented hops — establishing it is often the resolver's whole job. */
  workflowId?: string;
  attemptId?: string;
  /** e.g. `jira`, `eil`, `cli`, `llm`, `tool`, `mcp`, `vcs`, `ci`. Opaque to the resolver. */
  layer: string;
  role?: string;
  /** When the step happened, ISO 8601. Used for ordering and time-proximity evidence. */
  occurredAt: string;
  /** Optional end of the step's interval; defaults to `occurredAt`. */
  endedAt?: string;
  identifiers?: LineageIdentifier[];
  signals?: LineageSignals;
}

/** Machine-readable justification for a link. Consumers must be able to audit *why*. */
export interface LineageEvidence {
  /** e.g. `shared_identifier`, `actor_match`, `repo_match`, `file_overlap`, `time_proximity`. */
  kind: string;
  /** Structured detail — the matched identifier, the Jaccard value, the gap in seconds. */
  detail: Record<string, unknown>;
  /** Contribution to the raw score, 0–1. Absent for deterministic evidence. */
  weight?: number;
}

/**
 * Whether `confidence` is an empirically measured probability or an unvalidated prior.
 *
 * This distinction is the point of the whole module. A weighted score invented by its author is a
 * *ranking*, not a probability; presenting it as one is exactly the "confidently wrong number"
 * failure this project keeps finding. Confidence becomes calibrated only once evidence links have
 * been scored against deterministic ground truth on the same population.
 */
export interface LinkCalibration {
  calibrated: boolean;
  /** Measured precision of evidence links at or above this score, when calibrated. */
  measuredPrecision?: number;
  /** Number of ground-truth pairs the measurement is based on. */
  sampleSize?: number;
  /** Identifier of the calibration run, so a link can be traced to how it was scored. */
  calibrationId?: string;
}

export interface LineageLink {
  sourceStepId: string;
  targetStepId: string;
  /** Tenant-defined semantic, e.g. `derived_from`, `produced`, `caused_by`. Opaque here. */
  relation: string;
  method: LinkMethod;
  /** 0–1. Exactly 1 only for deterministic links. */
  confidence: number;
  /** Raw score before calibration, retained so calibration can be re-run without re-resolving. */
  score: number;
  calibration: LinkCalibration;
  evidence: LineageEvidence[];
  /** How many targets competed for this source; >1 means the match was ambiguous. */
  candidateCount: number;
  resolverVersion: typeof RESOLVER_VERSION;
}

/** Tuning for evidence scoring. Weights are priors until calibration replaces the output. */
export interface ResolverOptions {
  /** Identifier kinds treated as authoritative when shared. Order does not matter. */
  deterministicKinds?: string[];
  /** Links scoring below this are not emitted at all. Default 0.3. */
  minScore?: number;
  /** Maximum gap, in seconds, before time proximity contributes nothing. Default 4h. */
  timeWindowSeconds?: number;
  /** Relative contribution of each evidence kind. Normalized internally. */
  weights?: Partial<Record<"actor" | "repo" | "files" | "time", number>>;
  /**
   * Divide confidence among equally-plausible targets.
   *
   * A commit matching five concurrent sessions is not 0.9 confident in each; asserting that would
   * multiply one outcome across five attributions — the same double-counting failure as summing a
   * parent thread's cost alongside its sub-threads. On by default.
   */
  penalizeAmbiguity?: boolean;
}
