---
title: "AI Agent Observability, Attribution and Effectiveness — Design (Opus)"
tags: [observability, ai-agents, otel, cost-attribution, memory-evaluation, enterprise]
status: draft
created: 2026-08-12
---

# AI Agent Observability & Effectiveness Platform

Design-only. No implementation until the operator approves.

Origin: designed collaboratively by three AI agents (Codex, Sonnet, Opus) in a multi-agent chat session, 2026-08-12. Published for human review.

**Ask:** observability and monitoring for AI agents/harnesses in the enterprise — Copilot CLI, Amp CLI (ampcode.com), and MaaS API endpoints. Specifically: cost-effectiveness of prompts, quality of the memory system, how prompts and loops convert into shipped features and resolved incidents, and an auditable record of AI usage and its effectiveness. Enterprise-grade and scalable.

Facts verified against vendor documentation on 2026-08-12 are marked ✅. Assumptions needing confirmation are marked **[VERIFY]**.

---

## 1. The one-paragraph version

Collection is *mostly a solved problem you haven't turned on yet* — Copilot CLI now supports enterprise-managed OpenTelemetry export ✅, Amp exposes a workspace API with per-thread cost ✅, and MaaS traffic passes through infrastructure you own. The hard, valuable, and genuinely unsolved part is everything above collection: an **attribution spine** that carries a join key from prompt → commit → PR → release → incident, and an **effectiveness layer** that turns that spine into defensible unit economics. Build the spine first; it is cheap, and without it every downstream number is guesswork. Treat this as a **data-warehouse problem with late-arriving facts**, not an APM problem.

## 2. Collection: three sources, three different vantage points

The critical finding is that your two CLIs are asymmetric. They need different collection strategies, and a design that treats them uniformly will either under-collect from Copilot or over-engineer for Amp.

| Source | Best vantage point | Fidelity available | Effort |
|---|---|---|---|
| **Copilot CLI** | ✅ **Native enterprise-managed OTel export** — push OTLP to your collector | Step-level: agent interactions, LLM calls, tool executions, token usage | **Low** — configuration push, no code |
| **Amp CLI** | ✅ **Workspace API v2 poller** (`/api/v2/threads`, `/messages`, `/threads/{id}/usage`) | Thread-level + per-thread cost natively; step/token detail only via gateway | Medium — build a poller |
| **MaaS endpoints** | **Your own gateway** — you own both ends | Complete: prompts, tokens, latency, errors, routing | Low–medium |
| *(cross-cutting)* | **Egress proxy logs** | Coarse HTTP only — but catches shadow AI and instrumentation bypass | ~zero, logs likely already exist |

### 2.1 Copilot CLI — turn on what already exists

GitHub shipped enterprise-managed OpenTelemetry export on 2026-07-08 ✅. Verified properties:

- Applies to **both** the Copilot Chat extension in VS Code **and the agent host process that powers Copilot CLI** ✅.
- Admins configure the OTLP endpoint, transport (`otlp-http` / `otlp-grpc`), OTel service name, resource attributes, and exporter headers (e.g. collector auth token) ✅.
- Admins control **whether prompt, response and tool content is captured, and whether developers may change that** ✅. Managed settings take precedence over user preferences and environment variables ✅.
- Delivered via native MDM (Windows Registry / macOS preferences), server-managed settings tied to GitHub accounts, or file-based configuration ✅.
- Managed exporter headers are applied only to the extension's OTLP exporter and are **never passed through environment variables**, so collector tokens are not exposed to subprocesses ✅.
- The Copilot SDK has built-in OTel support and propagates **W3C Trace Context between SDK and CLI** ✅ — which means SDK-driven automation and the CLI can share one trace.

**Recommendation:** this is phase 0. It is a configuration change, it is centrally enforced, developers cannot silently opt out, and it yields step-level telemetry that would otherwise cost months to approximate. Do this before writing any code. Note that community requests for deeper CLI OTel parity are still open ([copilot-cli#1911](https://github.com/github/copilot-cli/issues/1911), [#2471](https://github.com/github/copilot-cli/issues/2471)) — **[VERIFY]** exactly which signals and attributes land in your tenant before designing dashboards on top of assumed fields.

### 2.2 Amp CLI — no OTel; use the workspace API

Amp's public documentation describes **no OpenTelemetry support and no structured telemetry export** ✅. What it does provide:

- **Enterprise API v2** (`https://ampcode.com/api/v2/openapi.json`) ✅ with, among others:
  - `GET /api/v2/threads` — list workspace threads, filterable and paginated
  - `GET /api/v2/threads/{threadID}/messages` — full message content
  - `GET /api/v2/threads/{threadID}/usage` — **cost data per thread**
  - `GET /api/v2/workspace/members`, `/groups`, `/entitlements`
  - `GET|POST /api/v2/workspace/model-provider-keys` — **bring-your-own provider keys**
- Amp **stores all agent threads on Sourcegraph's servers by default** ✅, accessible at ampcode.com/threads, with workspace-admin thread-visibility controls on Enterprise ✅.
- `amp usage` shows balance; threads display cost; `amp.showCosts` controls CLI display; entitlements enable per-user cost controls ✅.
- `AMP_API_KEY`, `AMP_LOG_LEVEL`, `AMP_SETTINGS_FILE` environment variables ✅.

Two consequences worth acting on:

1. **Build a poller, not an agent.** A scheduled job walks `/api/v2/threads` by cursor, pulls usage and (subject to policy) messages, and normalizes into your spine. No endpoint installs required — which fits the "no arbitrary software" constraint perfectly.

   ⚠️ **Hard retention cliff: the API serves thread usage data only for threads less than 90 days old** ✅ (credit: Sonnet, confirmed against the schema). Three consequences, and they change the plan:

   - **The poller must start before the analytics exist, not after.** Every day it isn't running, a day of cost history is lost *permanently* at the far end of the window. This is the one component where waiting has an irreversible cost, so it moves from phase 1 to **phase 0**.
   - **Cold-start hole.** If Amp has been in use for more than 90 days already, there is a permanent gap in the record that no later engineering recovers. Size it now and state it explicitly in any baseline reporting rather than letting a truncated history look like low early usage.
   - **You become the system of record, not the vendor.** Your retention obligation exceeds Amp's, so legal hold and audit export cannot be satisfied by "request it from Sourcegraph." The archive is yours to preserve.

   Note the squeeze this creates: the outcome facts you want to attribute cost to (code survival, incident linkage) *arrive* at ~90 days, while Amp's cost facts *expire* at 90 days. Late-arriving facts meeting an early-expiring source is precisely the case that breaks naive pipelines — persist raw usage on ingest and never re-derive it from the vendor.
2. **`model-provider-keys` is a strategic lever.** If Amp can be pointed at *your* model-provider keys, Amp's model traffic can be routed through your own gateway — converting Amp from a partly-opaque vendor into a fully-instrumented one, at token granularity, with your data-egress controls applied. **[VERIFY]** whether your Amp tier supports this and whether it changes Amp's own billing and thread-storage behaviour.

Also flag for security review: threads persisting on Sourcegraph servers by default is a data-residency fact, not a bug. Thread-visibility controls and entitlements are the levers.

### 2.3 MaaS — you own the whole path

Put a thin **AI gateway** in front of the MaaS endpoints. It is the only component that gives you complete, uniform, unbypassable telemetry, and it doubles as the enforcement point for budgets and data-class routing (see the earlier platform design). Keep it dumb: authenticate, attribute, meter, log, forward. No LLM logic in it.

### 2.4 The proxy is your coverage auditor

Reconcile egress-proxy logs against instrumented telemetry. The delta answers a question nothing else can: **what fraction of AI traffic do we have task context for?** Report *instrumentation coverage* as a first-class metric, and treat un-reconciled egress to AI providers as **shadow-AI detection**. In most enterprises this single dashboard is what gets the programme funded.

## 3. The attribution spine — the highest-leverage decision in this design

Everything the operator actually asked for — cost per feature, prompt effectiveness, incident linkage — reduces to one question: *how do you carry an identifier from a prompt all the way to production?*

```
turn → session → file edits → commit → branch → PR → merge → release → deploy → incident
```

### 3.1 Commit trailers are the join key

Have the harness/wrapper write trailers into every commit produced during an agent session:

```
AI-Session-Id: 0f6c…            # joins to telemetry
AI-Tool: copilot-cli@1.4.2      # or amp@…
AI-Turns: 12
AI-Model: <primary model>
```

This is cheap, durable, human-readable, greppable, and it anchors telemetry to the **git graph** — which your PR, release and incident systems already key off. It is the single highest-value instrumentation decision here.

Robustness notes: squash-merge and rebase can drop or merge trailers. Mitigate by *also* recording every commit SHA observed during a session in a side table, and reconciling post-merge via `git patch-id` and PR commit lists. Never depend on the trailer alone.

### 3.2 Be honest about attribution confidence

- **Diff → session** is *evidential* — high confidence, defensible in an audit.
- **Session → feature** is *inferential* — depends on how features are tracked.
- **Session → incident** is *statistical* — never a blame assignment for an individual change.

Carry an explicit confidence and evidence list on every attribution edge, exactly as the EIL relationship model does (explicit / deterministic-extracted / inferred, each with provenance). Never collapse the three into one number that looks authoritative.

### 3.3 Measure contribution, not credit

Avoid "AI wrote 40% of our code" — it is unfalsifiable and invites gaming. Measure instead:

- **Code survival rate** — fraction of AI-authored lines still present at 30/90 days, via periodic `git blame` snapshots. Code churned away is cost with no value. This is the best single quality signal available and it is nearly free to compute.
- **Rework rate** — commits modifying AI-authored lines within N days.
- **Revert / rollback rate** on AI-assisted PRs, cohorted against comparable human-only PRs.

## 4. Prompt and loop cost-effectiveness

The unit of analysis is the **loop**, not the prompt.

### 4.1 Waste detection — where the money actually goes

| Signal | What it catches |
|---|---|
| **Unproductive turns** — no file changed, no test run, no tool succeeded | Agent spinning |
| **Thrash signature** — same file edited 5+ times, same test failing 3+ times, same file re-read repeatedly | Context-management failure |
| **Context bloat** — input tokens growing superlinearly with turn count | The classic cost pathology |
| **Abandoned sessions** — session produced no commit at all | Usually a large, entirely unmeasured cost bucket |
| **Cache hit rate** (prompt-prefix caching) | Direct, large cost lever |
| **Cost concentration** — % of spend in the top 5% of sessions | Almost always extreme; targets optimisation effort |

Optimise the p95 tail, not the median. In every deployment of this kind the tail dominates the bill.

### 4.2 Comparing prompts requires cohorting

Cost per session is meaningless across mixed workloads. Without **task-class normalisation** you will conclude "team A's prompts are better" when team A simply does easier work. Cohort by task class (bugfix / feature / refactor / test / docs / incident) and a difficulty proxy (files touched, diff size, repo, blast radius) before comparing anything.

Then "prompt cost-effectiveness" becomes a proper experiment: **for a given task class, which prompt-template × model × config yields the highest accepted-outcome rate per dollar?** That implies versioned prompt templates and agent configs as first-class registry objects, with A/B assignment and results attributed back to the version. A dashboard alone cannot answer this question; an experiment framework can.

## 5. Measuring the memory system

Four independent axes. Most teams measure only the first and conclude memory is working.

| Axis | Question | How |
|---|---|---|
| **Retrieval quality** | Is the right memory surfaced? | Labelled replay set; precision@k, recall@k, MRR, nDCG. **Reuse the EIL ranking-regression gate** — that machinery already exists in the Enterprise Intelligence Layer project (https://github.com/ashark-ai-05/enterprise-intelligence-layer) |
| **Utilisation** | Is retrieved memory actually *used*? | Was it cited/referenced; did its presence change the output at all. Retrieved-and-ignored memory is pure cost |
| **Impact** | Does memory improve outcomes and reduce cost? | **Counterfactual ablation** — see below |
| **Health** | Is the store rotting? | Staleness, contradiction count, duplication, hot-topic coverage, ACL violations caught, growth vs utility, never-retrieved-in-90-days |

### 5.1 The ablation holdout is non-negotiable

Memory *increases* input tokens per turn while *decreasing* turn count. **The net cost effect is an empirical question, and many memory systems are net-negative while everyone assumes otherwise.**

The only defensible answer is a **permanent randomised holdout: run ~5% of eligible sessions with memory disabled**, cohorted by task class. Then report:

- **Net token delta per task attributable to memory** (the honest cost number)
- **Memory-attributable success lift** (Δ first-pass acceptance, Δ turns-to-completion, Δ rework rate)

Two things follow. First, this is cheap — 5% of sessions. Second, **it must be designed into the memory system from day one**; retrofitting a causal baseline onto a system already fully deployed is close to impossible, because you no longer have an uncontaminated comparison group.

Expected signature of a healthy memory system: *fewer turns, lower total tokens per completed task, higher first-pass acceptance* — despite higher tokens per individual turn.

## 6. Features and incidents

### 6.1 Prompts → shipped features

Attach outcome facts to the session long after it closes: PR merged, release tagged, feature flag enabled at 100%, ticket closed. Then report **cost per merged PR**, **cost per shipped feature**, **cost per closed ticket** — cohorted by task class, with the AI-assisted vs comparable-baseline delta.

### 6.2 Incidents — both directions

**Forward (is AI causing incidents?)** Join incident → implicated deploys/commits → AI attribution. Report **change failure rate** for AI-assisted vs comparable human-only changes.

**Backward (is AI good at resolving incidents?)** For incidents where an agent was engaged: time-to-mitigate, time-to-resolve, cost per incident, and — the sharpest quality signal available — **did the agent's proposed root cause match the final RCA?**

Handle with care. Incident attribution is politically explosive and statistically fragile: AI usage is not randomly assigned, so cohorts are confounded by task difficulty. **Recommendation:** pre-register the comparison method before anyone sees results, always publish confidence intervals, always cohort, and never produce a per-individual blame list.

### 6.3 Statistical power — say this out loud early

Lagging indicators (incident rate, change failure rate) need far more data than leading ones. At a few hundred sessions per week, incident-rate cohorts may take **months** to reach significance, while code survival, rework rate and turns-to-completion become meaningful in **weeks**. Lead with leading indicators; let the lagging ones accumulate quietly. Promising executives a change-failure-rate readout in month one is how these programmes lose credibility.

## 7. Architecture

This is a **warehouse-shaped problem, not an APM-shaped one.** Cost per feature, 30/90-day code survival, memory ablation cohorts and incident analysis are all analytics over historical data with late-arriving facts. OTel is the right *collection protocol*; a tracing UI is the wrong *centre of gravity*.

```
COLLECT
  Copilot CLI ──OTLP push──┐
  Amp API v2 ──poller pull─┤
  MaaS gateway ──emit──────┼──► OTel Collector / thin ingest ──► raw immutable event log
  Egress proxy ──logs──────┘                                         (append-only, audit)
  Git/CI/Jira/incidents ──(via EIL connectors)──────────────────────►

CONFORM
  normalise to OTel GenAI semantic conventions
  (gen_ai.system, gen_ai.request.model, gen_ai.usage.*)
  → session / turn / step / model_call / tool_call fact tables

ATTRIBUTE
  attribution graph: session ↔ commit ↔ PR ↔ release ↔ incident
  confidence + evidence on every edge; late-arriving outcome facts

ANALYSE
  cost marts · effectiveness marts · memory-ablation cohorts
  prompt/config experiment registry · policy & audit ledger

SURFACE
  exec cost & ROI · team dashboards · session inspector (replay)
  anomaly alerts · audit/eDiscovery export
```

Design rules:

1. **Adopt OTel GenAI semantic conventions rather than inventing a schema.** Vendor-neutral, and Copilot already emits into that ecosystem — you inherit future SDKs for free.
2. **Ship telemetry to the observability platform the enterprise already runs.** Building a parallel Prometheus/Grafana/ClickHouse/Jaeger stack is the classic overreach here and collides head-on with "no arbitrary software." **[VERIFY]** what is already approved and can ingest OTLP.
3. **Separate hot metadata from cold content.** Event volume is modest by observability standards — agent sessions are minutes, not millions per second. The scale problem is *content*: prompts and responses are enormous. Metadata and digests in the queryable store; bodies content-addressed in object storage, sampled, short TTL, access-audited.
4. **Design for late-arriving facts from day one.** A session ends today, its PR merges in 3 days, code survival is known at 30 days, incident linkage at 90. Facts are appended and marts rebuilt; every metric is labelled with its maturity window. This is the single most painful thing to retrofit.
5. **Guard cardinality.** Per-session × per-user × per-repo × per-model labels will kill a metrics backend. Events and logs are the source of truth; metrics are pre-aggregated and low-cardinality.
6. **No LLM in the hot path.** LLM-as-judge is expensive and should be offline, sampled, and used only for dimensions that cheap deterministic signals (tests, merges, human acceptance, survival) cannot cover.
7. **Budget the observability itself.** Target **under 2–3% of AI spend**. Ironically easy to breach via full prompt capture.

### 7.1 Scalability

Stateless collectors and workers; append-only log; partition by day and org unit; incremental mart rebuilds. Sampling policy: head-sample routine sessions, **tail-sample everything anomalous, failed, or expensive** — the interesting sessions are exactly the ones you must never drop.

## 8. Audit and governance

- **Immutable append-only ledger**: who (human identity + agent service principal), when, provider, model, data class, tools invoked, side effects, approvals, cost.
- **Access to captured prompt content is itself an audited event.** Content lives in a restricted enclave with short TTL and named approvers.
- **Policy compliance reporting**: unapproved model usage, data-class violations, shadow AI, entitlement/budget breaches.
- **Retention, legal hold, eDiscovery export** as first-class features, not afterthoughts.
- **Default content capture: OFF.** Metadata and digests everywhere; sampled full content only in explicitly-approved scopes. Copilot's enterprise settings let you enforce this centrally rather than trusting per-developer configuration ✅.

### 8.1 The adoption risk is real and is a data-quality risk

If developers experience this as surveillance, they will route around instrumentation, and the dataset becomes both incomplete and biased — which is worse than having no dataset, because it looks authoritative. **Recommendation: commit publicly and in writing to team-level aggregation, no individual performance measurement, and transparency about exactly what is captured.** This is a data-integrity decision that happens to also be an ethical one. Expect works-council or privacy review in some jurisdictions.

## 9. Sequencing

| Phase | Deliverable | Value |
|---|---|---|
| **0. Switch on + start archiving** (days) | Copilot enterprise OTel → collector; **Amp thread/usage poller writing to raw storage**; inventory approved obs platform | Step-level Copilot data for configuration effort only — and stops the irreversible 90-day bleed of Amp cost history |
| **1. Spend + shadow AI** (2–3 wks) | MaaS gateway metering, normalize the archived Amp data, proxy reconciliation, unified spend dashboard | Defensible cost numbers; shadow-AI detection — usually the finding that funds the programme |
| **2. Attribution spine** (2–4 wks) | Commit trailers, session↔commit↔PR graph, outcome joins via EIL connectors | Cost per merged PR; waste and thrash detection |
| **3. Effectiveness** (4–8 wks) | Task-class cohorting, code survival, rework, acceptance, prompt/config experiment registry | Which prompts and models are worth their cost |
| **4. Memory evaluation** | Ablation holdout, retrieval eval via EIL gate, memory health dashboard | The only defensible answer to "is memory worth it?" |
| **5. Incidents & assurance** | Incident joins, cohorted change-failure rate, audit/eDiscovery export | Executive and risk-committee reporting |

Phases 0–1 are mostly configuration and small services and deliver most of the early value. Phase 2 is the fork in the road: skip the commit trailer and phases 3–5 degrade into anecdote.

## 10. Top risks

| Risk | Severity | Mitigation |
|---|---|---|
| No join key from session to code → effectiveness is unmeasurable | **Critical** | Commit trailers + observed-SHA reconciliation, phase 2 |
| Amp cost history lost permanently at the 90-day API cliff while the design is still being debated | **Critical, and time-boxed** | Start the archiving poller in phase 0, ahead of any analytics work; measure and disclose the existing cold-start gap |
| Prompt content capture breaches privacy/DLP policy | **Severe** | Default off; digests; restricted enclave; centrally enforced via managed settings |
| Developers bypass instrumentation | High | Enterprise-managed settings devs can't override; proxy reconciliation; team-level-only reporting |
| Building a parallel observability stack | High | Emit to the already-approved platform; build only agent semantics |
| Cohort comparisons underpowered, conclusions overstated | High | Pre-registered methods, confidence intervals, lead with leading indicators |
| Memory value assumed rather than measured | High | Permanent 5% ablation holdout, designed in from day one |
| Observability cost rivals AI cost | Medium | <2–3% budget; sampling; hot/cold split |
| Attribution weaponised against individuals | Medium | Written commitment to team-level aggregation |

## 11. Clarifying questions — with recommendations

**Blocking**

1. **Which decision does this fund first — cost defensibility, developer-productivity ROI, risk/audit, or improving the agents themselves?**
   *Recommendation: start with audit + cost defensibility.* It is achievable in weeks from data you can already obtain, and it buys the runway for effectiveness work that needs a quarter to become statistically meaningful.

2. **Can you distribute a first-party git wrapper (or hook) to write commit trailers on developer machines and CI?**
   *Recommendation: treat this as the go/no-go for the whole effectiveness half.* "No arbitrary installs" normally governs third-party software; a first-party hook shipped through your existing config-management channel is a different conversation — but confirm it.

3. **Content-capture policy: may prompts/responses be stored at all, at what retention, and does this need works-council or privacy review?**
   *Recommendation: metadata + digests by default, sampled content in a restricted enclave.* Copilot's managed settings can enforce this centrally today ✅.

**Shapes the build**

4. **What observability/analytics platform is already approved — Datadog, Splunk, Elastic, Grafana, Dynatrace — and can it ingest OTLP? Is there a warehouse (Snowflake / Databricks / BigQuery) or is Postgres the analytical store?**
   *Recommendation: emit to what exists; build only the agent-specific semantic and attribution layer. Postgres is comfortable to ~10⁸ rows for these marts.*

5. **Copilot: which plan tier, and do you have enterprise-managed settings / MDM to push the telemetry block?**
   *Recommendation: verify which signals and attributes actually arrive in your tenant before designing dashboards on assumed fields.*

6. **Amp: which tier, do you have workspace-admin access and an API key for `/api/v2`, and are you using workspace `model-provider-keys` (BYO) or Amp's own billing?**
   *Recommendation: if BYO keys are available, route Amp's model traffic through your gateway — it converts Amp from partly-opaque to fully instrumented.*

7. **Do MaaS calls go through a gateway you control, or direct from clients?**
   *Recommendation: if direct, inserting a thin gateway is the highest-value single change on the MaaS side, and it doubles as the budget/policy enforcement point.*

8. **Are the outcome-side systems reachable — git host API, CI, Jira, incident tool (PagerDuty/ServiceNow), deploy/release records?**
   *Recommendation: reuse the EIL connectors rather than building new ones; Confluence/Jira/git ingestion already exists in the Enterprise Intelligence Layer project (https://github.com/ashark-ai-05/enterprise-intelligence-layer).*

**Sizing and scope**

9. **Which memory system are we measuring — does one exist today, or is this the procedural/L4 memory from the platform design?**
   *Recommendation: don't build memory evaluation before the memory exists — but build the 5% ablation holdout into the memory system on day one.*

10. **Scale baseline: how many developers, sessions per day, and current monthly AI spend? Scope — laptops only, or CI and production agents too?**
    *Sizes storage and sampling, and tells us honestly whether effectiveness cohorts can reach significance in the timeframe you need.*

11. **Will this ever be used for individual performance measurement?**
    *Recommendation: commit publicly to "no." If developers believe otherwise, they bypass instrumentation and the dataset becomes biased — which is worse than no dataset, because it still looks authoritative.*

---

## Sources

- [Enterprise-managed OpenTelemetry export for VS Code and CLI — GitHub Changelog, 2026-07-08](https://github.blog/changelog/2026-07-08-enterprise-managed-opentelemetry-export-for-vs-code-and-cli/)
- [OpenTelemetry instrumentation for Copilot SDK — GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/observability/opentelemetry)
- [Set up OpenTelemetry for GitHub Copilot — Amazon CloudWatch docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/coding-agents-copilot.html)
- [copilot-cli#1911 — Export traces, metrics and events via OTel](https://github.com/github/copilot-cli/issues/1911)
- [copilot-cli#2471 — OTel telemetry support for Copilot CLI](https://github.com/github/copilot-cli/issues/2471)
- [Amp External API v2 OpenAPI schema](https://ampcode.com/api/v2/openapi.json)
- [Amp Owner's Manual](https://ampcode.com/manual)
- [Enterprise Intelligence Layer — prior art from the same operator](https://github.com/ashark-ai-05/enterprise-intelligence-layer)
- Local: `docs/CONTEXT_COLLABORATION_PLATFORM.md` (prior design; the gateway/broker is shared with this system)

*Design only. No implementation until approved.*
