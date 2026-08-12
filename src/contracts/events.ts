import { z } from "zod";
import { workflowContextSchema } from "./workflow.js";

export const EVENT_SCHEMA_VERSION = 1 as const;

export const sourceKindSchema = z.enum([
  "copilot",
  "amp",
  "maas",
  "harness",
  "egress_proxy",
  "eil",
]);

export const operationSchema = z.enum([
  "run",
  "model_call",
  "tool_call",
  "retrieval",
  "memory",
  "approval",
  "handoff",
  "artifact",
  "evaluation",
  "outcome",
  "policy",
]);

export const eventStatusSchema = z.enum([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "waiting",
  "unknown",
]);

const isoTimestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().min(1).max(255);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const decimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

export const attributeValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
  z.array(z.boolean()),
]);

export const canonicalEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    revisionDigest: digestSchema,
    sourceEventId: identifierSchema,
    tenantId: identifierSchema,
    source: z
      .object({
        kind: sourceKindSchema,
        provider: identifierSchema,
        instanceId: identifierSchema.optional(),
        producerVersion: identifierSchema.optional(),
      })
      .strict(),
    identity: z
      .object({
        principalId: identifierSchema,
        actorType: z.enum(["human", "service", "agent", "unknown"]),
        teamId: identifierSchema.optional(),
      })
      .strict(),
    trace: z
      .object({
        runId: identifierSchema,
        traceId: identifierSchema,
        spanId: identifierSchema,
        parentSpanId: identifierSchema.optional(),
      })
      .strict(),
    workflow: workflowContextSchema.optional(),
    timing: z
      .object({
        observedAt: isoTimestampSchema,
        receivedAt: isoTimestampSchema,
      })
      .strict(),
    operation: operationSchema,
    status: eventStatusSchema,
    capture: z
      .object({
        mode: z.enum(["metadata_only", "approved_content"]),
        contentIncluded: z.boolean(),
        redaction: z.enum(["not_applicable", "source", "ingress"]),
        policyVersion: identifierSchema,
        payloadDigest: digestSchema.optional(),
      })
      .strict()
      .superRefine((capture, context) => {
        if (capture.mode === "metadata_only" && capture.contentIncluded) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "metadata_only capture cannot include content",
            path: ["contentIncluded"],
          });
        }
      }),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
        cacheWriteTokens: z.number().int().nonnegative().optional(),
        providerReportedCost: z
          .object({
            amount: decimalSchema,
            currency: currencySchema,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    model: z
      .object({
        provider: identifierSchema,
        name: identifierSchema,
        version: identifierSchema.optional(),
      })
      .strict()
      .optional(),
    attributes: z.record(z.string().min(1).max(255), attributeValueSchema).default({}),
    vendor: z
      .object({
        namespace: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
        attributes: z.record(z.string().min(1).max(255), attributeValueSchema).default({}),
        rawPayload: z
          .object({
            ref: z.string().min(1).max(2048),
            digest: digestSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (Date.parse(event.timing.receivedAt) < Date.parse(event.timing.observedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "receivedAt cannot be earlier than observedAt",
        path: ["timing", "receivedAt"],
      });
    }
    if (event.operation === "model_call" && !event.model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "model_call events require model metadata",
        path: ["model"],
      });
    }
  });

export type SourceKind = z.infer<typeof sourceKindSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type EventStatus = z.infer<typeof eventStatusSchema>;
export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export interface RawTelemetryEvent {
  sourceEventId: string;
  tenantId: string;
  source: CanonicalEvent["source"];
  identity: CanonicalEvent["identity"];
  trace: CanonicalEvent["trace"];
  workflow?: CanonicalEvent["workflow"];
  observedAt: string | Date;
  receivedAt?: string | Date;
  operation: Operation;
  status?: EventStatus;
  capture: CanonicalEvent["capture"];
  usage?: CanonicalEvent["usage"];
  model?: CanonicalEvent["model"];
  attributes?: CanonicalEvent["attributes"];
  vendor: CanonicalEvent["vendor"];
}
