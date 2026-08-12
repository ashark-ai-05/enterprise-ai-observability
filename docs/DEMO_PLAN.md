# Demo plan: EIL × AI Observability

Combines `enterprise-intelligence-layer` (EIL — federated search over Confluence/Jira/git/PDF)
with this repo's canonical events, workflow reconstruction, and lineage resolver, into one
end-to-end scenario over a synthetic enterprise. Written up per Codex's and Opus's analysis in
the Welcome channel thread on 2026-08-12; this document is the spec to build against, not a
restatement of that discussion. Last brought current 2026-08-12 ~21:00 UTC, after a day of corpus
and evaluation work stalled mid-sequence — see Status below before trusting anything past that.

**Verdict, current: not ready to demo, and not close.** The event bridge is built and merged.
The corpus/evaluation work below is not a ranking-tuning question anymore — it surfaced two
confirmed, real product capability gaps (exact identifier lookup does not exist; the system
cannot abstain from an unanswerable query) and retracted the day's single biggest retrieval
finding (graph's claimed scale advantage) as a measurement artifact. Nothing about retrieval
quality is defensible yet. Four EIL PRs (#50, #51, #52, #53) are open and draft; none merged.

## Scenario

Codex's narrative, adopted as-is — it's the right shape (one incident, one thread, five
questions answered at the end, not a corpus-size flex):

> A payment-retry incident arrives in Jira. The agent searches EIL across a Confluence runbook,
> prior Jira incidents, code/config, PDF architecture decisions, and engineer notes; hits one
> ACL-denied document; finds a stale retry policy and a code mismatch; proposes and applies a
> fix; runs tests. AI Observability then reconstructs the full chain — incident → retrieved
> evidence → model/tool calls → commit → CI → accepted outcome — with cost, confidence, and one
> deliberately unresolved/ambiguous link left visible rather than smoothed over.

Acceptance bar: one command, clean clones, no credentials, deterministic output, and the demo
must answer five questions on screen — what did the agent know, what was it allowed to see,
what did it do, what did it cost, did it work.

## Corpus status (EIL side) — updated, not the original three-item list

This section was written against `enterprise-intelligence-layer@b936b3d` and is now stale; here
is what actually happened, in order:

1. **Eval-seeding/stress-preset bug — fixed.** `src/demo/run.ts` seeded evaluations from the
   `ci` preset regardless of stress mode; a "stress" run reported `ci`-corpus numbers under a
   stress label. Landed in [PR #48](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/48).
   Precision is now printed with its own ceiling (`0.295 (ceiling 0.300)`) rather than bare.

2. **Scaling the corpus with the bug fixed surfaced a real cliff**, independent of the bug:
   recall@10 0.983 → 0.583 going from 310 to ~5,000 objects. Broken down by query, this was
   all-or-nothing (11 queries found all 3 relevant docs, 8 found none, only 1 was partial) — a
   single-point-of-failure cascade in graph expansion, not graceful degradation.

3. **That cascade was then found to be a corpus artifact, not (only) a retrieval fact.** The
   generator linked `issue N` to `page N % pageCount` and `code N % fileCount` — modulo
   arithmetic, not content — so the "relevant" runbook for an incident had no textual
   relationship to it and was reachable only through the link graph. Real documents sharing a
   topic are independently findable by lexical search; this corpus's were not, by construction.

4. **Content-bearing links made it worse before it got honest**, for a second artifact reason:
   `TOPICS` has 8 fixed entries that don't scale with corpus size, so "content-bearing" still
   meant ~625 near-duplicate documents fighting for the same 8 subjects at stress scale — the
   generator was still measuring itself, just via topical collision instead of modulo luck.

5. **Fixed properly in [PR #50](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/50)** (draft):
   subjects now scale with corpus size (31 at `ci`, 500 at `stress`, constant ~10 docs/subject),
   links are drawn from same-subject documents with mutual cross-references. Also revealed graph
   expansion actively *hurting* MRR on a realistic corpus by outranking lexical hits it used to be
   the only route to — two tests now correctly fail rather than being silently re-baselined.

6. **The obvious fixes (scalar weight tuning, a "graph-only can't displace" partition invariant,
   BM25 lexical scoring) were each tried and each measurement-disproved in turn** — [PR #51](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/51),
   [PR #52](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/52). BM25 made
   retrieval *substantially worse* (stress MRR fell 71%) for a real, findable reason: the query
   benchmark itself mixed three different intents — exact ID lookup, subject search, and graph
   navigation — into one flat relevance judgment, so no single scorer or fusion policy could
   satisfy all three at once. Retained as negative-result records, not merged.

7. **The benchmark itself was rebuilt around that finding — [PR #53](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/53)** (draft, still evolving as of the last
   update): split into query families with truth derived independently for each — `exact_lookup`,
   `subject_search`, `relationship_navigation`, `unanswerable`, `denied` (generated) plus a
   planned `cross_source_investigation` (hand-authored, not yet built — a synthetic generator
   cannot produce non-circular truth for "requires multiple independently relevant sources"
   without encoding the answer at generation time).
   - **Building it surfaced six separate fixture-validity defects**, five found by cross-review
     across three agents reading the actual diff rather than the summary — every one produced
     numbers that looked entirely plausible. Recurring pattern: a truth-selection function forgot
     the ACL filter (found independently in two different functions), or truth was silently
     selected by the same code that builds the thing being measured (circular by construction).
   - **Confirmed, current findings, all independently re-verified, not merely asserted:**
     - `exact_lookup` recall = **0.000 at both scales.** Not degraded — the capability does not
       exist. `classify()` extracts a `literal` for issue keys/paths/symbols; nothing in the
       product consumes it. Compounding cause: chunk indexing pulls from body/section/comment
       text only, never `title` — so an issue key like `PAY-47` is often structurally absent from
       the searchable index regardless of scorer or tokenizer.
     - Retrieval-level abstention is **absent** — the retriever returns candidates for 100% of
       constructed-unanswerable queries. (Precisely scoped: this measures the retriever, not an
       agent — no generation/verification layer sits in front of it here.)
     - ACL leakage is **zero**, measured (not assumed) across all families, including
       relationship-navigation cases that carry a protected neighbour in the graph.
     - Anchor-based navigation (given a known object, reach its authorized neighbours) **works
       perfectly** — 1.000 coverage, zero leakage, at both scales — when tested directly against
       the link store. It scored as broken (0.475/0.450, graph on/off identical) when routed
       through ordinary text search, because the anchor can't be found by search in the first
       place (same root cause as exact_lookup). **The real gap is a missing product surface**: no
       MCP tool or CLI verb exposes "given this object, show related evidence" today.
     - **Retracted:** the day's headline retrieval finding — graph expansion giving +53% mean MRR
       at enterprise scale — did not survive independent truth. It was measured when subject
       truth was the exact object trio the link-planning function itself selected; against truth
       assigned independently of that function, graph is neutral to slightly negative at scale.
       No scale-vs-corpus-size product decision should be made from that number; it no longer
       exists as a finding.
   - **Not yet done, work stalled here as of the last update:** the old-scorer vs. BM25 × graph
     on/off measurement matrix, run per family on the repaired benchmark. This is the one
     remaining step before any ranking conclusion is defensible. Nobody has picked it back up.

None of this blocks the event bridge below, which does not depend on retrieval quality. But no
demo should quote *any* retrieval number, and the "agent follows related evidence" beat in the
scenario above cannot be built until the missing navigation surface exists.

## The event bridge

This was framed as the biggest open gap in the thread. It's smaller than that, but not zero:

**Already there** — `src/contracts/workflow.ts` was built anticipating this integration and
nobody had wired it up yet: `workflowLayerSchema` already includes `"eil"` and `"index"`,
`workflowRoleSchema` already includes `"evidence"`, and `operationSchema` already includes
`"retrieval"`. `tests/workflow-proof.test.ts` already threads a `layer: "eil"` step through the
generic traceability proof.

**Missing, now fixed in this PR** — `sourceKindSchema` (`src/contracts/events.ts`) had
`copilot | amp | maas | harness | egress_proxy` and no `eil`. The existing traceability proof
was forced to source-tag its EIL/index step as generic `"harness"` because there was no honest
value to use (`tests/workflow-proof.test.ts:253`). Added `"eil"` to the enum plus a regression
test (`tests/event-contract.test.ts`, "accepts an eil retrieval event carrying an evidence
workflow role") pinning a full retrieval event through `normalizeTelemetryEvent`.

**Built — [PR #49](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/49).**
EIL does not, and should not, take a runtime dependency on this package: it is `private` with no
`exports` map, and coupling EIL's runtime to this repo's package contradicts the harness-neutral
boundary the group agreed on (EIL must stay usable with Amp, Copilot, or nothing installed at
all — see the squash-attribution and record/replay discussion in the Welcome thread). So instead
of importing anything, `enterprise-intelligence-layer/src/telemetry/canonical-event-sink.ts`
hand-builds events to this contract's field names and enum values, and its tests pin the
constraints this repo's zod schema would enforce (digest format, `metadata_only` agreement,
required fields) so a drift between the two shows up as a failing EIL test rather than a runtime
rejection whenever something finally validates both sides together.

It implements one seam rather than four separate call sites: every MCP tool call already funnels
through `ToolContext.audit.record()` (`src/serving/tools.ts`), so `CanonicalEventAuditSink`
covers `search_enterprise` and `get_evidence` (→ `operation: "retrieval"`) and
`list_containers`/`get_freshness` (→ `operation: "tool_call"`) in one implementation. Opt-in via
`EIL_TELEMETRY_SINK_PATH`; unset by default, so no behavior or latency change for anyone who
hasn't configured it. Two things intentionally not done, flagged rather than faked in the PR:
query text is digested (sha256) before it leaves the process, never carried raw; and `workflow`
correlation (`workflowId`/`attemptId` linking an event to the calling agent's run) is omitted
entirely, because MCP stdio carries no propagated context from the caller today — nothing is
fabricated to fill that gap.

Ingestion-time events (per-connector fetch) are not yet covered by this seam — `AuditSink` only
sees MCP tool calls, not the ingestion pipeline. Left for a follow-up if the demo narrative needs
it; the incident scenario as scoped is entirely search/evidence, so it may not.

**Freezing the wire contract, not the runtime dependency, is the actual next step**: agree the
JSON shape (field names, enum values, the digest-not-raw-text rule) as a versioned spec both
repos implement independently against, the way PR #49 already does by hand. Whether that becomes
a published package, a vendored schema file, or stays "match it by hand and pin it with tests"
is a decision for whoever settles the "one repo or two?" question — not assumed here.

Whether `metadata_only` should be *enforced* rather than declared — e.g. an attribute-key
allowlist per namespace, so a future producer inherits the guardrail instead of having to
remember it — is a separate, contract-level decision, tracked outside this doc.

## PDF

Agree with Opus: weakest source per unit of work, net-new extraction/chunking/citation, nothing
to reuse today (only occurrence in EIL is an *exclusion* regex skipping binaries in
`git-local.ts:49`). Sequence last. If the timeline is tight, stub it honestly — a fixture with
2-3 real PDFs and a citation-by-page-number check — rather than skip it silently or fake full
coverage.

## Sequencing — current

1. ~~Event bridge~~ — done: `eil` source kind + regression test here, emitter in
   [EIL PR #49](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/49), merged
   both sides.
2. ~~CI~~ — done: EIL already had it, observability's landed in
   [#11](https://github.com/ashark-ai-05/enterprise-ai-observability/pull/11), merged.
3. ~~Corpus honesty~~ / ~~ranking hypotheses~~ — superseded. The weight-tuning idea this section
   used to point to was one of three ranking hypotheses (weight/partition/BM25) all disproved by
   measurement; the actual defect was the benchmark, not the ranker. See item 7 above.
4. **Open, stalled:** finish PR #53 (query-family benchmark) — run the old-scorer/BM25 × graph
   on/off matrix per family, land it, then decide what (if anything) still needs a ranking fix
   once the benchmark can no longer produce a circular answer.
5. **Open, unscoped:** the missing navigation surface (an MCP tool / CLI verb for anchor-based
   "related evidence"), and a plan for the confirmed-absent exact-lookup capability. Both are now
   real product gaps, not measurement noise — need scoping before the demo's "agent follows
   related evidence" beat is buildable.
6. **Demo launcher** tying both repos into one command + timeline/dashboard output (Codex's
   scope) — blocked on (4) and (5), not started.
7. **Two items only the repo owner can move, open since ~12:00 UTC:** which corpus scale the
   product is optimized for (the retraction in item 7 above removes the evidence that made this
   urgent, but the question itself is still unanswered), and explicit approval for one real,
   paid Amp CLI session (the only Phase 0 proof still gated on spend rather than evidence).

## Division of labor — as it actually landed

- **Sonnet:** contract-side event bridge + regression test, observability CI (#11, merged),
  EIL-side emitter (#49, merged), cross-repo review on PR #53's fixtures across ~7 rounds.
- **Opus:** corpus honesty fixes (#48, merged), the query-family benchmark rebuild (#50–#53,
  all draft), BM25 experiment (#52, negative result), Amp attribution/squash-policy investigation.
- **Codex:** narrative, execution architecture (record/replay, Amp+Copilot as first-class
  runners), review direction on the family-split work — launcher not started, blocked on
  retrieval questions resolving first.
