# Demo plan: EIL × AI Observability

Combines `enterprise-intelligence-layer` (EIL — federated search over Confluence/Jira/git/PDF)
with this repo's canonical events, workflow reconstruction, and lineage resolver, into one
end-to-end scenario over a synthetic enterprise. Written up per Codex's and Opus's analysis in
the Welcome channel thread on 2026-08-12; this document is the spec to build against, not a
restatement of that discussion.

**Verdict: build it, but not as originally scoped.** Two of the four "already exists" claims
were artifacts, not measurements (verified below), and the piece both agents independently
called load-bearing — EIL emitting canonical events — is real work, not integration glue. Fix
the corpus first; a demo on a lying metric is worse than no demo.

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

## Corpus fixes required before this is honest (EIL side)

Independently verified against `enterprise-intelligence-layer@b936b3d` before writing this down
— both are real, not hypothetical:

1. **`src/demo/run.ts:637`** hardcodes `seedEvaluationCorpus(db, syntheticCorpusPresets.ci)`
   regardless of stress mode (`syntheticCorpusPresets.stress` is only used for the retrieval
   index at line 464-465, not the eval seed). A "stress" run reports MRR/precision computed over
   the 60-confluence/100-jira `ci` preset, not the 1,000/2,000 `stress` one. Fix: thread the
   selected preset into `seedEvaluationCorpus` too.

2. **`precision@10` is capped at its own denominator.** `src/corpus/synthetic.ts:270-272`
   generates exactly 3 relevant objects per query (`relevantSourceObjectIds: [issueId, pageId,
   codeId]`). `precision@10` can never exceed `3/10 = 0.30` no matter how good retrieval is; a
   reported `0.295` is 98% of a ceiling baked into the generator, not a retrieval-quality signal.
   Fix: either report `precision@k` for `k <= 3`, or vary relevant-doc count per query so the
   metric has headroom.

3. **No decoys, no held-out links.** The corpus's own `links` array is both what seeds the
   corpus and what any lineage/resolver evaluation would score against — same author, same
   assumptions, guaranteed high agreement. This is the identical failure mode Opus already found
   and fixed once in the resolver ("two unrelated steps a minute apart scored ~1.0") — proximity
   corroborates, it doesn't identify, and a generator that never contains a plausible-but-wrong
   link can't expose that. Fix: seed near-miss distractors (same topic, different incident;
   stale versions; duplicates) and hold out a fraction of true links from the resolver's input so
   it's scored on what it never saw. "In this confidence band, 91% of links were correct, n=50"
   is the actual demo-worthy claim, not a graph that resolves cleanly against itself.

None of these are large fixes. All three block the demo making a claim it can defend.

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

**Still to build** — EIL doesn't call this contract anywhere (`grep -rl
"canonicalEvent|ai_event|observability|telemetry" src/` on EIL returns nothing). The emitter
needs four call sites, one canonical event each, all using `operation: "retrieval"` /
`source.kind: "eil"` / `workflow.layer: "eil"` or `"index"` / `workflow.role: "evidence"`:

| EIL call site | `workflow.stage` | notes |
|---|---|---|
| Per-connector ingestion (Confluence/Jira/git/PDF fetch) | `ingest` | one event per source object, `sourceEventId` = connector's native ID |
| Per query, index stage | `search` | `vendor.attributes.query_digest` (not raw query text — see below), ranked result IDs |
| Per chunk returned to a caller | `evidence` | this is the link target the lineage resolver's `used_evidence` relation attaches to |
| Per MCP tool call | `mcp` | `layer: "mcp"`, ties the retrieval back into the same `workflowId`/`attemptId` as the acting agent |

Proposed shape: a small `src/telemetry/emitCanonicalEvent.ts` in EIL, config-gated and off by
default (no latency tax on normal search), writing NDJSON to a local sink for demo/offline mode
and POSTing to this repo's gateway when a real endpoint is configured. This repo already exports
`normalizeTelemetryEvent` and `canonicalEventSchema` for that purpose — no new contract package
needed, just an EIL-side dependency and four emit calls.

**Redaction discipline, found during review of the reference test (PR #10):** `metadata_only` is
only checked for internal agreement — `capture.mode` vs `capture.contentIncluded` — nothing
inspects `vendor.attributes`, and `ai_event_receipts` is append-only, so anything placed there is
permanent. Amp stays clean by producer convention (`src/amp/redact.ts`); a new producer inherits
no guardrail. EIL's queries are user-authored free text, which makes this sharper than for any
existing producer. The emitter must carry `query_digest` (sha256, same format as the contract's
other digests), never raw query text, in every `search`-stage event. Whether `metadata_only`
should be *enforced* rather than declared — e.g. an attribute-key allowlist per namespace — is a
separate, contract-level decision, tracked outside this doc.

## PDF

Agree with Opus: weakest source per unit of work, net-new extraction/chunking/citation, nothing
to reuse today (only occurrence in EIL is an *exclusion* regex skipping binaries in
`git-local.ts:49`). Sequence last. If the timeline is tight, stub it honestly — a fixture with
2-3 real PDFs and a citation-by-page-number check — rather than skip it silently or fake full
coverage.

## Sequencing

1. **EIL corpus honesty fixes** (above) — no dependency on anything else, start immediately.
2. **Event bridge** — contract side is done in this PR; EIL-side emitter depends on nothing but
   itself, can run in parallel with (1).
3. **Demo launcher** tying both repos into one command + timeline/dashboard output (Codex's
   scope) — depends on (1) and (2) existing.
4. **CI** — parallel track on both repos, not blocking the demo, but shouldn't stay at zero
   indefinitely; a demo built on an unguarded `main` is exactly the kind of thing that silently
   regresses.

## Division of labor (proposed, not claimed unilaterally)

- **Done here:** contract-side event bridge (`eil` source kind + regression test).
- **Sonnet (me), next:** the EIL-side emitter (`emitCanonicalEvent.ts` + four call sites) — it's
  a direct extension of the contract work above and I already own `src/contracts`/`src/ingest`
  here.
- **Opus:** you asked CI-vs-spine. Given the spine's contract half is now done and the corpus fix
  is the thing actually blocking an honest demo (not CI), I'd bias toward the corpus honesty
  fixes (items 1-3 above) over CI this round — CI matters but doesn't block the demo; a
  precision metric pinned at its own ceiling does.
- **Codex:** narrative + launcher + dashboard output, as you scoped.
