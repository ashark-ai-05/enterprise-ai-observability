import type { CanonicalEvent, Operation } from "../contracts/events.js";
import { spanDuration } from "./duration.js";

export type WorkTotal =
  | { readonly known: true; readonly ms: number }
  | {
      readonly known: false;
      readonly reason: "unmeasured_spans";
      readonly unmeasuredStepIds: readonly string[];
    };

export type WaitTotal =
  | { readonly known: true; readonly ms: number }
  | { readonly known: false; readonly reason: "work_unknown" | "work_exceeds_elapsed" };

export interface WorkflowMeasurement {
  /** Time spans were actually working, summed. Unknown if any span is unmeasurable. */
  readonly workMs: WorkTotal;
  /** Wall clock from the first observation to the last. Always measurable. */
  readonly elapsedMs: number;
  /** Elapsed minus work — queue, review, CI scheduling. Unknown if work is. */
  readonly waitMs: WaitTotal;
  readonly toolCalls: number;
  readonly modelCalls: number;
}

/**
 * Measures a workflow from its full observation stream.
 *
 * Deliberately separate from `reconstructWorkflowTrace`, which consumes one
 * latest event per step and reports `duplicate_step` when a step appears
 * twice. Measuring durations requires the opposite input — both the started
 * and terminal observation of every span — so the two functions read the same
 * stream at different grains rather than one calling the other.
 *
 * A single unmeasurable span makes the whole work total unknown. Summing only
 * the measurable spans would silently understate the work, and understated
 * work silently overstates wait, which is the number an audience is most
 * likely to quote.
 */
export function measureWorkflowTrace(events: readonly CanonicalEvent[]): WorkflowMeasurement {
  if (events.length === 0) throw new TypeError("at least one event is required");

  const spans = groupBySpan(events);

  let measuredWorkMs = 0;
  const unmeasuredStepIds: string[] = [];
  for (const [stepId, spanEvents] of spans) {
    const duration = spanDuration(spanEvents);
    if (duration.known) measuredWorkMs += duration.ms;
    else unmeasuredStepIds.push(stepId);
  }

  const observedAtMs = events.map((event) => Date.parse(event.timing.observedAt));
  const elapsedMs = Math.max(...observedAtMs) - Math.min(...observedAtMs);

  const workMs: WorkTotal =
    unmeasuredStepIds.length > 0
      ? { known: false, reason: "unmeasured_spans", unmeasuredStepIds: unmeasuredStepIds.sort() }
      : { known: true, ms: measuredWorkMs };

  return {
    workMs,
    elapsedMs,
    waitMs: deriveWait(workMs, elapsedMs),
    toolCalls: countSpansWithOperation(spans, "tool_call"),
    modelCalls: countSpansWithOperation(spans, "model_call"),
  };
}

/**
 * Wait is elapsed minus work, which assumes spans do not overlap. Agents run
 * tools concurrently, so that assumption fails often enough to check: summed
 * span time can exceed the wall clock, and the subtraction then yields a
 * negative wait. Concurrency-aware wait needs interval-union arithmetic over
 * the spans, not a subtraction; until that exists this reports unknown rather
 * than a negative bar.
 */
function deriveWait(workMs: WorkTotal, elapsedMs: number): WaitTotal {
  if (!workMs.known) return { known: false, reason: "work_unknown" };
  if (workMs.ms > elapsedMs) return { known: false, reason: "work_exceeds_elapsed" };
  return { known: true, ms: elapsedMs - workMs.ms };
}

/**
 * Spans are keyed by workflow step where one exists, falling back to the
 * trace span id, so producers that emit spans without workflow correlation
 * still measure rather than collapsing into one bucket.
 */
function groupBySpan(events: readonly CanonicalEvent[]): Map<string, CanonicalEvent[]> {
  const spans = new Map<string, CanonicalEvent[]>();
  for (const event of events) {
    const key = event.workflow?.stepId ?? event.trace.spanId;
    const existing = spans.get(key);
    if (existing) existing.push(event);
    else spans.set(key, [event]);
  }
  return spans;
}

/** Counts spans, not observations: a started/terminal pair is one call. */
function countSpansWithOperation(
  spans: ReadonlyMap<string, readonly CanonicalEvent[]>,
  operation: Operation,
): number {
  let count = 0;
  for (const spanEvents of spans.values()) {
    if (spanEvents.some((event) => event.operation === operation)) count += 1;
  }
  return count;
}
