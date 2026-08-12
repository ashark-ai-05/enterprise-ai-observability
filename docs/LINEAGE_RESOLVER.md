# Lineage Resolver

Joins workflow steps across boundaries that **cannot carry trace context**. Complements the
workflow contract's propagated links rather than replacing them.

## Why this exists

An end-to-end trace is easy where you own the code. It breaks precisely where the value is:

| Hop | Carries your workflow ID? |
|---|---|
| EIL retrieval, your tool calls, MCP, MaaS gateway | **Yes** — W3C traceparent propagates |
| Copilot CLI | **No** — emits its own OTel trace IDs; you cannot inject into a vendor process |
| Amp thread | **No** — only a thread ID exists |
| Jira issue, git commit, PR, deploy | **No** — unless a commit trailer was written |

A proof that only demonstrates the propagating hops proves the easy half. `model call → code
change → merged PR → closed ticket` is where a lineage claim is actually needed, and it is exactly
where nothing propagates.

## Two kinds of link, never conflated

**Deterministic** — an identifier genuinely crossed the boundary. Exact equality on
`(kind, value)`, never across kinds, so a Jira key cannot join a commit SHA that happens to
collide. Confidence 1, and the pair is excluded from evidence scoring so a weaker inference cannot
compete with a known fact.

**Evidence** — nothing crossed, so the link is inferred from actor, repository, file overlap and
time proximity. Every link carries machine-readable evidence: an auditor must be able to see *why*
two things are believed connected. That is the difference between an audit trail and a plausible
story.

## Confidence is a ranking until it is measured

A weighted score invented by its author is not a probability. Emitting `confidence: 0.87` with no
indication that the weights were guessed is the same confidently-wrong-number failure this project
has hit repeatedly.

So links carry both `score` (raw, pre-calibration) and `calibration.calibrated`. Until calibrated,
`confidence` is explicitly a prior.

**Calibration is free wherever both link types coexist.** CI runs write commit trailers, so their
source→commit edges are ground truth; laptop runs have none. Score the evidence rule on the
instrumented population, measure precision per score band, apply it to the rest:

```
in the band where this scored 0.7–1.0, 91% of links were correct   (n=50)
in the band where this scored 0.3–0.7, 35% were correct            (n=50)
```

A band with too few samples is left **uncalibrated rather than assigned a number** — an unmeasured
band is where an invented figure does the most damage. Deterministic links are never rewritten.

Useful side effect: if measured precision is poor, that is the evidence-backed case for funding
real instrumentation — far stronger than asking for it up front.

## Three guards worth knowing

**Time proximity never establishes lineage on its own.** Found during development: with proximity
as the only available dimension, two unrelated steps a minute apart scored ~1.0. Proximity
corroborates; it does not identify. A link now requires at least one substantive signal.

**Ambiguity divides confidence.** A commit matching five concurrent sessions is not 0.9 confident
in each — that multiplies one outcome across five attributions, the same double-counting shape as
summing a parent thread's cost alongside its sub-threads. `candidateCount` is always reported. A
clear winner is not penalised for the existence of weaker candidates.

**A target may not precede its source.** Without this the resolver cheerfully emits cycles, and a
lineage graph with cycles is not a lineage graph.

Also: a *different* actor or repository is treated as evidence **against**, not as missing
evidence, and scoring normalizes only over dimensions both steps can speak to — so a pair with no
file data is not penalised for the absence.

## Capture policy

`LineageEvidence.detail` permits scalars and arrays only, not arbitrary nested values. A resolved
link is a hot metadata record, and an open-ended detail bag would let prompt or log content ride
into storage under a metadata-only policy. Rich evidence belongs content-addressed in the protected
artifact store. File-path intersections are capped at 20 entries.

## Workflow-contract compatibility

`LineageLink` maps 1:1 onto `workflowLinkSchema` with no translation. Three points were aligned
after diffing the two envelopes:

- **`relation` is the contract's closed vocabulary** (`parent`, `caused_by`, `derived_from`,
  `used_evidence`, `produced`, `verified`, `supersedes`), not an open string. These are graph
  semantics rather than stage names, so adopting them keeps the resolver stage-agnostic while
  ensuring a link cannot be rejected at ingestion.
- **`EvidenceValue` excludes `number[]`**, matching the contract's permitted detail union exactly.
  No current rule emits one, but a type this module can produce and the contract cannot ingest is a
  runtime failure waiting for the first rule that uses it.
- **Links are capped at 64 per source**, matching the contract's per-step limit. Truncation keeps
  the highest scorers and is detectable: `candidateCount` reports the true pre-truncation total, so
  `candidateCount > emitted links` signals a dropped tail rather than hiding it.

Links are returned flat; grouping by `sourceStepId` satisfies the contract's requirement that a
step's links all originate from it. Self-links are never emitted.

## Usage

```ts
import { applyCalibration, calibrate, resolveLinks } from "./lineage/index.js";

const links = resolveLinks({ sources, targets, relation: "produced" });
const measured = calibrate(links, { calibrationId: "2026-08-12" });
const calibrated = applyCalibration(links, measured);
```

The resolver contains no workflow stage vocabulary. It knows identifiers, actors, repositories,
files and time — not "feature" or "investigation". Stage semantics stay tenant-defined.

## Status

32 tests. The ambiguity penalty, causality guard and proximity guard were each falsified by
disabling them and confirming the corresponding test fails. Not yet exercised against real
telemetry — weights are priors, and `calibrated: false` says so until a live population measures
them.
