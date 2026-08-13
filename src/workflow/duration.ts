import type { CanonicalEvent } from "../contracts/events.js";

export type SpanDurationUnknownReason =
  | "no_started_observation"
  | "no_terminal_observation"
  | "terminal_precedes_started";

export type SpanDuration =
  | { readonly known: true; readonly ms: number }
  | { readonly known: false; readonly reason: SpanDurationUnknownReason };

const TERMINAL_STATUSES = new Set<CanonicalEvent["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Duration of one span, derived from its own start and end observations.
 *
 * Deliberately *not* derived from the gap between consecutive steps: that gap
 * also contains queue time, CI scheduling, and human review, none of which the
 * span spent working. Deliberately *not* read from an attribute either —
 * `http.latency_ms` exists only on the MaaS gateway's own events, so a trace
 * that spans git, CI, and MCP producers cannot rely on it.
 *
 * An unmeasurable span returns `known: false` with a reason rather than 0.
 * This mirrors `extractUsage`, which returns undefined rather than zeros so a
 * metered-but-unknown call never looks identical to a verified zero-token one:
 * an in-flight, crashed, or clock-skewed span must never render as the fastest
 * step on the page.
 */
export function spanDuration(events: readonly CanonicalEvent[]): SpanDuration {
  const started = latestByStatus(events, (status) => status === "started");
  if (!started) return { known: false, reason: "no_started_observation" };

  const terminal = latestByStatus(events, (status) => TERMINAL_STATUSES.has(status));
  if (!terminal) return { known: false, reason: "no_terminal_observation" };

  const ms = Date.parse(terminal.timing.observedAt) - Date.parse(started.timing.observedAt);
  // Two producers, two clocks; nothing guarantees they agree. A negative
  // duration is a measurement failure, not a fast span.
  if (ms < 0) return { known: false, reason: "terminal_precedes_started" };

  return { known: true, ms };
}

function latestByStatus(
  events: readonly CanonicalEvent[],
  matches: (status: CanonicalEvent["status"]) => boolean,
): CanonicalEvent | undefined {
  return events
    .filter((event) => matches(event.status))
    .sort((left, right) => Date.parse(left.timing.observedAt) - Date.parse(right.timing.observedAt))
    .at(-1);
}
