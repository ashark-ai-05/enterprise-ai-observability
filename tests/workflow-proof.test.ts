import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, Operation, RawTelemetryEvent } from "../src/contracts/events.js";
import {
  type WorkflowContext,
  type WorkflowLayer,
  type WorkflowRole,
  workflowContextSchema,
} from "../src/contracts/workflow.js";
import { normalizeTelemetryEvent } from "../src/ingest/normalize.js";
import { ingestEvent } from "../src/storage/event-store.js";
import { migrations } from "../src/storage/migrations.js";
import { reconstructWorkflowTrace } from "../src/workflow/reconstruct.js";

interface ProofStep {
  id: string;
  stage: string;
  layer: WorkflowLayer;
  role: WorkflowRole;
  operation: Operation;
  links?: Array<{
    relation: "parent" | "caused_by" | "derived_from" | "used_evidence" | "produced" | "verified";
    targetStepId: string;
  }>;
  attributes?: Record<string, string | number | boolean | string[]>;
  model?: CanonicalEvent["model"];
  usage?: CanonicalEvent["usage"];
}

const featureSteps: readonly ProofStep[] = [
  {
    id: "jira:HEAT-42",
    stage: "requested",
    layer: "ticketing",
    role: "inception",
    operation: "run",
    attributes: { "work_item.system": "jira", "work_item.key": "HEAT-42" },
  },
  {
    id: "eil:context:1",
    stage: "context_retrieved",
    layer: "eil",
    role: "activity",
    operation: "retrieval",
    links: [{ relation: "caused_by", targetStepId: "jira:HEAT-42" }],
    attributes: { "retrieval.corpus": "engineering", "retrieval.result_count": 4 },
  },
  {
    id: "index:query:1",
    stage: "code_located",
    layer: "index",
    role: "evidence",
    operation: "retrieval",
    links: [{ relation: "caused_by", targetStepId: "eil:context:1" }],
    attributes: { "index.name": "source", "evidence.ref": "sha256:index-result" },
  },
  {
    id: "cli:session:1",
    stage: "implementation_started",
    layer: "cli",
    role: "activity",
    operation: "handoff",
    links: [{ relation: "used_evidence", targetStepId: "index:query:1" }],
  },
  {
    id: "llm:call:1",
    stage: "change_planned",
    layer: "llm",
    role: "activity",
    operation: "model_call",
    links: [{ relation: "parent", targetStepId: "cli:session:1" }],
    model: { provider: "example", name: "coding-model" },
    usage: { inputTokens: 1200, outputTokens: 240 },
  },
  {
    id: "mcp:repo:1",
    stage: "repository_opened",
    layer: "mcp",
    role: "activity",
    operation: "tool_call",
    links: [{ relation: "caused_by", targetStepId: "llm:call:1" }],
    attributes: { "tool.name": "repo.get", "repository.id": "heater-service" },
  },
  {
    id: "tool:patch:1",
    stage: "code_changed",
    layer: "tool",
    role: "activity",
    operation: "tool_call",
    links: [{ relation: "parent", targetStepId: "mcp:repo:1" }],
    attributes: { "change.digest": "sha256:patch", "files.changed": 2 },
  },
  {
    id: "git:commit:abc123",
    stage: "committed",
    layer: "vcs",
    role: "artifact",
    operation: "artifact",
    links: [{ relation: "derived_from", targetStepId: "tool:patch:1" }],
    attributes: { "artifact.type": "git_commit", "git.commit": "abc123" },
  },
  {
    id: "ci:run:9001",
    stage: "verified",
    layer: "ci",
    role: "verification",
    operation: "evaluation",
    links: [{ relation: "verified", targetStepId: "git:commit:abc123" }],
    attributes: { "verification.type": "test_suite", "ci.run": "9001" },
  },
  {
    id: "jira:HEAT-42:done",
    stage: "accepted",
    layer: "ticketing",
    role: "outcome",
    operation: "outcome",
    links: [
      { relation: "caused_by", targetStepId: "ci:run:9001" },
      { relation: "derived_from", targetStepId: "git:commit:abc123" },
    ],
    attributes: { "outcome.state": "accepted", "work_item.key": "HEAT-42" },
  },
];

const investigationSteps: readonly ProofStep[] = [
  {
    id: "error:payments:timeout",
    stage: "error_observed",
    layer: "incident",
    role: "inception",
    operation: "run",
    attributes: { "error.fingerprint": "sha256:error", "service.name": "payments" },
  },
  {
    id: "cli:investigation:1",
    stage: "triage_started",
    layer: "cli",
    role: "activity",
    operation: "run",
    links: [{ relation: "caused_by", targetStepId: "error:payments:timeout" }],
  },
  {
    id: "eil:runbook:1",
    stage: "runbook_retrieved",
    layer: "eil",
    role: "evidence",
    operation: "retrieval",
    links: [{ relation: "parent", targetStepId: "cli:investigation:1" }],
    attributes: { "evidence.ref": "runbook:payment-timeouts", "evidence.version": "7" },
  },
  {
    id: "index:logs:1",
    stage: "logs_correlated",
    layer: "index",
    role: "evidence",
    operation: "retrieval",
    links: [{ relation: "caused_by", targetStepId: "error:payments:timeout" }],
    attributes: { "evidence.ref": "sha256:log-query", "matches": 18 },
  },
  {
    id: "mcp:metrics:1",
    stage: "metrics_queried",
    layer: "mcp",
    role: "evidence",
    operation: "tool_call",
    links: [{ relation: "parent", targetStepId: "cli:investigation:1" }],
    attributes: { "tool.name": "metrics.query", "evidence.ref": "sha256:metrics" },
  },
  {
    id: "llm:hypothesis:1",
    stage: "hypothesis_formed",
    layer: "llm",
    role: "activity",
    operation: "model_call",
    links: [
      { relation: "used_evidence", targetStepId: "eil:runbook:1" },
      { relation: "used_evidence", targetStepId: "index:logs:1" },
      { relation: "used_evidence", targetStepId: "mcp:metrics:1" },
    ],
    model: { provider: "example", name: "analysis-model" },
    usage: { inputTokens: 1800, outputTokens: 360 },
  },
  {
    id: "tool:analysis:1",
    stage: "hypothesis_tested",
    layer: "tool",
    role: "activity",
    operation: "evaluation",
    links: [{ relation: "caused_by", targetStepId: "llm:hypothesis:1" }],
    attributes: { "verification.type": "reproduction", "verification.result": "confirmed" },
  },
  {
    id: "artifact:incident-analysis:1",
    stage: "analysis_published",
    layer: "artifact_store",
    role: "artifact",
    operation: "artifact",
    links: [{ relation: "derived_from", targetStepId: "tool:analysis:1" }],
    attributes: { "artifact.type": "incident_analysis", "artifact.ref": "sha256:report" },
  },
  {
    id: "human:review:analysis:1",
    stage: "analysis_verified",
    layer: "human",
    role: "verification",
    operation: "approval",
    links: [{ relation: "verified", targetStepId: "artifact:incident-analysis:1" }],
    attributes: { "verification.type": "authorized_review", "approval.state": "approved" },
  },
  {
    id: "incident:payments:resolved-analysis",
    stage: "analysis_accepted",
    layer: "incident",
    role: "outcome",
    operation: "outcome",
    links: [
      { relation: "derived_from", targetStepId: "artifact:incident-analysis:1" },
      { relation: "caused_by", targetStepId: "human:review:analysis:1" },
    ],
    attributes: { "outcome.state": "accepted", "outcome.kind": "root_cause_analysis" },
  },
];

function proofFlow(
  workflowId: string,
  workflowType: string,
  steps: readonly ProofStep[],
): CanonicalEvent[] {
  return steps.map((step, index) => {
    const workflow: WorkflowContext = {
      workflowId,
      workflowType,
      attemptId: `${workflowId}:attempt:1`,
      stepId: step.id,
      stage: step.stage,
      layer: step.layer,
      role: step.role,
      links: (step.links ?? []).map((link) => ({
        sourceStepId: step.id,
        ...link,
        method: "deterministic",
        confidence: 1,
        score: 1,
        calibration: { calibrated: true },
        evidence: [{ kind: "propagated_workflow_context", detail: { workflowId } }],
        candidateCount: 1,
        resolverVersion: "propagated.v1",
      })),
    };
    const raw: RawTelemetryEvent = {
      sourceEventId: `${workflowId}:${step.id}`,
      tenantId: "tenant-proof",
      source: { kind: "harness", provider: `proof.${step.layer}` },
      identity: { principalId: "agent-proof", actorType: "agent", teamId: "team-platform" },
      trace: {
        runId: workflowId,
        traceId: `${workflowId}:trace`,
        spanId: step.id,
        ...(index > 0 ? { parentSpanId: steps[index - 1]!.id } : {}),
      },
      workflow,
      observedAt: new Date(Date.UTC(2026, 7, 12, 0, index)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 7, 12, 0, index, 1)).toISOString(),
      operation: step.operation,
      status: "succeeded",
      capture: {
        mode: "metadata_only",
        contentIncluded: false,
        redaction: "source",
        policyVersion: "proof.metadata-only.v1",
      },
      vendor: { namespace: `proof.${step.layer}`, attributes: {} },
      ...(step.attributes ? { attributes: step.attributes } : {}),
      ...(step.model ? { model: step.model } : {}),
      ...(step.usage ? { usage: step.usage } : {}),
    };
    const suffix = String(index + 1).padStart(12, "0");
    return normalizeTelemetryEvent(raw, { eventId: `00000000-0000-4000-8000-${suffix}` });
  });
}

describe("generic workflow lineage proof", () => {
  it("rejects unauditable or falsely-certain resolved links", () => {
    const base = {
      workflowId: "wf:link",
      workflowType: "generic",
      attemptId: "attempt:1",
      stepId: "step:2",
      stage: "working",
      layer: "cli" as const,
      role: "activity" as const,
      links: [
        {
          sourceStepId: "step:2",
          targetStepId: "step:1",
          relation: "caused_by" as const,
          method: "evidence" as const,
          confidence: 1,
          score: 0.9,
          calibration: { calibrated: false },
          evidence: [{ kind: "time_proximity", detail: { gapSeconds: 10 }, weight: 0.2 }],
          candidateCount: 2,
          resolverVersion: "1",
        },
      ],
    };

    expect(workflowContextSchema.safeParse(base).success).toBe(false);
    expect(
      workflowContextSchema.safeParse({
        ...base,
        links: [
          {
            ...base.links[0]!,
            confidence: 0.8,
            calibration: { calibrated: true },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowContextSchema.safeParse({
        ...base,
        links: [{ ...base.links[0]!, sourceStepId: "different", confidence: 0.8 }],
      }).success,
    ).toBe(false);
  });

  it("proves a feature from Jira inception through every layer to a verified commit", () => {
    const trace = reconstructWorkflowTrace(proofFlow("wf:HEAT-42", "feature_delivery", featureSteps));

    expect(trace.complete).toBe(true);
    expect(trace.issues).toEqual([]);
    expect(trace.layers).toEqual([
      "ci",
      "cli",
      "eil",
      "index",
      "llm",
      "mcp",
      "ticketing",
      "tool",
      "vcs",
    ]);
    expect(trace.roles.artifact).toBe(1);
    expect(trace.roles.verification).toBe(1);
    expect(trace.roles.outcome).toBe(1);
    expect(trace.totalInputTokens).toBe(1200);
  });

  it("proves an investigation from error inception to a verified analysis artifact", () => {
    const trace = reconstructWorkflowTrace(
      proofFlow("wf:error:payments", "incident_investigation", investigationSteps),
    );

    expect(trace.complete).toBe(true);
    expect(trace.layers).toContain("artifact_store");
    expect(trace.layers).toContain("incident");
    expect(trace.roles.evidence).toBe(3);
    expect(trace.steps.at(-1)?.workflow?.stage).toBe("analysis_accepted");
    expect(trace.totalOutputTokens).toBe(360);
  });

  it("refuses to call an activity-only trace complete", () => {
    const incomplete = proofFlow("wf:partial", "generic", featureSteps.slice(0, 4));
    const trace = reconstructWorkflowTrace(incomplete);

    expect(trace.complete).toBe(false);
    expect(trace.issues.map((issue) => issue.code)).toEqual([
      "missing_artifact",
      "missing_verification",
      "missing_outcome",
    ]);
  });

  it("detects dangling and cyclic causal claims", () => {
    const events = proofFlow("wf:invalid", "generic", featureSteps);
    const first = events[0]!;
    const second = events[1]!;
    const changed = [
      {
        ...first,
        workflow: {
          ...first.workflow!,
          links: [deterministicLink(first.workflow!.stepId, "parent", second.workflow!.stepId)],
        },
      },
      {
        ...second,
        workflow: {
          ...second.workflow!,
          links: [
            deterministicLink(second.workflow!.stepId, "parent", first.workflow!.stepId),
            deterministicLink(second.workflow!.stepId, "used_evidence", "missing"),
          ],
        },
      },
      ...events.slice(2),
    ];
    const trace = reconstructWorkflowTrace(changed);

    expect(trace.issues.map((issue) => issue.code)).toContain("causal_cycle");
    expect(trace.issues.map((issue) => issue.code)).toContain("dangling_link");
  });

  it("rejects mixed workflows and duplicate logical steps", () => {
    const first = proofFlow("wf:first", "generic", featureSteps.slice(0, 1))[0]!;
    const other = proofFlow("wf:other", "generic", featureSteps.slice(0, 1))[0]!;
    const duplicate = {
      ...first,
      eventId: "00000000-0000-4000-8000-999999999999",
    };
    const trace = reconstructWorkflowTrace([first, other, duplicate]);

    expect(trace.complete).toBe(false);
    expect(trace.issues.map((issue) => issue.code)).toContain("mixed_workflow");
    expect(trace.issues.map((issue) => issue.code)).toContain("duplicate_step");
  });

  it("rejects disconnected artifacts and outcomes that merely coexist with evidence", () => {
    const events = proofFlow("wf:disconnected", "generic", featureSteps);
    const disconnected = events.map((event) =>
      event.workflow?.role === "artifact" || event.workflow?.role === "outcome"
        ? { ...event, workflow: { ...event.workflow, links: [] } }
        : event,
    );
    const trace = reconstructWorkflowTrace(disconnected);

    expect(trace.complete).toBe(false);
    expect(trace.issues.map((issue) => issue.code)).toContain("unrooted_step");
    expect(trace.issues.map((issue) => issue.code)).toContain("outcome_without_artifact");
    expect(trace.issues.map((issue) => issue.code)).toContain("outcome_without_verification");
  });

  it("persists queryable workflow identity without changing legacy inserts", async () => {
    const database = new PGlite();
    try {
      for (const migration of migrations) await database.exec(migration.sql);
      const events = proofFlow("wf:HEAT-42", "feature_delivery", featureSteps);
      const executor = {
        async query<Row>(sql: string, parameters?: readonly unknown[]) {
          const result = await database.query<Row>(sql, [...(parameters ?? [])]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      };
      for (const event of events) await ingestEvent(executor, event);

      const stored = await database.query<{
        workflow_id: string;
        workflow_step_id: string;
        workflow_layer: string;
      }>(
        "SELECT workflow_id, workflow_step_id, workflow_layer FROM ai_workflow_trace_events WHERE tenant_id = $1 ORDER BY observed_at",
        ["tenant-proof"],
      );
      expect(stored.rows).toHaveLength(featureSteps.length);
      expect(stored.rows[0]).toEqual({
        workflow_id: "wf:HEAT-42",
        workflow_step_id: "jira:HEAT-42",
        workflow_layer: "ticketing",
      });
    } finally {
      await database.close();
    }
    // Spinning up PGlite and running every migration takes ~1.5s on an idle
    // machine, which leaves almost no headroom under vitest's 5s default. On a
    // loaded runner it intermittently exceeded it and failed at ~5098ms — a
    // timeout that reads like a broken migration. The work is genuinely slow;
    // the deadline was the wrong part.
  }, 30_000);
});

function deterministicLink(
  sourceStepId: string,
  relation: "parent" | "used_evidence",
  targetStepId: string,
) {
  return {
    sourceStepId,
    relation,
    targetStepId,
    method: "deterministic" as const,
    confidence: 1,
    score: 1,
    calibration: { calibrated: true },
    evidence: [{ kind: "propagated_workflow_context", detail: { sourceStepId } }],
    candidateCount: 1,
    resolverVersion: "propagated.v1",
  };
}
