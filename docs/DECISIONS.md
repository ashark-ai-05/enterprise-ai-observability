---
title: "AI Observability — Locked Decisions and Phase 0/1 Specification (Opus)"
tags: [observability, ai-agents, decisions, adr, attribution, enterprise]
status: draft
created: 2026-08-12
---

# Locked Decisions & Phase 0/1 Spec

Companion to `ARCHITECTURE.md`. Written after the operator asked the agents to resolve all open questions using their own judgement, given the stated enterprise constraints.

**This document decides. It does not implement.** Every open question is answered with a default, a rationale, and the trigger that would reverse it. Designed to compose with Codex's Control Tower event schema and Sonnet's memory-eval template, not replace them — where we differ, I say so and say why.

---

## 1. Decision record

| # | Question | Decision | Rationale | Reverse it if… |
|---|---|---|---|---|
| D1 | What does this fund first? | **Audit + cost defensibility.** Effectiveness second, memory third | Weeks not quarters, from data obtainable today. It buys the political runway for effectiveness work that needs a full quarter to reach significance | Leadership's actual question is "should we buy more seats" — then lead with model/prompt cohort comparison |
| D2 | Client-side git hook available? | **Assume NO for laptops, YES for CI.** Two-tier attribution (§2) that degrades gracefully | Optimism here is unrecoverable — if we assume yes and it's no, the entire effectiveness layer collapses. The two-tier design costs little and is robust either way | Confirmed laptop distribution — then Tier A becomes primary and Tier B stays only as a coverage auditor |
| D3 | Capture prompts/responses? | **No. Metadata + digests only.** Content capture off by default, centrally enforced | Source code and secrets flow through prompts. Enforceable today via Copilot managed settings; also the cheapest option, and content capture is the fastest route to breaching the observability cost budget | A specific debugging or eval need justifies a scoped, time-boxed, approved enclave |
| D4 | Analytical store? | **PostgreSQL.** Raw payloads in approved object storage | Already approved; EIL standardized on it (`local` PGlite / `hosted` Postgres profiles behind one schema contract); marts are 10⁷–10⁸ rows, comfortable. A new store is a new approval | Measured query latency degrades past ~10⁸ rows, or an approved warehouse already exists |
| D5 | Message broker / streaming? | **No.** Postgres `SKIP LOCKED` job queue | Agent session volume is minutes-scale, not millions/sec. This is a small-data problem wearing big-data clothes | Measured ingest exceeds what a Postgres queue absorbs — unlikely below thousands of sessions/day |
| D6 | MaaS gateway? | **Build a thin one.** Authenticate, attribute, meter, log, forward — no logic | Highest-value single change on the MaaS side, and it doubles as the budget/policy enforcement point the platform design already needs. Reuse, don't duplicate | A gateway already exists — then instrument it instead |
| D7 | Amp collection | **Central API poller, phase 0, starting immediately.** Plugin forwarder deferred to phase 3 | 90-day retention cliff makes this the only time-sensitive component. Zero install fits the constraint | — |
| D8 | Copilot collection | **Enterprise-managed OTel export, phase 0.** No wrapper | Config only, centrally enforced, devs can't silently opt out | Capability matrix shows critical fields missing → add a hooks-based shim |
| D9 | Cost model | **Persist provider-reported usage AND a versioned internal price book.** Never recompute history at today's prices | Prices change; restating history silently invalidates every prior report. Adopting Codex's point here | — |
| D10 | First outcome definition | **Feature only: PR merged to default branch.** Incidents deferred to phase 5 | *Mild disagreement with Codex*, who proposed one feature + one incident workflow. Incident volume is too low for statistics early, and the incident connector is a separate integration. One outcome, done properly, beats two done partially | Incident-linked AI risk is the actual executive question — then flip the order |
| D11 | Memory evaluation | **Build the ablation hooks now; build the eval when there is memory to evaluate** | The 5% memory-off holdout cannot be retrofitted — once memory is fully deployed there's no uncontaminated control group. The eval harness itself can wait | — |
| D12 | Retrieval eval harness | **Reuse EIL's ranking-regression gate.** Do not rebuild | Already working in the Enterprise Intelligence Layer project (https://github.com/ashark-ai-05/enterprise-intelligence-layer); Sonnet correctly identified it | — |
| D13 | Individual performance measurement | **Never. Team-level aggregation only, committed in writing** | If developers read this as surveillance they route around instrumentation, and a biased dataset is worse than none because it still looks authoritative. This is a data-integrity decision first | — |
| D14 | Scale sizing | **Do not size yet.** Take a one-week telemetry sample, then size | Guessing produces either waste or a rebuild. Design contracts for horizontal workers regardless | — |
| D15 | LLM-as-judge | **Not in phase 0–3.** Offline and sampled only, if ever | Expensive, and deterministic signals (tests, merges, survival, rework) cover most of what's needed. Judge scores are signals, not ground truth | A quality dimension emerges that deterministic signals genuinely cannot reach |

## 2. The attribution design, given D2

This is the part that changes most under enterprise constraints, so it gets specified properly.

### Tier A — deterministic (requires a hook; assume CI only)

Harness writes commit trailers:

```
AI-Session-Id: 0f6c4a…
AI-Tool: copilot-cli@1.4.2
AI-Turns: 12
```

Plus a side table of every commit SHA observed during the session, reconciled post-merge via `git patch-id` to survive squash and rebase. Where present, this is ground truth.

### Tier B — probabilistic (zero install, works everywhere)

Join telemetry to commits on four signals:

| Signal | Source |
|---|---|
| **Actor** | telemetry identity ↔ IdP subject ↔ git author email |
| **Repo / worktree** | session cwd ↔ repo |
| **File-set overlap** | files touched in session's tool calls ↔ files in commit (Jaccard) |
| **Time proximity** | session window vs commit timestamp |

Emit a **confidence score, never a boolean**. Precision rises with tight time windows, high file-set overlap, and a single active session per user per repo; it degrades with concurrent sessions, large refactors, and long-lived branches.

### Tier C — the part that makes Tier B defensible

CI runs *do* carry Tier A trailers. So on that subset, both tiers exist — **measure Tier B's precision and recall against Tier A ground truth, and publish the number.** That converts Tier B from a guess into an estimate with a stated error bar, and it lets you apply it honestly to the laptop population that has no trailers.

If measured Tier B precision is poor, that becomes the evidence-backed business case for funding laptop hook distribution — which is a far stronger argument than asking for it upfront.

> ⚠️ **Highest-priority item for the capability matrix:** Tier B depends on tool-call events carrying **file paths** under metadata-only capture (D3). If Copilot's OTel export omits paths when content capture is off, Tier B degrades to actor+time matching only, which is weak. **Verify this before anything else is built** — it is the load-bearing assumption in the whole attribution design, and there is a genuine tension between D3 (capture nothing) and Tier B (needs paths). If forced to choose: file *paths* are metadata, not content; argue for paths-without-contents.

## 3. Phase 0 — switch on and start archiving (days)

Zero analytics. The entire goal is to stop losing data and to learn what the telemetry actually contains.

1. **Copilot enterprise-managed OTel** → approved collector. Content capture **off**. Config push via MDM or server-managed settings.
2. **Amp archiver** — scheduled job, walks `/api/v2/threads` by cursor, persists raw thread metadata + `/usage` responses to object storage. Raw JSON, no schema, no normalization. Idempotent, resumable, cursor checkpointed.
3. **Cold-start gap measurement** — oldest retrievable Amp thread vs. actual Amp adoption date. Document the hole; it can never be filled.
4. **Capability matrix** — for the exact approved versions in your tenant, record which fields actually arrive from each source. Especially: file paths, token counts, model version, tool names, error classes, session identity.
5. **Proxy log access** confirmed for later coverage reconciliation.

Exit criterion: raw data accumulating from all three sources, and a written matrix separating observable facts from dashboard aspirations.

## 4. Phase 1 — spend and shadow AI (2–3 weeks)

1. **MaaS gateway** (D6) emitting the same event contract.
2. **Normalizer** — raw → OTel GenAI semantic conventions → `session / turn / step / model_call / tool_call` fact tables in Postgres. Provider-specific fields preserved in a namespaced envelope.
3. **Price book**, versioned (D9).
4. **Unified spend dashboard** — by provider, model, team, task class where known.
5. **Coverage reconciliation** — proxy egress vs instrumented telemetry. Publish **instrumentation coverage** as a first-class metric; the delta is **shadow-AI detection**.
6. **Anomaly alerts** — spend velocity, runaway loops, error-rate spikes.

Exit criterion: a defensible answer to "what are we spending on AI, by whom, and what fraction of it can we see?"

## 5. Explicitly deferred, and why

| Deferred | Why |
|---|---|
| Amp plugin forwarder | API poller covers cost/thread level; step detail isn't needed until phase 3 |
| Incident linkage | Statistically underpowered early; separate integration (D10) |
| LLM-as-judge evaluation | Deterministic signals cover most needs at a fraction of the cost (D15) |
| Automated blocking / termination | False-positive rate unknown; alert and recommend before enforcing |
| Full prompt capture | D3; revisit only with a scoped approved enclave |
| Broker, warehouse, columnar store | D4/D5; add on measured need only |
| Composite "AI productivity score" | Invites gaming, hides the trade-offs. Separate scorecards for cost, quality, speed, risk |

## 6. What would change my mind

- **File paths absent from metadata-only telemetry** → Tier B attribution is not viable; laptop hook distribution becomes blocking rather than optional, and D2 must be escalated as a hard dependency.
- **Amp tier lacks API v2 access** → Amp becomes plugin-only, endpoint distribution becomes blocking for that source, and the 90-day history is lost regardless.
- **An approved warehouse already exists** → D4 flips; use it, skip the Postgres marts.
- **Session volume above ~10k/day** → D5 revisits the queue choice.
- **Leadership's real question is seat purchasing, not audit** → D1 reorders; lead with model/prompt cohort comparison.

---

*Decisions locked pending operator override. No implementation until explicitly approved.*
