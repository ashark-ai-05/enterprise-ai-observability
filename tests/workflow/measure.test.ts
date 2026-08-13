import { describe, expect, it } from "vitest";
import type {
  CanonicalEvent,
  EventStatus,
  Operation,
  RawTelemetryEvent,
} from "../../src/contracts/events.js";
import type { WorkflowLayer, WorkflowRole } from "../../src/contracts/workflow.js";
import { normalizeTelemetryEvent } from "../../src/ingest/normalize.js";
import { measureWorkflowTrace } from "../../src/workflow/measure.js";

let seq = 0;

interface ObservationInput {
  stepId: string;
  status: EventStatus;
  atMs: number;
  operation?: Operation;
  layer?: WorkflowLayer;
  role?: WorkflowRole;
  model?: CanonicalEvent["model"];
}

function observation({
  stepId,
  status,
  atMs,
  operation = "tool_call",
  layer = "tool",
  role = "activity",
  model,
}: ObservationInput): CanonicalEvent {
  const raw: RawTelemetryEvent = {
    sourceEventId: `${stepId}:${status}`,
    tenantId: "tenant-measure",
    source: { kind: "harness", provider: "measure.test" },
    identity: { principalId: "agent-measure", actorType: "agent" },
    trace: { runId: "run-1", traceId: "trace-1", spanId: stepId },
    workflow: {
      workflowId: "wf-1",
      workflowType: "feature_delivery",
      attemptId: "wf-1:attempt:1",
      stepId,
      stage: stepId,
      layer,
      role,
      links: [],
    },
    observedAt: new Date(Date.UTC(2026, 7, 12) + atMs).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 7, 12) + atMs + 5).toISOString(),
    operation,
    status,
    capture: {
      mode: "metadata_only",
      contentIncluded: false,
      redaction: "not_applicable",
      policyVersion: "measure.test.v1",
    },
    vendor: { namespace: "measure.test", attributes: {} },
    // canonicalEventSchema refuses a model_call with no model metadata.
    ...(model ? { model } : {}),
  };
  const suffix = String(++seq).padStart(12, "0");
  return normalizeTelemetryEvent(raw, { eventId: `00000000-0000-4000-8000-${suffix}` });
}

/** Two spans that each worked 100ms, inside a 1000ms wall clock. */
const twoMeasuredSpans: readonly CanonicalEvent[] = [
  observation({ stepId: "step-a", status: "started", atMs: 0 }),
  observation({ stepId: "step-a", status: "succeeded", atMs: 100 }),
  observation({ stepId: "step-b", status: "started", atMs: 900 }),
  observation({ stepId: "step-b", status: "succeeded", atMs: 1000 }),
];

describe("measureWorkflowTrace", () => {
  it("sums each span's measured duration into active work time", () => {
    const measured = measureWorkflowTrace(twoMeasuredSpans);

    expect(measured.workMs).toEqual({ known: true, ms: 200 });
  });

  it("reports elapsed wall-clock across the whole trace", () => {
    const measured = measureWorkflowTrace(twoMeasuredSpans);

    expect(measured.elapsedMs).toBe(1000);
  });

  it("reports the time nothing was working as wait", () => {
    const measured = measureWorkflowTrace(twoMeasuredSpans);

    // The headline for the executive view: 800 of these 1000ms bought nothing.
    expect(measured.waitMs).toEqual({ known: true, ms: 800 });
  });

  it("refuses a work total when any span is unmeasurable", () => {
    const measured = measureWorkflowTrace([
      ...twoMeasuredSpans,
      observation({ stepId: "step-c", status: "started", atMs: 1000 }),
    ]);

    // Summing only the measurable spans would report 200ms of work and
    // understate it, with nothing on the page admitting the omission.
    expect(measured.workMs).toEqual({
      known: false,
      reason: "unmeasured_spans",
      unmeasuredStepIds: ["step-c"],
    });
  });

  it("cannot report wait when work is unknown", () => {
    const measured = measureWorkflowTrace([
      ...twoMeasuredSpans,
      observation({ stepId: "step-c", status: "started", atMs: 1000 }),
    ]);

    expect(measured.waitMs).toEqual({ known: false, reason: "work_unknown" });
  });

  it("refuses a wait total when spans overlap rather than reporting negative wait", () => {
    // Agents run tools concurrently. Summed span time then exceeds wall clock,
    // and elapsed-minus-work goes negative — which would render as a negative
    // bar rather than as the "we cannot say" it actually is.
    const measured = measureWorkflowTrace([
      observation({ stepId: "step-a", status: "started", atMs: 0 }),
      observation({ stepId: "step-a", status: "succeeded", atMs: 100 }),
      observation({ stepId: "step-b", status: "started", atMs: 0 }),
      observation({ stepId: "step-b", status: "succeeded", atMs: 100 }),
    ]);

    expect(measured.workMs).toEqual({ known: true, ms: 200 });
    expect(measured.waitMs).toEqual({ known: false, reason: "work_exceeds_elapsed" });
  });

  it("counts tool calls once per span, not once per observation", () => {
    const measured = measureWorkflowTrace(twoMeasuredSpans);

    // Four events, two spans, both tool calls. Counting events would say four.
    expect(measured.toolCalls).toBe(2);
  });

  it("does not count a model call as a tool call", () => {
    const measured = measureWorkflowTrace([
      ...twoMeasuredSpans,
      observation({
        stepId: "step-llm",
        status: "started",
        atMs: 200,
        operation: "model_call",
        layer: "llm",
        model: { provider: "internal-maas", name: "gpt-x" },
      }),
      observation({
        stepId: "step-llm",
        status: "succeeded",
        atMs: 300,
        operation: "model_call",
        layer: "llm",
        model: { provider: "internal-maas", name: "gpt-x" },
      }),
    ]);

    expect(measured.toolCalls).toBe(2);
    expect(measured.modelCalls).toBe(1);
  });
});
