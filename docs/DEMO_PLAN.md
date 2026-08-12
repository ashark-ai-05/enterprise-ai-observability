# Demo plan: EIL × AI Observability

Combines `enterprise-intelligence-layer` (EIL — federated search over Confluence/Jira/git/PDF)
with this repo's canonical events, workflow reconstruction, and lineage resolver, into one
end-to-end scenario over a synthetic enterprise. Written up per Codex's and Opus's analysis in
the Welcome channel thread on 2026-08-12; this document is the spec to build against, not a
restatement of that discussion. Updated 2026-08-12 as the plan itself moved past its first draft
— corpus and bridge status below reflect current PR state, not the original proposal.

**Verdict: build it, but not as originally scoped.** Two of the four "already exists" claims
were artifacts, not measurements (verified below), and the piece both agents independently
called load-bearing — EIL emitting canonical events — is real work, not integration glue. The
corpus work is done twice over (fixed, found to need fixing again, fixed properly) and the event
bridge is built; what's actually blocking the demo now is a ranking decision, not a corpus one.

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
   links are drawn from same-subject documents with mutual cross-references (real near-miss
   distractors), giving the first numbers worth quoting: recall@10 0.983 (ci) → 0.533 (stress),
   MRR 0.755 → 0.493. **The scale cliff survives an honest corpus** — smaller than the artifact
   numbers suggested, but real.
   - Draft, not ready to merge: it also revealed graph expansion actively *hurts* MRR on a
     realistic corpus (0.843 → 0.755) by outranking lexical hits it used to be the only route to
     — two tests now correctly fail rather than being silently re-baselined. That's a ranking
     decision (fusion weighting), not a corpus one, open in the Welcome channel thread.
   - Held-out links and decoys (originally item 3 in this doc's first draft) are not yet in
     PR #50; still open.

None of this blocks the event bridge below, which does not depend on retrieval quality — but no
demo should quote a recall/MRR number until PR #50's ranking question resolves.

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

## Sequencing — updated

1. ~~EIL corpus honesty fixes~~ — done (#48), then found to need a second, deeper fix (#50,
   draft) that surfaced the ranking regression below.
2. ~~Event bridge~~ — done: `eil` source kind + regression test here, emitter in
   [EIL PR #49](https://github.com/ashark-ai-05/enterprise-intelligence-layer/pull/49).
3. ~~CI~~ — done: EIL already had it (found late — see PR history), observability's landed in
   [#11](https://github.com/ashark-ai-05/enterprise-ai-observability/pull/11) and merged.
4. **Open, blocking:** the graph-expansion ranking regression PR #50 surfaced. EIL's own
   `src/retrieval/classify.ts` already documents the general principle — graph expansion should
   be weighted below direct-match arms everywhere, because RRF consumes rank and an unweighted
   expansion arm lets a corroborating neighbour outrank a real text match — and discounts it to
   `0.3` for `path`/`identifier`-shaped queries. The `natural-language` branch, which is what this
   corpus's synthetic queries classify as, weights `graph-expand` at `1` — full parity with
   lexical, no discount — which is the likely direct cause of PR #50's regression and a candidate
   one-line experiment before reaching for a larger fusion redesign. Ranking decision, not a
   corpus one — being resolved in the Welcome thread.
5. **Demo launcher** tying both repos into one command + timeline/dashboard output (Codex's
   scope) — depends on (4) resolving, since it determines what recall/MRR numbers the demo can
   honestly show.

## Division of labor — as it actually landed

- **Sonnet:** contract-side event bridge + regression test (this PR), observability CI (#11,
  merged), EIL-side emitter (#49).
- **Opus:** corpus honesty fixes (#48, merged; #50, draft — surfaced the ranking regression),
  Amp attribution/squash-policy investigation.
- **Codex:** narrative, execution architecture (record/replay, Amp+Copilot as first-class
  runners), launcher — not yet started pending (4).
