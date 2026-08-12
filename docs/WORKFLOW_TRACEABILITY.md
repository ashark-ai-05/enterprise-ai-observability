# End-to-end workflow traceability

## Completion contract

The observatory traces work from an externally observable inception to an externally verifiable
artifact and accepted outcome. A prompt, response, or agent declaration is never completion.

```text
inception → attempt(s) → cross-layer activity/evidence → artifact → verification → outcome
```

`reconstructWorkflowTrace()` calls a trace complete only when all events belong to one workflow,
step IDs are unique, links resolve, the graph is acyclic, every non-inception step reaches inception,
a verification reaches an artifact, and a successful outcome reaches both artifact and verification.
This rejects activity-only traces, untested commits, disconnected artifacts, and ungrounded reports.

## Portable correlation

Every participating event may carry a `workflow` envelope:

| Field | Purpose |
|---|---|
| `workflowId` | Stable business request or investigation identity |
| `workflowType` | Tenant-defined class, such as `feature_delivery` |
| `attemptId` | Separates retries, parallel agents, and handoffs |
| `stepId` | Stable logical step identity, not a receipt UUID |
| `stage` | Tenant-defined lifecycle state |
| `layer` | EIL, CLI, LLM, index, tool, MCP, VCS, CI, etc. |
| `role` | inception, activity, evidence, artifact, verification, or outcome |
| `links` | Auditable causal links from the current step to earlier prerequisite/evidence steps |

A link records source/target, relation, deterministic versus evidence method, raw score, confidence,
calibration status, ambiguity count, resolver version, and machine-readable evidence. Deterministic
propagation has confidence 1. Evidence confidence must disclose whether it is calibrated.

The envelope remains metadata-only. Prompts, logs, code, and report contents do not belong in link
evidence; use IDs, hashes, counts, classifications, and references to a protected payload store.

## Propagation across the stack

Use W3C `traceparent` for technical spans and opaque business-correlation headers/baggage:

```text
x-ai-workflow-id
x-ai-workflow-type
x-ai-attempt-id
x-ai-step-id
```

Never put Jira prose, customer names, prompts, or errors in trace headers.

| Boundary | Instrumentation and required metadata |
|---|---|
| Jira/ADO/ServiceNow → orchestrator | Connector creates workflow/inception; record item ID/version, actor, status |
| Orchestrator → EIL | Context + SDK wrapper; retrieval IDs, corpus/index version, latency |
| EIL → index | Propagated context; query span, result IDs/ranks, cache state |
| Orchestrator → CLI/harness | Supported hook/config; run/handoff, version, repo/worktree |
| Harness/gateway → LLM | Gateway/SDK callback; model, tokens, cache, latency, price-book version |
| Agent → tool/MCP | Instrument dispatcher and client/server; tool, target class, approval, mutation digest |
| Tool → VCS/artifact store | Commit trailer/ref or artifact API; immutable artifact ID/digest |
| VCS → CI | Native commit/build linkage; tests and immutable run ID |
| CI/reviewer/system of record → outcome | Authoritative status transition and acceptance evidence |

Each process creates its own span. Late/out-of-order events are normal; append-only receipts preserve
observations and latest views select restatements.

## Opaque boundaries

Some systems cannot carry enterprise context (third-party CLIs, Amp threads, Jira, commits without
trailers). Never fabricate continuity.

1. **Deterministic:** trace context, explicit workflow ID, commit trailer, thread ID, or exact external
   identifier. Confidence 1.
2. **Evidence-resolved:** principal, repo, branch, file overlap, host/workspace, and time proximity.
   Store candidates and provenance; confidence is a ranking until calibrated.
3. **Calibrated:** measure evidence-link precision where deterministic truth also exists; publish
   sample size, calibration ID, and measured precision.

Unresolved hops remain visible gaps. Outcome/cost reports carry attribution coverage and confidence.

## Proof 1: feature implementation

`tests/workflow-proof.test.ts` executes:

```text
Jira HEAT-42 (inception)
  → EIL context → source-index evidence → CLI session → LLM call
  → MCP repository access → patch tool → Git commit abc123 (artifact)
  → CI run 9001 (verification) → Jira accepted (outcome)
```

The trace contains model usage, evidence/mutation digests, repo/commit/CI references, actor/team,
capture policy, and causal links—without ticket prose, prompts, code, or tool output.

## Proof 2: investigation

The same contract executes:

```text
payment-timeout fingerprint (inception) → CLI triage
  ├─ EIL runbook evidence
  ├─ log-index evidence
  └─ MCP metrics evidence
      → LLM hypothesis → reproduction → incident-analysis document (artifact)
      → authorized review (verification) → analysis accepted (outcome)
```

The artifact is durable and content-addressed, not chat text. Acceptance comes from the incident
system or authorized reviewer, never the investigating agent.

## Storage and monitoring

Migration `0003_workflow_lineage` projects workflow, attempt, step, stage, layer, and role from the
append-only JSON receipt into generated query columns. Existing producers remain valid because the
envelope is optional. `ai_workflow_trace_events` exposes latest restatements; tenant/workflow and
tenant/workflow/attempt indexes support reconstruction.

Monitor:

- ingestion lag, schema rejects, clock skew, duplicates/restatements, and coverage by layer/version;
- dangling links, cycles, unrooted steps, unresolved boundaries, and ambiguous candidates;
- started-without-terminal, stuck attempts, repeated steps, and no-new-evidence loops;
- artifact without verification, success without authoritative outcome, and retention gaps;
- cost/time per accepted outcome, attempts/handoffs/calls per artifact, and tokens to first artifact;
- verification failure, rework, abandonment, rollback/recurrence, and feature code survival;
- deterministic/evidence/unresolved attribution share and calibrated precision/sample size;
- collector/gateway health, queue depth, storage errors, redaction counts, and reveal audits.

Do not rank individuals or collapse cost, speed, quality, risk, coverage, and confidence into one
productivity score.

## Adoption sequence

1. Add correlation to owned orchestrator, EIL, SDK/tool/MCP, gateway, and CI boundaries.
2. Connect one authoritative work-item system and artifact system.
3. Keep both synthetic proof flows in CI.
4. Pilot metadata-only traces and measure gaps.
5. Add deterministic boundary IDs where possible.
6. Enable evidence resolution with provenance and ambiguity reporting.
7. Calibrate on deterministic overlap before calling confidence a probability.
8. Gate “completed” dashboards on artifact + verification + authoritative outcome.

Do not automate blocking based on inferred links until calibration and overrides are proven.
