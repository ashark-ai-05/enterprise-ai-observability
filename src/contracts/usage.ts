import { z } from "zod";
import {
  EVENT_SCHEMA_VERSION,
  attributeValueSchema,
  sourceKindSchema,
} from "./events.js";

const identifierSchema = z.string().min(1).max(255);

export const periodicUsageFactSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    factId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceFactId: identifierSchema,
    tenantId: identifierSchema,
    source: z
      .object({
        kind: sourceKindSchema,
        provider: identifierSchema,
        instanceId: identifierSchema.optional(),
      })
      .strict(),
    grain: z.literal("principal_day_model"),
    period: z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict(),
    principalId: identifierSchema,
    teamId: identifierSchema.optional(),
    model: z
      .object({
        provider: identifierSchema,
        name: identifierSchema,
        version: identifierSchema.optional(),
      })
      .strict(),
    usage: z
      .object({
        requests: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
        cacheWriteTokens: z.number().int().nonnegative().optional(),
        providerReportedCost: z
          .object({
            amount: z.string().regex(/^\d+(?:\.\d+)?$/),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
      })
      .strict(),
    output: z
      .object({
        linesAdded: z.number().int().nonnegative().optional(),
        linesDeleted: z.number().int().nonnegative().optional(),
        linesModified: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    capture: z
      .object({
        policyVersion: identifierSchema,
        redaction: z.enum(["not_applicable", "source", "ingress"]),
      })
      .strict(),
    vendor: z
      .object({
        namespace: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
        attributes: z.record(z.string().min(1).max(255), attributeValueSchema).default({}),
        rawPayload: z
          .object({
            ref: z.string().min(1).max(2048),
            digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (Date.parse(fact.period.end) <= Date.parse(fact.period.start)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "period end must be later than period start",
        path: ["period", "end"],
      });
    }
  });

export type PeriodicUsageFact = z.infer<typeof periodicUsageFactSchema>;

export type PeriodicUsageFactInput = Omit<
  PeriodicUsageFact,
  "schemaVersion" | "factId" | "idempotencyKey"
>;
