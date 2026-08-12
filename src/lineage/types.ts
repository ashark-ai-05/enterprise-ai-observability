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

/**
 * Portable graph relations, matching `workflowLinkRelationSchema` in the workflow contract.
 *
 * Closed on purpose. These are graph semantics, not workflow stage names — the resolver stays
 * free of "feature"/"investigation" vocabulary, but a link whose relation the contract cannot
 * express would be rejected at ingestion, so an open string here would only defer the failure.
 */
export type LineageRelation =
  | "parent"
  | "caused_by"
  | "derived_from"
  | "used_evidence"
  | "produced"
  | "verified"
  | "supersedes";

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

/**
 * Values permitted in evidence detail.
 *
 * Mirrors the workflow contract's permitted detail union exactly (no `number[]`): a value this
 * module can emit but the contract cannot ingest is a runtime failure waiting for the first rule
 * that uses it.
 *
 * Deliberately scalar-or-array rather than arbitrary nested `unknown`: a resolved link is a hot
 * metadata record, and an open-ended detail bag would let prompt or log content ride into storage
 * under a metadata-only capture policy. (Constraint from Codex's workflow-link envelope; the same
 * failure shape as thread titles reaching the raw archive.) Rich evidence belongs content-addressed
 * in the protected artifact store, referenced by digest.
 */
export type EvidenceValue = string | number | boolean | string[];

/** Machine-readable justification for a link. Consumers must be able to audit *why*. */
export interface LineageEvidence {
  /** e.g. `shared_identifier`, `actor_match`, `repo_match`, `file_overlap`, `time_proximity`. */
  kind: string;
  /** Structured detail — the matched identifier, the Jaccard value, the gap in seconds. */
  detail: Record<string, EvidenceValue>;
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
  relation: LineageRelation;
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
   * Maximum links emitted per source. Default 64, matching the contract's per-step cap.
   *
   * Truncation keeps the highest-scoring candidates and is never silent: `candidateCount` reports
   * the true pre-truncation total, so `candidateCount > links emitted for that source` is a
   * detectable signal rather than a quietly dropped tail.
   */
  maxLinksPerSource?: number;
  /**
   * Divide confidence among equally-plausible targets.
   *
   * A commit matching five concurrent sessions is not 0.9 confident in each; asserting that would
   * multiply one outcome across five attributions — the same double-counting failure as summing a
   * parent thread's cost alongside its sub-threads. On by default.
   */
  penalizeAmbiguity?: boolean;
}
