import type { LineageLink } from "./types.js";

/**
 * Calibration — converting an invented score into a measured probability.
 *
 * The evidence scorer's weights are a prior. They produce a defensible *ranking*, but the number
 * has no claim to being a probability until it is checked against reality. The check is available
 * for free wherever a population carries both kinds of link: CI runs write commit trailers, so
 * their source→commit edges are deterministic ground truth, while laptop runs have none.
 *
 * Score the evidence rule on the instrumented population, measure precision per score band, and
 * apply those measurements to the un-instrumented population. That is the difference between
 * "0.87 confident" and "in the band where this scored 0.8–0.9, 71% of links were correct".
 *
 * A useful side effect: if measured precision is poor, that is the evidence-backed argument for
 * funding real instrumentation — far stronger than asking for it up front.
 */

export interface CalibrationBand {
  /** Inclusive lower bound of the score band. */
  from: number;
  /** Exclusive upper bound, except the final band which is inclusive. */
  to: number;
  /** Evidence links falling in this band that had deterministic ground truth available. */
  sampleSize: number;
  /** Of those, the fraction whose target matched the deterministic target. */
  precision: number;
}

export interface CalibrationResult {
  calibrationId: string;
  bands: CalibrationBand[];
  /** Evidence links with no ground truth available; they cannot inform calibration. */
  unevaluated: number;
  /** Total ground-truth pairs used. Small samples make every band unreliable. */
  totalSamples: number;
}

export interface CalibrateOptions {
  /** Band edges, ascending. Default deciles from 0.3. */
  bands?: number[];
  /** Stable identifier for this run, recorded on every calibrated link. */
  calibrationId: string;
}

const DEFAULT_BANDS = [0.3, 0.5, 0.7, 0.85, 1.0];

/**
 * Measures evidence-link precision against deterministic links over the same sources.
 *
 * Only sources that have at least one deterministic link can contribute: for those, the correct
 * target is known, so an evidence link either agrees with it or does not. Sources without ground
 * truth are counted as `unevaluated` rather than quietly ignored — a calibration built on 5% of
 * the population should say so.
 */
export function calibrate(links: LineageLink[], options: CalibrateOptions): CalibrationResult {
  const edges = options.bands ?? DEFAULT_BANDS;
  const truth = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.method !== "deterministic") continue;
    const known = truth.get(link.sourceStepId) ?? new Set<string>();
    known.add(link.targetStepId);
    truth.set(link.sourceStepId, known);
  }

  const buckets = edges.slice(0, -1).map((from, index) => ({
    from,
    to: edges[index + 1] as number,
    hits: 0,
    total: 0,
  }));

  let unevaluated = 0;
  for (const link of links) {
    if (link.method !== "evidence") continue;
    const known = truth.get(link.sourceStepId);
    if (!known) {
      unevaluated += 1;
      continue;
    }
    const bucket = bucketFor(buckets, link.score);
    if (!bucket) continue;
    bucket.total += 1;
    if (known.has(link.targetStepId)) bucket.hits += 1;
  }

  const bands = buckets.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    sampleSize: bucket.total,
    precision: bucket.total === 0 ? 0 : round(bucket.hits / bucket.total),
  }));

  return {
    calibrationId: options.calibrationId,
    bands,
    unevaluated,
    totalSamples: bands.reduce((sum, band) => sum + band.sampleSize, 0),
  };
}

/**
 * Rewrites evidence links so `confidence` reflects measured precision.
 *
 * Links whose band has no samples are left uncalibrated rather than assigned a fabricated number:
 * an unmeasured band is exactly the case where an invented figure does the most damage.
 * Deterministic links pass through untouched — they were never estimates.
 */
export function applyCalibration(
  links: LineageLink[],
  calibration: CalibrationResult,
  options: { minSampleSize?: number } = {},
): LineageLink[] {
  const minSampleSize = options.minSampleSize ?? 20;
  return links.map((link) => {
    if (link.method === "deterministic") return link;
    const band = calibration.bands.find(
      (candidate) => link.score >= candidate.from && link.score < candidate.to,
    );
    const last = calibration.bands.at(-1);
    const resolved = band ?? (last && link.score >= last.to ? last : undefined);
    if (!resolved || resolved.sampleSize < minSampleSize) return link;
    return {
      ...link,
      confidence: resolved.precision,
      calibration: {
        calibrated: true,
        measuredPrecision: resolved.precision,
        sampleSize: resolved.sampleSize,
        calibrationId: calibration.calibrationId,
      },
    };
  });
}

function bucketFor<T extends { from: number; to: number }>(buckets: T[], score: number) {
  const found = buckets.find((bucket) => score >= bucket.from && score < bucket.to);
  if (found) return found;
  const last = buckets.at(-1);
  return last && score >= last.to ? last : undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
