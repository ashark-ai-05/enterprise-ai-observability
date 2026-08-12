import { describe, expect, it } from "vitest";
import { applyCalibration, calibrate } from "../../src/lineage/calibrate.js";
import { resolveLinks } from "../../src/lineage/resolver.js";
import type { LineageLink, LineageNode } from "../../src/lineage/types.js";

const T0 = Date.parse("2026-08-12T10:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function evidenceLink(source: string, target: string, score: number): LineageLink {
  return {
    sourceStepId: source,
    targetStepId: target,
    relation: "produced",
    method: "evidence",
    confidence: score,
    score,
    calibration: { calibrated: false },
    evidence: [{ kind: "actor_match", detail: { principalId: "u1" } }],
    candidateCount: 1,
    resolverVersion: "1",
  };
}

function truthLink(source: string, target: string): LineageLink {
  return { ...evidenceLink(source, target, 1), method: "deterministic", calibration: { calibrated: true } };
}

describe("calibrate", () => {
  it("measures evidence precision per score band against deterministic ground truth", () => {
    const links: LineageLink[] = [];
    // Instrumented population: 10 sources whose true target is known from a commit trailer.
    for (let i = 0; i < 10; i++) {
      links.push(truthLink(`s${i}`, `correct-${i}`));
      // High-scoring evidence agrees 8 times out of 10.
      links.push(evidenceLink(`s${i}`, i < 8 ? `correct-${i}` : `wrong-${i}`, 0.9));
      // Low-scoring evidence agrees 2 times out of 10.
      links.push(evidenceLink(`s${i}`, i < 2 ? `correct-${i}` : `other-${i}`, 0.4));
    }

    const result = calibrate(links, { calibrationId: "cal-1" });

    const high = result.bands.find((b) => b.from === 0.85);
    const low = result.bands.find((b) => b.from === 0.3);
    expect(high?.precision).toBe(0.8);
    expect(low?.precision).toBe(0.2);
    expect(result.totalSamples).toBe(20);
  });

  it("counts links with no ground truth as unevaluated rather than ignoring them", () => {
    // A calibration built on a fraction of the population must say so.
    const links = [truthLink("s1", "t1"), evidenceLink("s1", "t1", 0.9), evidenceLink("s2", "t2", 0.9)];

    const result = calibrate(links, { calibrationId: "cal-2" });

    expect(result.unevaluated).toBe(1);
    expect(result.totalSamples).toBe(1);
  });
});

describe("applyCalibration", () => {
  const measured = {
    calibrationId: "cal-3",
    unevaluated: 0,
    totalSamples: 100,
    bands: [
      { from: 0.3, to: 0.7, sampleSize: 50, precision: 0.35 },
      { from: 0.7, to: 1.0, sampleSize: 50, precision: 0.91 },
    ],
  };

  it("replaces an invented score with the measured precision for its band", () => {
    const [link] = applyCalibration([evidenceLink("s", "t", 0.8)], measured);

    expect(link?.confidence).toBe(0.91);
    expect(link?.score).toBe(0.8); // raw score retained so calibration can be re-run
    expect(link?.calibration).toMatchObject({
      calibrated: true,
      measuredPrecision: 0.91,
      sampleSize: 50,
      calibrationId: "cal-3",
    });
  });

  it("lowers confidence when the measurement is worse than the prior", () => {
    // The whole point: a plausible-looking 0.5 that is right a third of the time must say so.
    const [link] = applyCalibration([evidenceLink("s", "t", 0.5)], measured);

    expect(link?.confidence).toBe(0.35);
  });

  it("leaves a link uncalibrated when its band has too few samples", () => {
    const thin = { ...measured, bands: [{ from: 0.3, to: 1.0, sampleSize: 3, precision: 1 }] };

    const [link] = applyCalibration([evidenceLink("s", "t", 0.8)], thin);

    expect(link?.calibration.calibrated).toBe(false);
    expect(link?.confidence).toBe(0.8); // unchanged, not fabricated from 3 samples
  });

  it("never rewrites a deterministic link", () => {
    const [link] = applyCalibration([truthLink("s", "t")], measured);

    expect(link?.confidence).toBe(1);
    expect(link?.calibration.measuredPrecision).toBeUndefined();
  });
});

describe("end-to-end: instrumented population calibrates the un-instrumented one", () => {
  it("turns an invented score into a measured probability", () => {
    // CI runs write commit trailers (deterministic). Laptop runs do not, so their links are
    // evidence-only. Scoring the rule where truth exists is what lets the rest be reported
    // honestly instead of asserted.
    const nodes: { sources: LineageNode[]; targets: LineageNode[] } = { sources: [], targets: [] };
    for (let i = 0; i < 30; i++) {
      const ci = i < 20;
      nodes.sources.push({
        stepId: `session-${i}`,
        layer: "cli",
        occurredAt: at(i * 10),
        endedAt: at(i * 10 + 5),
        ...(ci ? { identifiers: [{ kind: "workflow", value: `W-${i}` }] } : {}),
        signals: { principalId: `u${i}`, repo: "acme/api", files: ["src/a.ts"] },
      });
      nodes.targets.push({
        stepId: `commit-${i}`,
        layer: "vcs",
        occurredAt: at(i * 10 + 6),
        ...(ci ? { identifiers: [{ kind: "workflow", value: `W-${i}` }] } : {}),
        signals: { principalId: `u${i}`, repo: "acme/api", files: ["src/a.ts"] },
      });
    }

    const links = resolveLinks({ ...nodes, relation: "produced" });
    const deterministic = links.filter((l) => l.method === "deterministic");
    const evidence = links.filter((l) => l.method === "evidence");

    expect(deterministic).toHaveLength(20); // the CI population
    expect(evidence.length).toBeGreaterThan(0); // the laptop population
    expect(evidence.every((l) => l.calibration.calibrated === false)).toBe(true);

    const result = calibrate(links, { calibrationId: "cal-e2e" });
    expect(result.unevaluated).toBeGreaterThan(0); // laptop links have no truth to check against
  });
});
