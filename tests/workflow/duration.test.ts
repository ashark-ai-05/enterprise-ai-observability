import { describe, expect, it } from "vitest";
import type { CanonicalEvent, EventStatus, RawTelemetryEvent } from "../../src/contracts/events.js";
import { normalizeTelemetryEvent } from "../../src/ingest/normalize.js";
import { spanDuration } from "../../src/workflow/duration.js";

let seq = 0;

/** One observation of a span, built through the real normalizer. */
function observation(status: EventStatus, offsetMs: number): CanonicalEvent {
  const observedAt = new Date(Date.UTC(2026, 7, 12) + offsetMs).toISOString();
  const raw: RawTelemetryEvent = {
    sourceEventId: "span-under-test",
    tenantId: "tenant-duration",
    source: { kind: "harness", provider: "duration.test" },
    identity: { principalId: "agent-duration", actorType: "agent" },
    trace: { runId: "run-1", traceId: "trace-1", spanId: "span-1" },
    observedAt,
    // receivedAt must never be earlier than observedAt; the ingress is always
    // at least as late as the observation it carries.
    receivedAt: new Date(Date.UTC(2026, 7, 12) + offsetMs + 5).toISOString(),
    operation: "tool_call",
    status,
    capture: {
      mode: "metadata_only",
      contentIncluded: false,
      redaction: "not_applicable",
      policyVersion: "duration.test.v1",
    },
    vendor: { namespace: "duration.test", attributes: {} },
  };
  const suffix = String(++seq).padStart(12, "0");
  return normalizeTelemetryEvent(raw, { eventId: `00000000-0000-4000-8000-${suffix}` });
}

describe("spanDuration", () => {
  it("measures a span from its started and terminal observations", () => {
    const result = spanDuration([observation("started", 0), observation("succeeded", 250)]);

    expect(result).toEqual({ known: true, ms: 250 });
  });

  it("measures a failed span rather than discarding it", () => {
    const result = spanDuration([observation("started", 0), observation("failed", 40)]);

    expect(result).toEqual({ known: true, ms: 40 });
  });

  it("refuses to report a duration for a span that never terminated", () => {
    const result = spanDuration([observation("started", 0)]);

    // The failure mode this guards: an in-flight or crashed span rendering as
    // a completed 0ms step, which reads as the fastest work on the page.
    expect(result).toEqual({ known: false, reason: "no_terminal_observation" });
  });

  it("refuses to report a duration for a terminal with no started observation", () => {
    const result = spanDuration([observation("succeeded", 250)]);

    expect(result).toEqual({ known: false, reason: "no_started_observation" });
  });

  it("refuses a negative duration when the terminal precedes the started observation", () => {
    // Two producers, two clocks, no guarantee of agreement between them.
    const result = spanDuration([observation("started", 250), observation("succeeded", 0)]);

    expect(result).toEqual({ known: false, reason: "terminal_precedes_started" });
  });
});
