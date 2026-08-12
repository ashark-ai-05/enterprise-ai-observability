import { describe, expect, it } from "vitest";
import { resolveLinks } from "../../src/lineage/resolver.js";
import type { LineageNode } from "../../src/lineage/types.js";

const T0 = Date.parse("2026-08-12T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function node(stepId: string, overrides: Partial<LineageNode> = {}): LineageNode {
  return { stepId, layer: "test", occurredAt: at(0), ...overrides };
}

describe("resolveLinks — deterministic", () => {
  it("links steps sharing an authoritative identifier with confidence 1", () => {
    const source = node("llm-call", {
      layer: "llm",
      identifiers: [{ kind: "workflow", value: "W-1" }],
    });
    const target = node("commit", {
      layer: "vcs",
      occurredAt: at(5),
      identifiers: [{ kind: "workflow", value: "W-1" }],
    });

    const [link] = resolveLinks({ sources: [source], targets: [target], relation: "produced" });

    expect(link?.method).toBe("deterministic");
    expect(link?.confidence).toBe(1);
    expect(link?.calibration.calibrated).toBe(true);
    expect(link?.evidence[0]).toMatchObject({ kind: "shared_identifier" });
  });

  it("never matches identifiers across kinds", () => {
    // A Jira key colliding with a commit SHA value must not join them.
    const source = node("a", { identifiers: [{ kind: "jira.key", value: "ABC-1" }] });
    const target = node("b", { occurredAt: at(1), identifiers: [{ kind: "git.commit", value: "ABC-1" }] });

    const links = resolveLinks({ sources: [source], targets: [target], relation: "produced" });

    expect(links).toEqual([]);
  });

  it("honours an explicit allow-list of authoritative kinds", () => {
    const source = node("a", { identifiers: [{ kind: "guess", value: "x" }] });
    const target = node("b", { occurredAt: at(1), identifiers: [{ kind: "guess", value: "x" }] });

    const links = resolveLinks({
      sources: [source],
      targets: [target],
      relation: "produced",
      options: { deterministicKinds: ["workflow", "git.commit"] },
    });

    expect(links).toEqual([]);
  });

  it("suppresses the evidence link for a pair already settled deterministically", () => {
    // Otherwise a weaker inference competes with a known-true fact for the same pair.
    const shared = { principalId: "u1", repo: "acme/api", files: ["a.ts"] };
    const source = node("a", { signals: shared, identifiers: [{ kind: "workflow", value: "W" }] });
    const target = node("b", {
      occurredAt: at(1),
      signals: shared,
      identifiers: [{ kind: "workflow", value: "W" }],
    });

    const links = resolveLinks({ sources: [source], targets: [target], relation: "produced" });

    expect(links).toHaveLength(1);
    expect(links[0]?.method).toBe("deterministic");
  });
});

describe("resolveLinks — evidence", () => {
  const session = node("session", {
    layer: "cli",
    occurredAt: at(0),
    endedAt: at(10),
    signals: { principalId: "u1", repo: "acme/api", files: ["src/a.ts", "src/b.ts"] },
  });

  it("scores actor, repo, file overlap and time proximity with auditable evidence", () => {
    const commit = node("commit", {
      layer: "vcs",
      occurredAt: at(12),
      signals: { principalId: "u1", repo: "acme/api", files: ["src/a.ts", "src/b.ts"] },
    });

    const [link] = resolveLinks({ sources: [session], targets: [commit], relation: "produced" });

    expect(link?.method).toBe("evidence");
    expect(link?.confidence).toBeGreaterThan(0.9);
    expect(link?.calibration.calibrated).toBe(false); // a prior, not a measurement
    expect(link?.evidence.map((e) => e.kind).sort()).toEqual([
      "actor_match",
      "file_overlap",
      "repo_match",
      "time_proximity",
    ]);
  });

  it("treats a different actor as evidence against, not merely missing evidence", () => {
    const other = node("commit", {
      occurredAt: at(12),
      signals: { principalId: "u2", repo: "acme/api", files: ["src/a.ts", "src/b.ts"] },
    });

    expect(resolveLinks({ sources: [session], targets: [other], relation: "produced" })).toEqual([]);
  });

  it("refuses to link a target that precedes its source, so the graph cannot cycle", () => {
    const earlier = node("commit", {
      occurredAt: at(-30),
      signals: { principalId: "u1", repo: "acme/api", files: ["src/a.ts"] },
    });

    expect(resolveLinks({ sources: [session], targets: [earlier], relation: "produced" })).toEqual([]);
  });

  it("divides confidence among equally plausible candidates", () => {
    // A commit matching three concurrent sessions is not ~1.0 confident in each; asserting that
    // would multiply one outcome across three attributions.
    const identical = { principalId: "u1", repo: "acme/api", files: ["src/a.ts"] };
    const commits = [1, 2, 3].map((n) =>
      node(`commit-${n}`, { occurredAt: at(11), signals: identical }),
    );

    const links = resolveLinks({
      sources: [node("s", { occurredAt: at(0), endedAt: at(10), signals: identical })],
      targets: commits,
      relation: "produced",
    });

    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.candidateCount).toBe(3);
      expect(link.confidence).toBeCloseTo(link.score / 3, 3);
    }
  });

  it("does not penalise a clear winner for the existence of weaker candidates", () => {
    const strong = node("strong", {
      occurredAt: at(11),
      signals: { principalId: "u1", repo: "acme/api", files: ["src/a.ts", "src/b.ts"] },
    });
    const weak = node("weak", {
      occurredAt: at(200),
      signals: { principalId: "u1", repo: "acme/api", files: ["src/z.ts"] },
    });

    const links = resolveLinks({ sources: [session], targets: [strong, weak], relation: "produced" });
    const best = links.find((l) => l.targetStepId === "strong");

    expect(best?.confidence).toBe(best?.score);
  });

  it("drops candidates below the minimum score instead of emitting noise", () => {
    const distant = node("distant", {
      occurredAt: at(10_000),
      signals: { principalId: "u1", repo: "acme/api", files: ["src/z.ts"] },
    });

    expect(
      resolveLinks({
        sources: [session],
        targets: [distant],
        relation: "produced",
        options: { minScore: 0.6 },
      }),
    ).toEqual([]);
  });

  it("normalizes only over dimensions both steps can speak to", () => {
    // A pair with no file data must not be penalised for the absence of file evidence.
    const noFiles = node("ticket", {
      layer: "jira",
      occurredAt: at(0),
      signals: { principalId: "u1" },
    });
    const alsoNoFiles = node("session", {
      layer: "cli",
      occurredAt: at(5),
      signals: { principalId: "u1" },
    });

    const [link] = resolveLinks({
      sources: [noFiles],
      targets: [alsoNoFiles],
      relation: "derived_from",
    });

    expect(link?.confidence).toBeGreaterThan(0.9);
  });

  it("emits nothing when the two steps share no comparable signal at all", () => {
    const a = node("a", { occurredAt: at(0) });
    const b = node("b", { occurredAt: at(1) });

    expect(resolveLinks({ sources: [a], targets: [b], relation: "produced" })).toEqual([]);
  });

  it("never establishes lineage on time proximity alone", () => {
    // Caught by the test above during development: proximity was the only available dimension,
    // so two unrelated steps a minute apart scored ~1.0. Proximity corroborates, it never
    // identifies — otherwise the resolver manufactures lineage across unrelated work.
    const a = node("unrelated-a", { layer: "jira", occurredAt: at(0), signals: { host: "x" } });
    const b = node("unrelated-b", { layer: "vcs", occurredAt: at(1), signals: { branch: "y" } });

    expect(resolveLinks({ sources: [a], targets: [b], relation: "produced" })).toEqual([]);
  });
});

describe("workflow contract compatibility", () => {
  it("caps links per source and reports the true candidate count so truncation is detectable", () => {
    // The contract caps links at 64 per step. Exceeding it would fail ingestion; truncating
    // silently would present a tidy list that dropped its tail unannounced.
    const signals = { principalId: "u1", repo: "acme/api", files: ["src/a.ts"] };
    const targets = Array.from({ length: 80 }, (_, i) =>
      node(`commit-${i}`, { occurredAt: at(11 + i * 0.01), signals }),
    );

    const links = resolveLinks({
      sources: [node("s", { occurredAt: at(0), endedAt: at(10), signals })],
      targets,
      relation: "produced",
    });

    expect(links).toHaveLength(64);
    expect(links.every((link) => link.candidateCount === 80)).toBe(true);
  });

  it("keeps the highest-scoring candidates when truncating", () => {
    const base = { principalId: "u1", repo: "acme/api" };
    const targets = [
      node("weak", { occurredAt: at(300), signals: { ...base, files: ["z.ts"] } }),
      node("strong", { occurredAt: at(11), signals: { ...base, files: ["a.ts", "b.ts"] } }),
    ];

    const links = resolveLinks({
      sources: [
        node("s", {
          occurredAt: at(0),
          endedAt: at(10),
          signals: { ...base, files: ["a.ts", "b.ts"] },
        }),
      ],
      targets,
      relation: "produced",
      options: { maxLinksPerSource: 1 },
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.targetStepId).toBe("strong");
  });

  it("emits at least one evidence item per link, as the contract requires", () => {
    const signals = { principalId: "u1", repo: "acme/api", files: ["a.ts"] };
    const links = resolveLinks({
      sources: [node("s", { occurredAt: at(0), signals })],
      targets: [node("t", { occurredAt: at(1), signals })],
      relation: "produced",
    });

    expect(links.every((link) => link.evidence.length >= 1)).toBe(true);
  });
});
