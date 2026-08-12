import type { CanonicalEvent } from "../contracts/events.js";
import { ingestEvent, type SqlExecutor } from "../storage/event-store.js";

export interface GatewayEventSink {
  emit(event: CanonicalEvent): Promise<void>;
}

/** Default sink for local dev/tests: keeps events in memory, nothing external. */
export class InMemoryEventSink implements GatewayEventSink {
  readonly events: CanonicalEvent[] = [];

  async emit(event: CanonicalEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Thin wrapper over the real append-only receipt store from PR #1. */
export class PostgresEventSink implements GatewayEventSink {
  constructor(private readonly executor: SqlExecutor) {}

  async emit(event: CanonicalEvent): Promise<void> {
    await ingestEvent(this.executor, event);
  }
}
