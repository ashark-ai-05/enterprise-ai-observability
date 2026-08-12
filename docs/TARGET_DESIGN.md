---
title: "Enterprise AI Effectiveness Observatory Target Design"
tags: [ai-observability, enterprise, cost-attribution, memory-evaluation, audit]
status: draft
created: 2026-08-12
---

# Enterprise AI Effectiveness Observatory

Design baseline selected after a multi-agent design discussion, 2026-08-12.

This is a design artifact only. Do not implement without explicit approval.

## Product decision

Build an observability, attribution, and governance layer around existing Copilot CLI, Amp CLI, harnesses, and MaaS APIs. Do not build a new agent runtime in the first product.

The platform optimizes for four questions:

1. Is enterprise AI usage authorized and auditable?
2. What does it cost per accepted outcome?
3. Which prompt, model, loop, and memory policies improve outcomes per dollar?
4. Where are agents failing, looping, or creating downstream risk?

The unit of value is a verified outcome, not a token, prompt, session, or line of code.

## Selected enterprise defaults

- Platform Engineering owns the service; Security and Privacy own capture policy; teams see their own optimization data.
- Never use the product for individual performance ranking. Executive views aggregate at team/workflow level and suppress small cohorts.
- Metadata capture is mandatory where approved; prompt, response, terminal, tool-argument, source-code, and memory bodies are off by default.
- Sensitive payload capture is opt-in, encrypted separately, short-lived, reveal-audited, and controlled per team/data class.
- Use vendor-supported and centrally managed telemetry. Do not intercept TLS or scrape terminal screens.
- Reuse approved enterprise infrastructure and observability systems. The product owns agent semantics and attribution, not a duplicate monitoring stack.
- PostgreSQL is the initial authority for configuration, identities, outcomes, attribution, policies, audit metadata, and job coordination.
- Approved object storage holds immutable raw receipts and encrypted large payloads.
- External systems of record determine completion; an agent cannot mark its own work successful.
- Begin with audit and cost defensibility, then outcome attribution, prompt/loop optimization, memory evaluation, and incident analytics.

## Logical architecture

```text
Copilot managed OTLP ─┐
Amp workspace API ────┤
Harness event SDK ────┼─> authenticated ingestion boundary
MaaS gateway ─────────┤          |
Egress proxy logs ────┘          v
                            validate + redact
                                  |
                  immutable raw receipts / payload vault
                                  |
                       conform + enrich workers
                                  |
        Postgres control/event facts + analytical projections
                    |                         |
        outcome-system connectors       evaluation workers
      git/PR/CI/deploy/ticket/incident   prompts/memory/loops
                    \                         /
                     attribution and metrics API
                                  |
       live runs | outcomes | memory lab | experiments | audit
```

Deploy initially as a modular monolith with separate stateless process roles: API/UI, ingestion, connector workers, enrichment/evaluation workers, and scheduled aggregation. They share contracts but can scale independently.

## Collection policy

### Copilot

Use enterprise-managed OpenTelemetry export to an approved collector. Verify the exact event and attribute coverage in the enterprise's licensed versions before depending on it. Enforce content capture centrally according to policy.

### Amp

Use the central workspace API poller for threads, identity metadata, and usage/cost. Persist raw usage promptly because the vendor API has a reported 90-day availability boundary that must be verified against the contracted service. Add an approved plugin only if step-level tool events are necessary and not available centrally.

### MaaS

Place a thin enterprise gateway in front of direct model APIs where architecture permits. It authenticates, attaches enterprise context, meters, records policy decisions, and forwards. It contains no agent logic.

### Coverage

Reconcile provider/gateway telemetry against enterprise egress-proxy records. Report observable, partially observable, and unattributed traffic explicitly. Missing telemetry is never interpreted as zero activity.

## Canonical entities

- `Tenant`, `Team`, `Principal`, `DataPolicy`
- `Provider`, `Model`, `Harness`, `AgentConfig`, `PromptVersion`, `MemoryPolicyVersion`
- `Outcome`, `OutcomeType`, `OutcomeState`, `Attempt`
- `Run`, `Trace`, `Span`, `Loop`, `ModelCall`, `ToolCall`, `Approval`
- `PromptAssembly`, `ContextItem`, `MemoryItemVersion`, `MemoryRetrieval`
- `Artifact`, `Commit`, `PullRequest`, `Build`, `Deployment`, `Incident`
- `AttributionEdge`, `Evaluation`, `Experiment`, `CohortAssignment`
- `UsageFact`, `CostRateVersion`, `PolicyDecision`, `AuditReceipt`, `CoverageFact`

Every event includes tenant, source, schema version, event time, received time, stable source ID, idempotency key, sequence when available, capture policy, redaction state, and producer version. Provider-specific fields survive in a namespaced envelope.

## Outcome state machines

### Feature

`requested → attempted → artifact_created → checks_passed → approved → merged → deployed → retained | reverted`

### Incident analysis

`engaged → evidence_collected → hypothesis_proposed → mitigation_proposed → mitigated → resolved → validated | recurred`

### General analysis

`requested → delivered → accepted | rework_requested → decision_recorded | no_action`

Each transition has evidence, source, timestamp, maturity window, and confidence. The platform distinguishes AI assistance from ownership and supports multiple human/agent attempts per outcome.

## Attribution spine

Preferred chain:

`run → observed file changes → commit → PR → merge → build → deployment → feature/incident`

Where enterprise policy permits, a first-party harness or approved git integration writes an `AI-Session-Id` reference into commit/PR metadata. It also records observed commit SHAs. Squash/rebase reconciliation uses PR commit lists and patch identity. If endpoint changes are prohibited, use server-side PR/CI metadata and mark attribution confidence lower.

Every `AttributionEdge` contains:

- relationship type and direction
- explicit, deterministic, or inferred classification
- source evidence and version
- confidence and explanation
- valid-from/valid-to and supersession

Inferred relationships never become authorization decisions or individual blame.

## Effectiveness scorecard

Do not publish a single productivity score. Publish five independent dimensions:

1. **Cost:** cost per accepted outcome, cost to first useful artifact, p50/p95 run cost.
2. **Quality:** first-pass acceptance, rework, test/review outcome, code survival, revert, recurrence.
3. **Speed:** time to useful artifact, merge/deploy, hypothesis, mitigation, and resolution.
4. **Efficiency:** productive-step ratio, retries, repeated calls, context growth, abandoned runs.
5. **Risk/confidence:** policy failures, excessive access, telemetry coverage, attribution confidence, metric maturity.

All comparisons are cohort-based by task class and difficulty proxy. Results show sample size, confidence interval, capture coverage, and maturity window.

## Prompt and loop evaluation

A prompt is the complete versioned assembly: system/developer/user instructions, template/config versions, tool definitions, model parameters, context and memory references, and data policy.

Operational analysis identifies repeated-equivalent calls, no-new-evidence cycles, oscillation, unchanged-input retries, repeated test/tool failures, approval waits, and context growth without outcome progress.

Observational comparisons are labeled correlational. Promotion decisions require a frozen regression corpus plus an approved experiment, phased rollout, or matched cohort. Incident workflows use offline/shadow evaluation rather than live randomized behavior until governance approves otherwise.

## Memory evaluation

Keep two evaluation systems separate:

1. **Retrieval quality:** labeled relevance judgments, precision/recall, MRR/nDCG, freshness, citation correctness, ACL failures, contradiction and duplication.
2. **Behavioral impact:** whether an agent applied memory correctly and whether outcomes, total tokens, turns, rework, or acceptance improved.

Instrument `candidate → validated → stored → retrieved → included → used/cited → outcome → superseded/expired/deleted`.

For eligible low-risk workflows, assign a permanent small memory-off holdout, initially 5%, subject to privacy/product approval and statistical review. This measures marginal outcome lift and net cost. Do not use ablation for incident response or cases where removing required knowledge creates material risk.

## Storage and scalability

- Append raw receipts before processing; derived facts are reproducible and versioned.
- Partition high-volume events by tenant and time.
- Store metadata/digests hot; put encrypted large bodies in object storage with independent TTL and keys.
- Handle late and out-of-order facts: runs close now, PRs merge later, deployments and incidents arrive later still.
- Precompute low-cardinality team/workflow aggregates; do not place session/user/repo IDs into metrics labels.
- Use idempotent workers, leases/fencing, retries, reconciliation, dead-letter state, backpressure, and tenant quotas.
- Head-sample routine sensitive payloads; always retain metadata and tail-sample payloads for approved anomalous/failed/expensive runs.
- Keep observability operating cost below 3% of measured AI spend as a design target, revisited after the pilot.
- Add a broker, columnar warehouse, or search service only after measured Postgres/object-store bottlenecks or enterprise standards require it.

## Security and governance

- SSO, group sync, service identities, least privilege, and purpose-based roles.
- Source-side redaction where possible; payload classification before persistence.
- Separate encryption keys and access paths for content payloads.
- All payload reveals and exports are auditable.
- Retention, deletion, legal hold, and eDiscovery policies apply to raw and derived data.
- Signed/authenticated collectors, replay protection, rate limits, rotation, and kill switches.
- No hidden chain-of-thought storage. Store observable calls/actions, artifacts, evidence, and concise decision summaries.
- Publish a capture manifest to employees and prohibit individual performance ranking in policy and product design.

## Product surfaces

- **Outcome portfolio:** spend, accepted outcomes, speed, quality, risk, confidence, maturity.
- **Run explorer:** trace/loop waterfall, cost accumulation, tools, approvals, memory, failures.
- **Optimization:** prompt/model/config cohorts, cost-quality frontier, regressions, waste clusters.
- **Memory lab:** retrieval tests, health, provenance, ACL, usefulness, experiments.
- **Audit:** who used which capability, access/mutations, approvals, policy, cost, evidence, gaps.
- **Coverage and shadow AI:** instrumented versus observed egress by approved provider/team.
- **Experiment registry:** hypothesis, assignment, versions, guardrails, results, approval and rollback.

## Delivery plan after explicit implementation approval

### Phase 0: validate and preserve

- Confirm approved infrastructure, identity, privacy, licensing, and exact telemetry surfaces.
- Validate Copilot managed OTLP fields on a small approved cohort.
- Validate Amp API credentials, pagination, rate limits, and usage retention; archive raw usage promptly if approved.
- Inventory outcome systems and choose one feature and one incident workflow.
- Measure current volume, data classifications, and historical gaps.

### Phase 1: trustworthy cost and audit

- Normalize Copilot, Amp, and one MaaS path.
- Cost ledger with versioned price/capacity model.
- Run explorer, audit export, telemetry coverage, and shadow-AI reconciliation.
- Metadata-only by default.

### Phase 2: outcome attribution

- One git/PR/CI/deployment connector and one ticket/incident connector.
- Attribution graph and confidence model.
- Cost/time to accepted outcome; abandoned and rework funnels.

### Phase 3: prompt and loop optimization

- Prompt/config registry, regression corpus, cohort comparisons, experiment registry.
- Loop/thrash/high-cost detectors and recommendation-only alerts.

### Phase 4: memory value

- Retrieval and behavior eval harnesses, health dashboard, approved ablation cohorts.

### Phase 5: assurance and scale

- Incident maturity analysis, legal hold/eDiscovery, expanded connectors, store scaling driven by evidence.

## Pilot success gates

The pilot advances only if it demonstrates:

- at least 90% metadata attribution coverage for the selected paths, or a documented remediation plan
- reproducible provider-reported and internally calculated costs
- outcome linkage with explicit evidence/confidence
- useful cost-per-outcome, time-to-outcome, and rework/recurrence views
- no high-severity cross-team access or payload-retention violations
- observability operating cost below the agreed threshold
- team/user review confirming the system is useful and not an individual surveillance tool

## Explicit deferrals

- autonomous blocking or termination of runs
- individual productivity scoring
- full prompt/completion capture by default
- LLM judge as the primary source of truth
- automated enterprise-memory promotion
- dedicated graph/vector/streaming infrastructure without measured need
- building a new collaborative agent runtime

## Immediate decision

No implementation is authorized. If authorization is later given, Phase 0 is the first scope. The only time-sensitive risk to evaluate immediately is whether Amp usage facts expire from the vendor API; approval to inspect or archive that data must be explicit because it changes external and internal state.
