import { describe, expect, it } from "vitest";
import { workflowLinkSchema } from "../../src/contracts/workflow.js";
import { applyCalibration, calibrate } from "../../src/lineage/calibrate.js";
import { resolveLinks } from "../../src/lineage/resolver.js";
import type { LineageNode } from "../../src/lineage/types.js";

/**
 * Conformance against the *real* merged contract, not a local mirror of it.
 *
 * Hand-diffing two envelopes proves they matched at the moment someone looked. Validating actual
 * resolver output against the shipped schema means a future divergence fails here instead of at
 * ingestion in production.
 */

const T0 = Date.parse("2026-08-12T10:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function population(): { sources: LineageNode[]; targets: LineageNode[] } {
  const sources: LineageNode[] = [];
  const targets: LineageNode[] = [];
  for (let i = 0; i < 30; i++) {
    const instrumented = i < 20; // CI writes trailers; laptops do not
    sources.push({
      stepId: `session-${i}`,
      layer: "cli",
      occurredAt: at(i * 10),
      endedAt: at(i * 10 + 5),
      ...(instrumented ? { identifiers: [{ kind: "workflow", value: `W-${i}` }] } : {}),
      signals: { principalId: `u${i}`, repo: "acme/api", files: ["src/a.ts", "src/b.ts"] },
    });
    targets.push({
      stepId: `commit-${i}`,
      layer: "vcs",
      occurredAt: at(i * 10 + 6),
      ...(instrumented ? { identifiers: [{ kind: "workflow", value: `W-${i}` }] } : {}),
      signals: { principalId: `u${i}`, repo: "acme/api", files: ["src/a.ts"] },
    });
  }
  return { sources, targets };
}

describe("resolver output conforms to the merged workflow link contract", () => {
  const links = resolveLinks({ ...population(), relation: "produced" });

  it("produces both deterministic and evidence links from a mixed population", () => {
    expect(links.some((l) => l.method === "deterministic")).toBe(true);
    expect(links.some((l) => l.method === "evidence")).toBe(true);
  });

  it("validates every emitted link against workflowLinkSchema unchanged", () => {
    for (const link of links) {
      const parsed = workflowLinkSchema.safeParse(link);
      if (!parsed.success) {
        throw new Error(
          `link ${link.sourceStepId}->${link.targetStepId} rejected: ${parsed.error.message}`,
        );
      }
    }
    expect(links.length).toBeGreaterThan(0);
  });

  it("still validates after calibration rewrites confidence", () => {
    // Calibration mutates confidence and calibration metadata; both must stay in-contract.
    const measured = calibrate(links, { calibrationId: "conformance" });
    const calibrated = applyCalibration(links, measured, { minSampleSize: 1 });

    for (const link of calibrated) {
      expect(workflowLinkSchema.safeParse(link).success).toBe(true);
    }
  });

  it("satisfies the contract's deterministic-implies-confidence-1 refinement", () => {
    for (const link of links.filter((l) => l.method === "deterministic")) {
      expect(link.confidence).toBe(1);
      expect(link.score).toBe(1);
    }
  });

  it("never emits a self-link, which the contract rejects", () => {
    expect(links.every((l) => l.sourceStepId !== l.targetStepId)).toBe(true);
  });

  it("stays within the contract's per-step link cap when grouped by source", () => {
    const bySource = new Map<string, number>();
    for (const link of links) {
      bySource.set(link.sourceStepId, (bySource.get(link.sourceStepId) ?? 0) + 1);
    }
    for (const count of bySource.values()) expect(count).toBeLessThanOrEqual(64);
  });
});
