/**
 * Pure decision logic for approval-driven deployment. None of these functions
 * touch the plugin host — they take parsed inputs and return deterministic
 * decisions, which makes the safety-critical gating fully unit-testable.
 */
import type { CommitCheck, PushDelivery } from "./push-delivery.js";
import type { DeployApprovalsConfig } from "./config.js";

export const DEPLOY_APPROVAL_TYPE = "external_automation";

/** A required check is satisfied only when it completed successfully. */
export function isCheckSatisfied(check: CommitCheck): boolean {
  return check.status === "completed" && check.conclusion === "success";
}

export interface CheckGateResult {
  satisfied: boolean;
  missing: string[];
  evidence: Array<{ name: string; status: string; conclusion: string; source: string }>;
}

/**
 * Determine whether every configured required check has at least one
 * successful observation for the exact commit SHA. A missing or non-success
 * check means the gate is NOT satisfied — no approval may be created.
 */
export function evaluateCheckGate(
  requiredChecks: string[],
  observed: CommitCheck[],
): CheckGateResult {
  const successByName = new Map<string, CommitCheck>();
  const latestByName = new Map<string, CommitCheck>();
  for (const check of observed) {
    const prev = latestByName.get(check.name);
    if (!prev || check.source === "workflow_run") latestByName.set(check.name, check);
    if (isCheckSatisfied(check)) successByName.set(check.name, check);
  }
  const missing: string[] = [];
  const evidence: CheckGateResult["evidence"] = [];
  for (const required of requiredChecks) {
    const ok = successByName.get(required) ?? latestByName.get(required);
    if (successByName.has(required)) {
      evidence.push({ name: required, status: "completed", conclusion: "success", source: successByName.get(required)!.source });
    } else if (ok) {
      evidence.push({ name: required, status: ok.status, conclusion: ok.conclusion, source: ok.source });
      missing.push(required);
    } else {
      evidence.push({ name: required, status: "missing", conclusion: "missing", source: "missing" });
      missing.push(required);
    }
  }
  return { satisfied: missing.length === 0, missing, evidence };
}

/** Build the human-readable, environment-neutral approval payload. */
export function buildApprovalPayload(input: {
  push: PushDelivery;
  config: DeployApprovalsConfig;
  checks: CheckGateResult;
}): Record<string, unknown> {
  const { push, config, checks } = input;
  const commitLine = push.commitMessage.split("\n")[0]?.trim() || push.after;
  return {
    repository: push.repository,
    branch: push.branch,
    commit: push.after,
    commitMessage: commitLine,
    commitAuthor: push.commitAuthor,
    commitUrl: push.url,
    intendedAction: config.approvalTitle,
    requiredChecks: config.requiredChecks,
    checks: checks.evidence,
    sourcePluginId: "insightflo.github-repository-bridge",
  };
}

/** The logical deployment key from the design: repo + branch + commit SHA. */
export function deployApprovalKey(repository: string, branch: string, sha: string): string {
  return `${repository}:${branch}:${sha}`;
}

/**
 * Given the existing pending approval SHAs for a repository+branch and a newly
 * observed SHA, return the SHAs that are now superseded (stale). A pending
 * approval for a different SHA than the newest push is non-actionable.
 */
export function selectSupersededShas(
  newestSha: string,
  pendingShasForBranch: string[],
): string[] {
  return pendingShasForBranch.filter((sha) => sha !== newestSha);
}

/** Dispatch payload sent to the Operations repository_dispatch endpoint. */
export interface DispatchPayload {
  eventType: string;
  repository: string;
  branch: string;
  commit: string;
  approvalId: string;
}

export function buildDispatchPayload(input: {
  config: DeployApprovalsConfig;
  push: PushDelivery;
  approvalId: string;
}): DispatchPayload {
  return {
    eventType: input.config.dispatch.eventType,
    repository: input.push.repository,
    branch: input.push.branch,
    commit: input.push.after,
    approvalId: input.approvalId,
  };
}
