import type { CanonicalEvent } from "../contracts/events.js";
import type { WorkflowLayer, WorkflowRole } from "../contracts/workflow.js";

export interface WorkflowTraceIssue {
  readonly code:
    | "mixed_workflow"
    | "duplicate_step"
    | "missing_inception"
    | "missing_artifact"
    | "missing_verification"
    | "missing_outcome"
    | "dangling_link"
    | "causal_cycle"
    | "failed_terminal"
    | "unrooted_step"
    | "unverified_artifact"
    | "outcome_without_artifact"
    | "outcome_without_verification";
  readonly message: string;
  readonly stepId?: string;
}

export interface WorkflowTrace {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly attemptIds: readonly string[];
  readonly steps: readonly CanonicalEvent[];
  readonly layers: readonly WorkflowLayer[];
  readonly roles: Readonly<Partial<Record<WorkflowRole, number>>>;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly issues: readonly WorkflowTraceIssue[];
  readonly complete: boolean;
}

/**
 * Reconstructs portable workflow lineage from already-normalized latest events.
 * It validates graph integrity and evidence-backed completion without prescribing
 * a Jira-, incident-, or vendor-specific stage sequence.
 */
export function reconstructWorkflowTrace(events: readonly CanonicalEvent[]): WorkflowTrace {
  const correlated = events.filter(
    (event): event is CanonicalEvent & { workflow: NonNullable<CanonicalEvent["workflow"]> } =>
      event.workflow !== undefined,
  );
  if (correlated.length === 0) {
    throw new TypeError("at least one workflow-correlated event is required");
  }

  const first = correlated[0]!;
  const issues: WorkflowTraceIssue[] = [];
  const steps = new Map<string, (typeof correlated)[number]>();

  for (const event of correlated) {
    if (
      event.workflow.workflowId !== first.workflow.workflowId ||
      event.workflow.workflowType !== first.workflow.workflowType
    ) {
      issues.push({ code: "mixed_workflow", message: "events belong to different workflows" });
    }
    if (steps.has(event.workflow.stepId)) {
      issues.push({
        code: "duplicate_step",
        stepId: event.workflow.stepId,
        message: `duplicate latest step ${event.workflow.stepId}`,
      });
    } else {
      steps.set(event.workflow.stepId, event);
    }
  }

  for (const event of correlated) {
    for (const link of event.workflow.links) {
      if (!steps.has(link.targetStepId)) {
        issues.push({
          code: "dangling_link",
          stepId: event.workflow.stepId,
          message: `${event.workflow.stepId} links to missing ${link.targetStepId}`,
        });
      }
    }
  }

  if (hasCycle(steps)) {
    issues.push({ code: "causal_cycle", message: "workflow lineage contains a causal cycle" });
  }

  for (const event of correlated) {
    if (
      event.workflow.role !== "inception" &&
      !reachesRole(event.workflow.stepId, "inception", steps)
    ) {
      issues.push({
        code: "unrooted_step",
        stepId: event.workflow.stepId,
        message: `${event.workflow.stepId} has no causal path to workflow inception`,
      });
    }
  }

  const roles: Partial<Record<WorkflowRole, number>> = {};
  const layers = new Set<WorkflowLayer>();
  for (const event of correlated) {
    const role = event.workflow.role;
    roles[role] = (roles[role] ?? 0) + 1;
    layers.add(event.workflow.layer);
  }
  requireRole(roles, "inception", "missing_inception", issues);
  requireRole(roles, "artifact", "missing_artifact", issues);
  requireRole(roles, "verification", "missing_verification", issues);
  requireRole(roles, "outcome", "missing_outcome", issues);

  const terminal = correlated.filter((event) => event.workflow.role === "outcome");
  if (terminal.length > 0 && terminal.every((event) => event.status !== "succeeded")) {
    issues.push({ code: "failed_terminal", message: "no outcome step succeeded" });
  }
  const verifications = correlated.filter((event) => event.workflow.role === "verification");
  if (
    roles.artifact &&
    !verifications.some((event) => reachesRole(event.workflow.stepId, "artifact", steps))
  ) {
    issues.push({
      code: "unverified_artifact",
      message: "no verification step has a causal path to an artifact",
    });
  }
  for (const outcome of terminal.filter((event) => event.status === "succeeded")) {
    if (!reachesRole(outcome.workflow.stepId, "artifact", steps)) {
      issues.push({
        code: "outcome_without_artifact",
        stepId: outcome.workflow.stepId,
        message: "successful outcome has no causal path to an artifact",
      });
    }
    if (!reachesRole(outcome.workflow.stepId, "verification", steps)) {
      issues.push({
        code: "outcome_without_verification",
        stepId: outcome.workflow.stepId,
        message: "successful outcome has no causal path to verification",
      });
    }
  }

  return {
    workflowId: first.workflow.workflowId,
    workflowType: first.workflow.workflowType,
    attemptIds: [...new Set(correlated.map((event) => event.workflow.attemptId))].sort(),
    steps: [...correlated].sort(
      (left, right) => Date.parse(left.timing.observedAt) - Date.parse(right.timing.observedAt),
    ),
    layers: [...layers].sort(),
    roles,
    totalInputTokens: correlated.reduce((sum, event) => sum + (event.usage?.inputTokens ?? 0), 0),
    totalOutputTokens: correlated.reduce((sum, event) => sum + (event.usage?.outputTokens ?? 0), 0),
    issues,
    complete: issues.length === 0,
  };
}

function requireRole(
  roles: Partial<Record<WorkflowRole, number>>,
  role: WorkflowRole,
  code: WorkflowTraceIssue["code"],
  issues: WorkflowTraceIssue[],
): void {
  if (!roles[role]) issues.push({ code, message: `workflow has no ${role} step` });
}

function hasCycle(
  steps: ReadonlyMap<
    string,
    CanonicalEvent & { workflow: NonNullable<CanonicalEvent["workflow"]> }
  >,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    const step = steps.get(stepId);
    if (step) {
      for (const link of step.workflow.links) {
        if (steps.has(link.targetStepId) && visit(link.targetStepId)) return true;
      }
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  return [...steps.keys()].some(visit);
}

function reachesRole(
  stepId: string,
  role: WorkflowRole,
  steps: ReadonlyMap<
    string,
    CanonicalEvent & { workflow: NonNullable<CanonicalEvent["workflow"]> }
  >,
  visited = new Set<string>(),
): boolean {
  if (visited.has(stepId)) return false;
  visited.add(stepId);
  const step = steps.get(stepId);
  if (!step) return false;
  for (const link of step.workflow.links) {
    const target = steps.get(link.targetStepId);
    if (target?.workflow.role === role) return true;
    if (target && reachesRole(target.workflow.stepId, role, steps, visited)) return true;
  }
  return false;
}
