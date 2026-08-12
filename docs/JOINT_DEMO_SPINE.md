# Joint demo: the integration spine, and how to keep the demo honest

**Status:** proposal, nothing implemented. Written 2026-08-12 against
`enterprise-ai-observability` at `c248e57` and `enterprise-intelligence-layer` at
`b936b3d`.

## What this document is, and is not

The joint demo runs Enterprise Intelligence Layer (EIL) and this repository
together over a synthetic enterprise, so a viewer can watch one incident travel
from a Jira ticket through governed retrieval, agent activity, a commit, CI, and
an accepted outcome — with cost and confidence attached.

This document covers only the two parts most likely to be got wrong:

1. **The spine** — how EIL emits into the canonical event contract. Today it
   emits nothing, so this is the load-bearing gap.
2. **Falsifiability** — how the demo is built so it can be *wrong*, and
   therefore means something when it is right.

It deliberately does **not** specify the demo narrative, the launcher, the
timeline rendering, or the packaging. Those are covered elsewhere and this
document should be read alongside them, not instead of them.

## 1. The spine

### The contract asymmetry that has to be resolved first

The workflow vocabulary already anticipates an enterprise-index layer. The event
vocabulary does not:

| Schema | File | Has `eil`? |
|---|---|---|
| `workflowLayerSchema` | `src/contracts/workflow.ts:6` | **yes** |
| `sourceKindSchema` | `src/contracts/events.ts:6` | **no** — `copilot`, `amp`, `maas`, `harness`, `egress_proxy` |

So the graph can *describe* an EIL step while nothing can *emit* one. Every EIL
event would have to masquerade as `harness` and lose its provenance at the first
hop.

**This is a change to a shipped, merged contract with a conformance test guarding
it, not a local patch.** It needs to be agreed before anyone writes emission
code, or two people will invent two different workarounds. Proposed change:

```diff
 export const sourceKindSchema = z.enum([
   "copilot",
   "amp",
   "maas",
+  "eil",
   "harness",
   "egress_proxy",
 ]);
```

Additive to a `z.enum`, so existing producers are unaffected and existing
persisted events stay valid. `LineageRelation` already derives from the workflow
schema rather than restating it, so the resolver picks the change up
automatically.

### Event mapping

`operationSchema` (`src/contracts/events.ts:14`) already carries every verb the
spine needs — no new operations required:

| EIL operation | `operation` | `layer` | `role` | Carries |
|---|---|---|---|---|
| `ingestScope` run | `run` | `eil` | `activity` | scope id, source, objects ingested, checkpoint |
| Chunk/embed backfill | `run` | `eil` | `activity` | chunks embedded, model id |
| `search_enterprise` | `retrieval` | `eil` | `evidence` | query digest, result ids, arm scores |
| `get_evidence` | `retrieval` | `eil` | `evidence` | object id, found/not-found |
| ACL denial | `policy` | `eil` | `evidence` | principal, decision, rule — **never the denied content** |
| Publication | `artifact` | `eil` | `artifact` | published resource count, generation |
| Ranking gate | `evaluation` | `index` | `verification` | metric set, pass/fail vs baseline |

Two rules that are easy to get wrong and expensive to fix later:

- **Query text is not an event field.** EIL's own audit log already records
  query text and result counts but never result content. The canonical event
  should carry a **digest** of the query, not the query. A demo that leaks
  retrieval content into an append-only ledger teaches the wrong lesson about a
  system whose entire pitch is governed access.
- **A denial is an event.** "The agent was refused this document" is one of the
  most valuable things the demo can show, and it must appear as a first-class
  step in the graph rather than an absence. Absences are unprovable.

### Linking

EIL retrieval steps link to the consuming agent step with relation
`used_evidence` (`workflowLinkRelationSchema`, `src/contracts/workflow.ts:32`),
`method: "deterministic"` where the MCP call carries the workflow id, and
`method: "evidence"` where it does not.

**Both paths must exist in the demo.** If every link is deterministic, the
resolver is never exercised and its calibration story — the honest part — has
nothing to stand on.

## 2. Falsifiability

### The trap

The synthetic corpus generates its own ground-truth links
(`src/corpus/synthetic.ts`, e.g. `links.push({from: issueId, to: pageId, type:
"documents"})`). Score the lineage resolver against those links and it will
perform beautifully, because the generator and the resolver encode the same
author's idea of what a link looks like. The number would be circular and the
demo would be a machine for confirming itself.

This is not hypothetical. The resolver already shipped with a bug where two
entirely unrelated steps a minute apart scored ~1.0 on time proximity alone.
That bug was caught by a test that was *expected to pass*. At corpus scale, with
no adversarial content, nothing plays the role that test played.

The generator currently contains no decoys, distractors, contradictions or
near-duplicates.

### Corpus additions required

| Addition | Why | Demo moment it creates |
|---|---|---|
| **Near-miss decoys** — same topic and vocabulary, wrong incident | Retrieval scored on a corpus with no near-misses measures nothing | "It found the right runbook out of nine that mention retry backoff" |
| **Stale/superseded versions** of runbooks and configs | `supersedes` is in the relation vocabulary and untested | "It used the current policy and flagged the superseded one" |
| **Contradictions** between two sources | Real enterprises contradict themselves constantly | "It surfaced the disagreement rather than picking one silently" |
| **Held-out links** — a fixed fraction withheld from the resolver | The only way an inferred link is scored against something it did not see | A measured precision, with an `n` |
| **Unanswerable questions** — no supporting evidence in corpus | The failure mode buyers actually fear | "It returned nothing rather than something plausible" |
| **ACL-denied evidence on the answer path** | Governance claim is otherwise untested | "The answer changed because the agent could not see one document" |

### Metrics: two current numbers are artifacts

Both verified by running `pnpm demo:stress` on EIL `b936b3d`, not by reading:

1. **`demo:stress` does not scale the evaluation.** `src/demo/run.ts:637` calls
   `seedEvaluationCorpus(db, syntheticCorpusPresets.ci)` with the preset
   hardcoded, while `EIL_DEMO_CORPUS=stress` only switches a *different*
   section's corpus. A run labelled "stress" reported 60 confluence / 100 jira /
   150 git — exactly the `ci` preset. Retrieval quality has never been measured
   above small scale.

2. **`precision@10` cannot exceed 0.30 by construction.** Every generated query
   has exactly three relevant objects (`src/corpus/synthetic.ts:272`), so
   `precision@10 = |relevant ∩ top10| / 10` is capped at 3/10. The reported
   0.295 is 98% of its ceiling. It measures the constant, not the ranking.

Neither is a demo bug — they are both fine for a CI regression gate, where the
number only has to be *comparable to itself*. They become misleading the moment
they are shown to someone as a measure of quality. Fix both **before** any
number leaves the room: pass the selected preset through to the eval, and either
report `precision@k` against a corpus with a varying number of relevant items or
report a metric with a reachable ceiling (`recall@k`, `nDCG@k`, MRR) and drop
`precision@10` from the headline.

### What the demo reports about its own confidence

The lineage resolver ships `calibrated: false` — its confidences are priors, not
measured rates. The demo is the first place a calibrated number is even
possible, because held-out links give a population where propagated and inferred
links coexist.

The output should read:

> In confidence band 0.8–0.9, 91% of inferred links were correct (n=50).

not

> confidence 0.87

**If measured precision comes out poor, that is a result, not a failure.** It is
the evidence-backed argument for funding real instrumentation — CI writes commit
trailers, laptops do not — instead of asking for it on faith. A demo that cannot
produce a disappointing number cannot produce a credible one.

## 3. Acceptance criteria

The demo passes when, from clean clones with no credentials and no network:

1. One command runs it end to end, deterministically (fixed seed, stable output).
2. The graph reconstructs from Jira inception to accepted outcome, and
   `complete: true`.
3. At least one link on the path is **inferred**, not propagated, and carries a
   measured precision with a sample size.
4. At least one ACL denial appears **as a step in the graph**, and the denied
   content appears nowhere in the event store.
5. At least one unanswerable question returns no answer.
6. At least one superseded document is correctly not used.
7. A cost figure attaches to the workflow and reconciles with the sum of its
   model-call events.
8. Deliberately corrupting one link makes the run **fail**, visibly.

Criterion 8 is the one that matters. If nothing can make the demo fail, it is a
video, not a proof.

## 4. What this demo must not be claimed to prove

State these in the demo output itself, not only in a README:

- **Nothing about enterprise auth, proxy behaviour, retention or real scale.**
  Synthetic success proves the logic holds, not that it survives a corporate TLS
  intercept.
- **Nothing about retrieval quality on real documents.** Synthetic prose is
  regular in ways real Confluence is not.
- **Nothing about whether Copilot telemetry carries file paths.** That
  `[VERIFY]` is unresolved and no synthetic corpus can resolve it, because we
  would be generating the very field in question.
- **`complete: true` certifies graph well-formedness, not link truth.** Already
  stated in the traceability docs; it matters more here, because the demo puts
  `complete: true` and a confidence score on the same screen.

## 5. Sequencing

Ordered by what unblocks what:

1. Agree the `sourceKindSchema` change. Blocks all emission work.
2. Fix the two metric artifacts. Cheap, and blocks showing anyone a number.
3. Corpus adversarial additions — decoys, stale versions, contradictions,
   held-out links, unanswerable questions.
4. EIL emission for ingestion, retrieval and policy decisions.
5. Resolver over the joint corpus, with calibration against held-out links.
6. Narrative, launcher and rendering.
7. PDF and notes ingestion **last** — no PDF support exists in EIL today (the
   only occurrence of `pdf` is an exclusion regex skipping binaries at
   `src/connectors/git-local.ts:49`), it is net-new extraction and
   page-anchored citation work, and it proves less per unit of effort than any
   other source.

CI is a prerequisite for all of it and is tracked separately: neither repository
has `.github/workflows/`, so a combined demo would be the largest untested
surface either project has, assembled by hand.

## Open questions for a human

1. **Is the demo audience an executive or an engineer?** An executive demo can
   end at the joined cost-and-outcome sentence. An engineer demo has to show the
   denial, the held-out link and the failure mode, which roughly doubles it.
2. **One repository or two?** The spine makes EIL depend on this repository's
   contract package, which is currently `private` and unpublished with no
   `exports` map. Options: publish it, vendor the schemas, or a monorepo. This
   is a durable structural decision and should not be made incidentally by
   whoever writes the first import.
3. **How large is "large"?** EIL's `stress` preset is ~5,000 objects. Beyond
   roughly 10,000, PGlite in a temp directory stops being the right substrate
   and the demo acquires an infrastructure dependency it currently does not
   have — which would cost the "no credentials, one command" property that makes
   it runnable by anyone.
