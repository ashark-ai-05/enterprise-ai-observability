---
title: "Enterprise Buzz — Architecture Design (Opus)"
tags: [multi-agent, enterprise, architecture, cost-control, memory, llm-routing]
status: draft
created: 2026-08-12
---

# Enterprise Buzz — Design Proposal

Design-only. No implementation until the operator approves. Assumptions that need verification are marked **[VERIFY]**.

Origin: multi-agent design session, 2026-08-12. Published for human review.

Goal: a Buzz-like human+agent collaboration platform for enterprise — behind a corporate proxy, model access via Amp (ampcode.com) SDK, Copilot SDK, and internal models-as-a-service (MaaS) endpoints; no arbitrary software installs; low cost; agents that collaborate to raise quality; a memory system that improves over time; scalable.

---

## 1. Framing: what is actually being built

Buzz is three separable things. Enterprise needs them at different priorities.

| Plane | Buzz today | Enterprise priority |
|---|---|---|
| **Collaboration plane** — channels, mentions, threads, canvas | Nostr relay + desktop client | Medium — can ride an existing approved surface |
| **Orchestration plane** — agent harness, task routing, tool use | Per-agent CLI sessions | **Highest** — this is the differentiated value |
| **Knowledge plane** — memory, retrieval, provenance | Workspace files + agent memory | **Highest**, and already half-built (EIL) |

The mistake to avoid is building the chat app first. The chat app has the worst approval-effort-to-value ratio of the three, and the collaboration/memory value is realizable through a surface the enterprise already trusts.

## 2. Critical angle: drop Nostr the network, keep Nostr the shape

Nostr's value props — decentralization, censorship resistance, user-held keys — are neutral-to-negative in an enterprise. Enterprise wants central audit, SSO, DLP, retention, legal hold and eDiscovery. User-held secp256k1 keys actively fight corporate IAM.

But one property is genuinely worth keeping: **a signed, append-only, attributable event log**. That is exactly the substrate you want for agent accountability, replay, and cost attribution.

**Recommendation:** keep the event-sourced signed-log model; drop public relays and self-custodied human keys.

- Humans authenticate via enterprise OIDC/SAML. Human identity = IdP subject.
- Each agent gets a **platform-issued keypair bound to a service principal**, so every agent action is cryptographically attributable and non-repudiable — which is a real audit win over "the bot did it."
- Agents act **on behalf of** a human with attenuated, time-boxed, delegated permissions. No agent ever holds standing broad rights.
- Transport is whatever is approved (WebSocket/SSE over the existing API gateway, backed by Postgres `LISTEN/NOTIFY`). Nostr-over-the-wire is optional, not load-bearing.

## 3. Build-vs-adopt: three options

**Option A — Fork open-source Buzz** (github.com/block/buzz). Replace relay auth with enterprise IdP, keep the protocol and desktop client.
*Pro:* fastest to a working artifact; client, relay and agent harness for free.
*Con:* inherits Nostr key management, a desktop-app distribution problem, and a full third-party dependency tree that must clear software-composition approval. Under "no arbitrary installs" that tree is the risk, not the code.

**Option B — Build the collaboration plane fresh** on approved Node/Python + Postgres, borrowing Buzz's *concepts* (channels, mentions, threads, canvas, event log, agent harness).
*Pro:* clean approval story, exact fit for enterprise controls, minimal dependency surface.
*Con:* slowest to first demo; you rebuild a client.

**Option C — Headless first.** Build only the orchestration + broker + memory backend. Surface it through the collaboration tool already approved (Teams/Slack/Mattermost) via a bot, or through the existing MCP/CLI surfaces.
*Pro:* no new client to approve, no adoption friction, fastest path to measuring cost-per-task and memory value.
*Con:* constrained by the host tool's API; you lose canvas fidelity and some event-log richness.

**Recommendation: C, then B.** Ship headless, prove the economics and the memory loop on a real workload, then build the dedicated client once the backend has earned it. Option A is a reasonable accelerator *only* if the software-approval process will pass a forked OSS Electron app — which is exactly the kind of thing it usually won't.

## 4. Architecture

Modular monolith + stateless workers. One approved runtime, one approved database, one object store. Nothing else.

```
┌──────────────────────────────────────────────────────────────┐
│ Surface: approved chat tool bot  /  MCP server  /  later: web │
└───────────────────────────┬──────────────────────────────────┘
                            │  (signed events)
┌───────────────────────────▼──────────────────────────────────┐
│ COLLABORATION PLANE                                          │
│  channels · threads · mentions · canvas · presence           │
│  append-only signed event log (Postgres, partitioned)        │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ ORCHESTRATION PLANE                                          │
│  Task Graph  ·  Durable agent runs (checkpointed FSM)        │
│  Collaboration Protocols (§6)  ·  Policy & approval gates    │
│  Queue: Postgres SKIP LOCKED   ·  Fair-share scheduler       │
└──────────┬──────────────────────────────┬────────────────────┘
           │                              │
┌──────────▼───────────────┐  ┌───────────▼────────────────────┐
│ MODEL BROKER (§5)        │  │ KNOWLEDGE PLANE (§7)           │
│  capability registry     │  │  L1 working · L2 episodic      │
│  cost-aware router       │  │  L3 semantic (EIL) · L4 proc.  │
│  budget enforcement      │  │  L5 preference                 │
│  data-class → provider   │  │  offline distiller + eval gate │
│  allowlist · cache       │  │  per-memory ACL, default deny  │
│  rate governors          │  └───────────┬────────────────────┘
└──────────┬───────────────┘              │
           │                    ┌─────────▼──────────┐
   ┌───────┴────────┐           │ Enterprise         │
   │ Amp SDK        │           │ Intelligence Layer │
   │ Copilot SDK    │           │ (existing: Conflu- │
   │ MaaS endpoints │           │ ence/Jira/git,     │
   └────────────────┘           │ ACL, RRF search)   │
                                └────────────────────┘
```

**Everything on Postgres, deliberately.** Event log, durable queue (`FOR UPDATE SKIP LOCKED`), catalog, ACL, budgets, audit, lexical search (`tsvector`/`pg_trgm`), and vectors (pgvector if approved; otherwise brute-force cosine over ACL-filtered candidate sets, which is fine to ~10⁵ chunks). This mirrors the profile split already established in EIL (`local` PGlite / `hosted` Postgres behind identical schema and query contracts) and inherits its migration story. Defer Kafka, Redis, and a dedicated vector DB until measurements demand them — the same call the EIL review already made.

## 5. Model Broker — the cost control point

Three providers with three fundamentally different cost shapes. This is the design's biggest lever and its biggest unknown.

| Provider | Shape | Cost model **[VERIFY]** | Best use |
|---|---|---|---|
| **Amp SDK** | Full agent — runs its own tool loop and subagents | Per-thread / metered; you do **not** control its internal token spend | Whole-task delegation where its agentic loop earns its keep |
| **Copilot SDK** | Assistant/agent, likely seat-licensed | Fixed per seat → **marginal cost ≈ 0 within quota** | High-volume, low-risk bulk work |
| **MaaS endpoints** | Raw chat/embedding models | Per-token, fully controlled | Verification, structured output, embeddings, adjudication |

**Route by task class × cost shape, not by "which model is best."** A fixed-cost provider with spare quota beats a marginally-better metered model for most work.

The broker owns:

1. **Capability registry** — per provider: context window, tool-calling, structured output, streaming, embeddings, latency, rate limits, cost shape, data-residency class. Routing reads this; application code never names a model.
2. **Budgets, hard-enforced** — org → team → channel → thread → task → single turn. The broker *refuses* when exhausted; it does not ask the model to be frugal. Exceeding requires explicit human approval, logged.
3. **Data-classification → provider allowlist.** Amp and Copilot are external SaaS; MaaS may be internal. Restricted data classes must be mechanically incapable of reaching an external provider. This is a routing constraint, not a policy document.
4. **Response cache** — keyed on `(normalized task fingerprint, model, memory generation, ACL scope)`. Enterprise work is extremely repetitive; the same question arrives from five teams. **This is likely the single largest cost saver in the system.** Cache must be ACL-aware: never serve a cached answer derived from documents the caller cannot see.
5. **Prompt-prefix stability** for provider-side caching — system prompt and memory block must be byte-stable and append-only within a session. Reordering the memory block on every turn silently destroys cache hits and is a common self-inflicted cost bug.
6. **Rate governors and fair-share scheduling** so one team cannot starve others, plus provider-outage failover.
7. **Anomaly kill-switch** — a looping agent is the classic enterprise cost incident. Detect spend velocity, repeated near-identical calls, and unbounded tool loops; halt and page.

## 6. Multi-agent collaboration — where it pays, and where it burns money

The request "get agents to collaborate and discuss" and the request "keep costs low" are in direct tension, and the naive version loses. Free-form agent discussion is N agents × M rounds × growing transcript — superlinear token growth. Worse, debate frequently converges on consensus *without* improving accuracy: agents anchor on the first proposal and agree.

**Design principle: structured protocols, not conversations. Escalation ladder, not a round table.**

```
  Tier 0  Cache / deterministic tool          cost ~0
  Tier 1  Single cheap agent (seat-licensed)  ← default path, ~80% of tasks
            │ emits: answer + confidence + evidence
            ▼ escalate only on trigger
  Tier 2  Independent critic — DIFFERENT provider, artifact-only input
            │ agrees → ship
            ▼ disagrees
  Tier 3  Adjudicator (strong metered model), sees both artifacts + evidence
            │ still unresolved, or blast radius high
            ▼
  Tier 4  Human review
```

Rules that keep this cheap and honest:

- **Escalation is triggered, not default.** Triggers: low self-reported confidence, high blast radius (writes, prod, money, external comms), detected disagreement, policy-flagged domain, novel task with no procedural memory hit.
- **Provider diversity is the entire point of the critic.** Two agents on the same model with the same prompt produce *correlated* errors — you pay twice for the same blind spot. Route the critic to a different provider deliberately.
- **Artifact exchange, not transcript passing.** Agents exchange a diff, spec, test result, or claim-with-evidence — never their whole context. This is what keeps cost linear.
- **Hard round cap (2).** No open-ended loops.
- **Prefer grounded verification over debate.** If you can run the test, execute the query, or open the cited doc, do that instead of asking another model. Cheaper *and* more reliable.
- **Asymmetric roles beat symmetric ones.** Proposer/critic/adjudicator with different prompts, different providers, and different information beats N identical agents brainstorming.

**Measure it or it's theatre.** From day one instrument: **cost per resolved task**, and **escalation precision** — of tasks escalated past Tier 1, what fraction actually changed the outcome? If escalation rarely changes outcomes, the ladder is miscalibrated and is pure cost. This metric should drive the escalation thresholds automatically.

## 7. Memory that actually improves

Most "self-improving memory" designs degrade instead. The failure modes are predictable: unbounded growth, accumulated contradictions, confidently-asserted stale facts, poisoning (one wrong conclusion memorized and then cited forever), and — the enterprise-fatal one — ACL leakage through distillation.

### Five tiers

| Tier | Contents | Lifetime | Written by |
|---|---|---|---|
| **L1 Working** | current thread context | task | runtime |
| **L2 Episodic** | signed event log — every message, tool call, decision, outcome | permanent, immutable | append-only, system |
| **L3 Semantic** | facts and documents with provenance | source-driven | **EIL** (Confluence/Jira/code) |
| **L4 Procedural** | *how we do things here* — playbooks, task recipes, tool patterns, known pitfalls | decaying, promoted | **offline distiller** |
| **L5 Preference** | team/person conventions, style, review standards | long, revisable | distiller + human |

L4 is where "keeps improving" lives. L2 is the ground truth everything else derives from — and the reason a signed event log was worth keeping from Nostr.

### The learning loop, made safe

1. **Distillation is offline and outcome-labelled.** A nightly job reads *completed* tasks from the event log with a known outcome signal — PR merged, ticket closed, human accepted or rejected, test passed. Never "the agent thought that went well." Self-reported success is the primary corruption vector.
2. **Every memory is a typed record**, not a blob of text: `claim · provenance (event IDs) · confidence · scope (who/where it applies) · ACL · validity window · usage count · outcome correlation`.
3. **Promotion by evidence, not assertion.** A candidate memory stays *observed* until it has been retrieved and correlated with successful outcomes N times, or a human endorses it. Only *endorsed* and *corroborated* memories enter default context. This one rule prevents most poisoning.
4. **Negative memory is high-ROI.** "We tried X, it failed because Y" prevents repeated expensive dead ends. Capture failures at least as eagerly as successes.
5. **Decay and contradiction handling.** TTL by type (org policy: long; "main is broken": hours). Newer + more specific supersedes older + more general. Contradictions are surfaced for human resolution, never silently merged.
6. **A frozen replay-set eval gate.** Past tasks with known-good outcomes; any memory change must not regress retrieval quality or task success. This is what makes "improving" measurable rather than aspirational — and it's the same mechanism as the ranking-regression gate already built in the EIL repo.
7. **ACL per memory, enforced at retrieval, default-deny.** A memory distilled from a restricted source *inherits that restriction*. Two hard rules, both from the EIL review: a memory never becomes an authorization grant, and a summary of restricted content is still restricted content.
8. **Memory writes are never triggerable by untrusted content.** Prompt injection → memory poisoning → persistent cross-user compromise is the nastiest attack this architecture has. Retrieved and user-supplied text is *data*, delimited and provenance-tagged; only the offline distiller writes memory.

**Do not build L3 from scratch.** The Enterprise Intelligence Layer in the Enterprise Intelligence Layer project (https://github.com/ashark-ai-05/enterprise-intelligence-layer) already provides ingestion, ACL-by-reference, federated retrieval with RRF, provenance and citations, all behind the corporate proxy. Enterprise Buzz should be its **top consumer**, not its competitor. Concretely: EIL is the knowledge plane; Buzz adds L4/L5 on the same schema and serves both through EIL's governed retrieval API.

## 8. Scalability

- **Stateless workers + Postgres durable queue.** Scale by adding processes. Modular monolith until measurement says otherwise.
- **Agent runs are durable, checkpointed state machines** — persist after every tool call and model call. A worker can die mid-task and another resumes. Long-running agent work and HTTP request lifetimes must not be coupled.
- **Partition the event log by channel**; hot channels get worker affinity for cache locality.
- **The real ceiling is provider rate limits and human review capacity, not compute.** Design backpressure, queue-depth visibility and fair-share around *those*. Autoscaling workers into a rate limit just converts money into 429s.
- **Multi-tenancy from day one**, even for a single-org pilot — team-level isolation of budgets, memory scope and ACLs is much harder to retrofit than to start with.

## 9. Proxy / no-install constraints — plan for these explicitly

- **Egress allowlist** for `ampcode.com`, Copilot endpoints, MaaS hosts. Confirm each is approved before design lock.
- **TLS interception**: SDKs must honor the corporate CA bundle and proxy env vars. Node needs `NODE_EXTRA_CA_CERTS` and proxy-aware fetch — the workspace has already hit exactly this (ADR-0009 / `NODE_USE_ENV_PROXY`). Verify **each SDK** independently; agent SDKs frequently bypass proxy config in their internal HTTP clients.
- **No inbound webhooks** from external SaaS. Assume polling; design connectors accordingly.
- **Internal package registry mirror** — dependency provenance and software-composition approval will gate the dependency tree. Prefer few, boring, well-known dependencies. Every added package is an approval ticket.
- **Zero-install verification probe** — a script that checks proxy reachability, CA trust, registry access, and each provider endpoint before anyone writes feature code. EIL already has this pattern; reuse it.

## 10. Recommended sequencing

| Phase | Deliverable | Proves |
|---|---|---|
| **0. Probe** (days) | Connectivity/CA/registry/provider probe; measure real cost + latency + rate limits per provider; confirm SDK terms allow programmatic use | The constraints are what we think they are |
| **1. Broker** | Model broker with capability registry, budgets, data-class routing, response cache. No agents yet | Cost control works before spend scales |
| **2. Single agent, headless** | One agent on the approved chat surface, backed by EIL retrieval, on one real workload | Cost per resolved task, baseline quality |
| **3. Memory L4/L5 + eval gate** | Offline distiller, typed memories, promotion rules, frozen replay set | "Improving" is measurable, not asserted |
| **4. Collaboration ladder** | Tier 1–3 protocol with provider-diverse critic | Escalation precision > 0; quality gain per dollar |
| **5. Native client** | Dedicated collaboration plane (Option B) | Only if 2–4 earned it |

Do not start at phase 5. The most common failure mode for this class of project is building a beautiful chat app and discovering the economics don't work.

## 11. Top risks

| Risk | Severity | Mitigation |
|---|---|---|
| Copilot/Amp terms forbid programmatic or shared-service agent use, or seats are strictly per-human | **Blocking** | Verify in phase 0 before any design lock |
| Memory poisoning via prompt injection | **Severe** | Offline-only writes, promotion gate, untrusted-text delimiting |
| Memory ACL leakage through distillation | **Severe** | Inherit source ACL; default-deny at retrieval; summaries stay restricted |
| Runaway agent cost incident | High | Hard broker budgets, spend-velocity anomaly detection, kill switch |
| Multi-agent debate adds cost without quality | High | Escalation precision metric drives thresholds; provider-diverse critics |
| Rebuilding EIL's retrieval instead of reusing it | High | Explicit consumer relationship; shared schema |
| Dependency approval stalls the project | Medium | Minimal boring dependency set; probe registry in phase 0 |

## 12. Open questions for the operator

Grouped by how much they change the design.

**Blocking — the design branches on these**

1. **First real workload?** Engineering task automation, support/ticket triage, ops runbooks, or document Q&A? This determines memory schema, evaluation set, and whether escalation is even worth building.
2. **Provider terms and cost shapes.** Are Copilot/Amp seat-licensed or metered? Are seats per-human, and do their terms permit programmatic use by a shared service on behalf of others? MaaS $/1M tokens in and out?
3. **Data classification boundary.** What is the most sensitive class permitted to reach Amp/Copilot (external SaaS) versus internal-MaaS-only? Any residency, retention, or no-training constraints?

**Shapes the build**

4. **Approved surface.** Is there an existing approved chat tool (Teams/Slack/Mattermost) to ride on — and would a fork of open-source Buzz realistically clear your software-approval process?
5. **Approved infrastructure.** Postgres version and permitted extensions (pgvector? pg_trgm?), object storage, container runtime, deployment target, Node or Python.
6. **MaaS capabilities.** Do the MaaS endpoints include an **embedding** model? Does anything there support tool/function calling and structured output? Without embeddings, retrieval is lexical-only; without tool calling, orchestration must be externally driven.

**Sizes it**

7. **Scale and budget.** How many humans, expected concurrent agent tasks, and a monthly cost ceiling? "Low cost" needs a number before the escalation ladder can be tuned.
8. **Relationship to EIL.** Should Enterprise Buzz consume the existing Enterprise Intelligence Layer as its knowledge plane (strongly recommended), or is that a separate track?

---

*Design only. No implementation until approved.*
