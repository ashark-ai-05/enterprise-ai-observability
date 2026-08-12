# Keeping the joint demo falsifiable

**Status:** principles, plus what a day of applying them actually caught.

## What this document is now

It began as a full spine specification. Most of that has since been built or
superseded and this file has been trimmed to a pointer rather than left to rot:

| Was here | Now lives in |
|---|---|
| The `eil` source-kind gap and the event-bridge contract | [docs/DEMO_PLAN.md](DEMO_PLAN.md) — and the enum shipped |
| EIL emission points | merged: EIL's MCP audit-sink emitter |
| Schemas, scenario manifest, runner capabilities, acceptance gates | the `eil-observability-demo` integration repository |

What remains here is the part nothing else covers: **how to build a demo that
can be wrong, and why that turned out to matter more than any of the design.**

## The principle

A demo on synthetic data proves the logic, not the deployment. That is worth
stating on screen. The danger is not that synthetic data is unrealistic — it is
that a fixture you wrote yourself will agree with you, and its agreement looks
exactly like a result.

**Circular truth does not fail loudly. It fails plausibly.**

## What that cost, measured

Building the retrieval benchmark for this demo surfaced six validity defects in
the fixtures. None was visible in any metric. Every one produced numbers a
reasonable person would have quoted:

| Defect | What it produced |
|---|---|
| Relevance assigned by index arithmetic | "Relevant" documents shared no content with their query; retrieval had nothing to find |
| Subject count fixed while the corpus grew | Hundreds of near-identical documents per subject; scores measured collision, not retrieval |
| Truth selected by the same function that builds the graph edges | Graph expansion rewarded for recovering objects it had itself chosen |
| Restricted documents labelled relevant, twice, in two different functions | A correctly fail-closed system could never score perfectly — the benchmark rewarded leaking |
| Judgments emitted once per issue rather than per subject | Each subject weighted by how many issues hashed onto it |
| Absence asserted by the label rather than checked against the corpus | An "unanswerable" query that something could in fact answer |

Three conclusions were published and then retracted on the strength of these:
a 53% graph improvement at scale, a scorer regression of 71%, and a navigation
capability reported as broken that works perfectly. **All three were artifacts of
how truth was constructed, not of the product.**

## Rules that would have caught them earlier

1. **Truth must not be selected by the thing under test.** "The query contains no
   identifier" is not the same claim as "the truth was not chosen by the code
   that builds the edges". Assert the second.
2. **Never label a document the viewer cannot see as relevant.** Otherwise
   correct fail-closed behaviour is indistinguishable from a ranking loss, and
   the benchmark quietly pays for leaks.
3. **One query, one intent.** An exact lookup, a subject search and a graph
   traversal scored against a single flat list produce an aggregate that moves
   for reasons nobody can attribute.
4. **Prove absence against the corpus, not against the label.** An empty
   relevant set only checks the fixture agrees with itself.
5. **Report a metric's ceiling beside it.** `precision@10` on three relevant
   documents cannot exceed 0.3; reported bare it reads as failure.
6. **Suppress metrics a family cannot support.** `recallAt` and `ndcgAt` return
   1 for empty truth. That is a hardcoded pass wearing the costume of a result.
7. **Falsify every guard.** Break the thing it watches and confirm it fails. A
   guard that has never failed has not been shown to work.

## Acceptance criteria for the demo

Unchanged, and criterion 5 is the one that matters:

1. One command, deterministic, from clean clones, no credentials.
2. The graph reconstructs from inception to accepted outcome.
3. At least one link on the path is inferred, with a measured precision and n.
4. At least one ACL denial appears as a step, with the denied content absent
   from the event store.
5. **Deliberately corrupting one link makes the run fail, visibly.**

If nothing can make the demo fail, it is a video.

## What must not be claimed

- Nothing about enterprise auth, proxy behaviour, retention or real scale.
- Nothing about retrieval quality on real documents.
- `complete: true` certifies graph well-formedness, not link truth.
- No retrieval number at all until its benchmark has been independently
  reproduced. Every headline figure produced during this work was wrong at least
  once, and each was wrong in a direction that felt like a finding.
