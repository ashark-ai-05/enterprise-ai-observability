import {
  type LineageEvidence,
  type LineageLink,
  type LineageNode,
  RESOLVER_VERSION,
  type ResolverOptions,
} from "./types.js";

const DEFAULT_WEIGHTS = { actor: 0.35, repo: 0.2, files: 0.35, time: 0.1 } as const;
const DEFAULT_TIME_WINDOW_SECONDS = 4 * 60 * 60;
const DEFAULT_MIN_SCORE = 0.3;

export interface ResolveRequest {
  /** Steps that may originate a link. */
  sources: LineageNode[];
  /** Steps that may terminate one. May overlap with `sources`. */
  targets: LineageNode[];
  relation: string;
  options?: ResolverOptions;
}

/**
 * Resolves links between steps that could not propagate trace context.
 *
 * Two passes, deliberately in this order:
 *
 *  1. **Deterministic.** A shared identifier of an authoritative kind is a fact, not an inference.
 *     Confidence 1, and the pair is removed from evidence consideration entirely — otherwise a
 *     weaker inferred link would compete with a known-true one.
 *  2. **Evidence.** For pairs with nothing in common, score actor / repo / file overlap / time
 *     proximity. The output is a *ranking* until calibrated (see `calibrate.ts`).
 *
 * Causality is enforced by time: a target that precedes its source is never linked. Without this
 * the resolver happily produces cycles, and a lineage graph with cycles is not a lineage graph.
 */
export function resolveLinks(request: ResolveRequest): LineageLink[] {
  const options = request.options ?? {};
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const deterministicKinds = new Set(options.deterministicKinds);
  const penalizeAmbiguity = options.penalizeAmbiguity ?? true;

  const links: LineageLink[] = [];
  const settled = new Set<string>();

  // Pass 1 — shared identifiers.
  for (const source of request.sources) {
    for (const target of request.targets) {
      if (source.stepId === target.stepId) continue;
      const shared = sharedIdentifier(source, target, deterministicKinds);
      if (!shared) continue;
      if (!isCausallyOrdered(source, target)) continue;
      settled.add(pairKey(source, target));
      links.push({
        sourceStepId: source.stepId,
        targetStepId: target.stepId,
        relation: request.relation,
        method: "deterministic",
        confidence: 1,
        score: 1,
        calibration: { calibrated: true, measuredPrecision: 1 },
        evidence: [
          {
            kind: "shared_identifier",
            detail: { kind: shared.kind, value: shared.value },
          },
        ],
        candidateCount: 1,
        resolverVersion: RESOLVER_VERSION,
      });
    }
  }

  // Pass 2 — evidence, grouped by source so ambiguity can be measured across candidates.
  for (const source of request.sources) {
    const scored: Array<{ target: LineageNode; score: number; evidence: LineageEvidence[] }> = [];
    for (const target of request.targets) {
      if (source.stepId === target.stepId) continue;
      if (settled.has(pairKey(source, target))) continue;
      if (!isCausallyOrdered(source, target)) continue;
      const assessment = scorePair(source, target, options);
      if (assessment.score >= minScore) scored.push({ target, ...assessment });
    }
    if (scored.length === 0) continue;

    // Ambiguity is measured against candidates that are genuinely comparable, not every match.
    const best = Math.max(...scored.map((candidate) => candidate.score));
    const contenders = scored.filter((candidate) => near(candidate.score, best)).length;

    for (const candidate of scored) {
      const divisor = penalizeAmbiguity && near(candidate.score, best) ? contenders : 1;
      links.push({
        sourceStepId: source.stepId,
        targetStepId: candidate.target.stepId,
        relation: request.relation,
        method: "evidence",
        confidence: round(candidate.score / divisor),
        score: round(candidate.score),
        // Unvalidated until measured against deterministic ground truth.
        calibration: { calibrated: false },
        evidence: candidate.evidence,
        candidateCount: scored.length,
        resolverVersion: RESOLVER_VERSION,
      });
    }
  }

  return links;
}

/**
 * A target must not begin before its source does.
 *
 * Steps are intervals, so the comparison uses the source's start against the target's start and
 * tolerates equality — two events in the same millisecond are common in synthetic fixtures and in
 * batched emission.
 */
function isCausallyOrdered(source: LineageNode, target: LineageNode): boolean {
  const from = Date.parse(source.occurredAt);
  const to = Date.parse(target.occurredAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return to >= from;
}

function sharedIdentifier(
  source: LineageNode,
  target: LineageNode,
  kinds: Set<string>,
): { kind: string; value: string } | undefined {
  for (const left of source.identifiers ?? []) {
    // An empty allow-list means "any kind is authoritative"; otherwise honour the caller's list.
    if (kinds.size > 0 && !kinds.has(left.kind)) continue;
    for (const right of target.identifiers ?? []) {
      // Never match across kinds: a Jira key must not join a commit SHA that happens to collide.
      if (left.kind === right.kind && left.value === right.value) return left;
    }
  }
  return undefined;
}

function scorePair(
  source: LineageNode,
  target: LineageNode,
  options: ResolverOptions,
): { score: number; evidence: LineageEvidence[] } {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const window = options.timeWindowSeconds ?? DEFAULT_TIME_WINDOW_SECONDS;
  const evidence: LineageEvidence[] = [];

  const left = source.signals ?? {};
  const right = target.signals ?? {};

  // Only weights for dimensions both sides can actually speak to are normalized over, so a pair
  // with no file information is not silently penalised for the absence.
  let available = 0;
  let earned = 0;

  if (left.principalId && right.principalId) {
    available += weights.actor;
    if (left.principalId === right.principalId) {
      earned += weights.actor;
      evidence.push({
        kind: "actor_match",
        detail: { principalId: left.principalId },
        weight: weights.actor,
      });
    } else {
      // A different actor is positive evidence *against*, not merely absent evidence.
      return { score: 0, evidence: [] };
    }
  }

  if (left.repo && right.repo) {
    available += weights.repo;
    if (left.repo === right.repo) {
      earned += weights.repo;
      evidence.push({ kind: "repo_match", detail: { repo: left.repo }, weight: weights.repo });
    } else {
      return { score: 0, evidence: [] };
    }
  }

  if (left.files?.length && right.files?.length) {
    available += weights.files;
    const overlap = jaccard(left.files, right.files);
    if (overlap > 0) {
      earned += weights.files * overlap;
      evidence.push({
        kind: "file_overlap",
        detail: {
          jaccard: round(overlap),
          intersection: intersect(left.files, right.files).slice(0, 20),
        },
        weight: round(weights.files * overlap),
      });
    }
  }

  const gapSeconds = timeGapSeconds(source, target);
  if (gapSeconds !== undefined) {
    available += weights.time;
    if (gapSeconds <= window) {
      // Linear decay: immediately adjacent scores full, at the window edge scores nothing.
      const proximity = 1 - gapSeconds / window;
      earned += weights.time * proximity;
      evidence.push({
        kind: "time_proximity",
        detail: { gapSeconds: Math.round(gapSeconds), windowSeconds: window },
        weight: round(weights.time * proximity),
      });
    }
  }

  // Time proximity corroborates; it never identifies. Without this guard any two steps a minute
  // apart score ~1.0 on proximity alone, which would manufacture lineage between unrelated work
  // across the whole graph — the most damaging possible output from a resolver.
  const hasSubstantiveEvidence = evidence.some((item) => item.kind !== "time_proximity");
  if (available === 0 || !hasSubstantiveEvidence) return { score: 0, evidence: [] };
  return { score: round(earned / available), evidence };
}

/** Gap between the source's end (or start) and the target's start, in seconds. */
function timeGapSeconds(source: LineageNode, target: LineageNode): number | undefined {
  const from = Date.parse(source.endedAt ?? source.occurredAt);
  const to = Date.parse(target.occurredAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(0, (to - from) / 1000);
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const shared = intersect([...a], [...b]).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

function intersect(left: string[], right: string[]): string[] {
  const b = new Set(right);
  return left.filter((value) => b.has(value));
}

function pairKey(source: LineageNode, target: LineageNode): string {
  return `${source.stepId} ${target.stepId}`;
}

function near(value: number, best: number): boolean {
  return Math.abs(value - best) < 1e-9;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
