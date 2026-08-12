import { z } from "zod";

const identifierSchema = z.string().min(1).max(255);

/** Logical layer, independent of whichever collector transported the event. */
export const workflowLayerSchema = z.enum([
  "workflow",
  "ticketing",
  "incident",
  "eil",
  "cli",
  "llm",
  "index",
  "tool",
  "mcp",
  "vcs",
  "ci",
  "artifact_store",
  "human",
  "other",
]);

export const workflowRoleSchema = z.enum([
  "inception",
  "activity",
  "evidence",
  "artifact",
  "verification",
  "outcome",
]);

export const workflowLinkRelationSchema = z.enum([
  "parent",
  "caused_by",
  "derived_from",
  "used_evidence",
  "produced",
  "verified",
  "supersedes",
]);

export const workflowLinkSchema = z
  .object({
    sourceStepId: identifierSchema,
    relation: workflowLinkRelationSchema,
    targetStepId: identifierSchema,
    method: z.enum(["deterministic", "evidence"]),
    confidence: z.number().min(0).max(1),
    score: z.number().min(0).max(1),
    calibration: z
      .object({
        calibrated: z.boolean(),
        measuredPrecision: z.number().min(0).max(1).optional(),
        sampleSize: z.number().int().positive().optional(),
        calibrationId: identifierSchema.optional(),
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            kind: identifierSchema,
            detail: z.record(
              z.string().min(1).max(255),
              z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]),
            ),
            weight: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .min(1),
    candidateCount: z.number().int().positive(),
    resolverVersion: identifierSchema,
  })
  .strict()
  .superRefine((link, context) => {
    if (link.method === "deterministic" && (link.confidence !== 1 || link.score !== 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deterministic links require confidence and score of 1",
      });
    }
    if (link.method === "evidence" && link.confidence === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidence links cannot claim certainty",
        path: ["confidence"],
      });
    }
    if (
      link.method === "evidence" &&
      link.calibration.calibrated &&
      (link.calibration.measuredPrecision === undefined ||
        link.calibration.sampleSize === undefined ||
        link.calibration.calibrationId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "calibrated evidence links require precision, sample size, and calibration ID",
        path: ["calibration"],
      });
    }
  });

/**
 * Correlation carried by every cross-stack event participating in a workflow.
 * Stages and workflow types are deliberately tenant-defined; the role/layer/link
 * vocabulary is the portable part used by reconstruction and policy checks.
 */
export const workflowContextSchema = z
  .object({
    workflowId: identifierSchema,
    workflowType: identifierSchema,
    attemptId: identifierSchema,
    stepId: identifierSchema,
    stage: identifierSchema,
    layer: workflowLayerSchema,
    role: workflowRoleSchema,
    links: z.array(workflowLinkSchema).max(64).default([]),
  })
  .strict()
  .superRefine((workflow, context) => {
    if (workflow.links.some((link) => link.sourceStepId !== workflow.stepId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workflow link source must equal the containing step",
        path: ["links"],
      });
    }
    if (workflow.links.some((link) => link.targetStepId === workflow.stepId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a workflow step cannot link to itself",
        path: ["links"],
      });
    }
  });

export type WorkflowLayer = z.infer<typeof workflowLayerSchema>;
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;
export type WorkflowLink = z.infer<typeof workflowLinkSchema>;
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
