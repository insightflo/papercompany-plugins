/**
 * Per-SHA review issue creation and resolution for the structured re-review
 * loop. The per-SHA issue is the execution trigger: it is created with the
 * steward as assignee so the Runtime's existing issue-creation/assignment
 * path starts the review — never `agents.invoke`, never Runtime invoke
 * context. Kept as a focused module so `rereview-intake.ts` stays under the
 * 300-line source split.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubRepositoryRoute } from "./config.js";
import {
  normalizeSha,
  decideTerminalSkip,
  isTerminalLinkedIssueStatus,
  buildReviewIssueDescription,
  buildMirroredComment,
  type RereviewState,
  type RereviewDelivery,
} from "./rereview.js";
import {
  findLinkedIssue,
  loadRereviewRevision,
  findOrCreateReviewIssue,
} from "./rereview-state.js";

export interface CreateReviewIssueInput {
  repository: string;
  prNumber: number;
  headSha: string;
  projectId: string;
  projectWorkspaceId: string;
  stewardAgentId: string;
  companyId: string;
}

/**
 * Create the per-SHA Papercompany review issue with the steward as assignee.
 * This is the ONLY place a re-review issue is created, so each
 * repository+PR+SHA maps to exactly one issue. The issue creation/assignment
 * is the execution trigger (the Runtime starts the assigned steward); no
 * direct `agents.invoke` is used.
 */
export async function createReviewIssue(
  ctx: PluginContext,
  input: CreateReviewIssueInput,
): Promise<{ issueId: string; created: boolean }> {
  const { repository, prNumber, headSha } = input;
  const existing = await loadRereviewRevision(ctx, repository, prNumber, headSha);
  if (existing.revision) {
    return { issueId: existing.revision.issueId, created: false };
  }
  const issue = await ctx.issues.create({
    companyId: input.companyId,
    projectId: input.projectId,
    title: `[${repository} #${prNumber}] Review head ${headSha.slice(0, 12)}`,
    description: buildReviewIssueDescription({ repository, prNumber, headSha }),
    status: "in_review",
    priority: "medium",
    assigneeAgentId: input.stewardAgentId,
  });
  const workspacePatch: Parameters<PluginContext["issues"]["update"]>[1] & { projectWorkspaceId: string } = {
    projectWorkspaceId: input.projectWorkspaceId,
  };
  await ctx.issues.update(issue.id, workspacePatch, input.companyId);
  await findOrCreateReviewIssue(ctx, repository, prNumber, headSha, {
    sha: headSha,
    issueId: issue.id,
    status: "pending",
  });
  return { issueId: issue.id, created: true };
}

/**
 * Resolve the review issue for a head. The FIRST PR review reuses the normal
 * linked issue created by the main bridge — and ONLY while the tracked head is
 * still the initial head (`state.firstRevision` + `state.linkedHead` snapshot)
 * AND the linked issue is still genuinely reviewable (not
 * blocked/done/cancelled/closed). Every genuinely new head creates exactly one
 * NEW issue through the standard issue-creation path. This guards the legacy
 * case: a linked issue already terminal (e.g. blocked by an earlier
 * REQUEST_CHANGES before per-SHA state existed) is never revived or reused,
 * even when no re-review state record exists yet. Existing per-SHA issues are
 * reused so retries deduplicate.
 */
export async function issueIdForHead(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  repository: string,
  prNumber: number,
  sha: string,
  state: RereviewState | null,
): Promise<string | null> {
  const { revision } = await loadRereviewRevision(ctx, repository, prNumber, sha);
  if (revision) return revision.issueId;

  // Reuse the linked issue only for the genuinely initial review: still on the
  // first tracked head (the stable linkedHead snapshot, since the generic
  // bridge overwrites the link revision on every delivery) AND the linked
  // issue is still reviewable. A terminal linked issue (blocked/done/
  // cancelled/closed — e.g. INF-247 from a REQUEST_CHANGES predating per-SHA
  // state) is never revived; a new head gets a NEW issue.
  if (state?.firstRevision && state.linkedHead && normalizeSha(state.linkedHead) === normalizeSha(sha)) {
    const linked = await findLinkedIssue(ctx, repository, "pull", prNumber);
    if (linked && linked.issueId) {
      const linkedIssue = await ctx.issues.get(linked.issueId, route.companyId);
      if (linkedIssue && !isTerminalLinkedIssueStatus(linkedIssue.status)) {
        return linked.issueId;
      }
    }
  }

  const { issueId } = await createReviewIssue(ctx, {
    repository,
    prNumber,
    headSha: sha,
    projectId: route.projectId,
    projectWorkspaceId: route.projectWorkspaceId,
    stewardAgentId: route.stewardAgentId,
    companyId: route.companyId,
  });
  return issueId;
}

/**
 * Mirror a GitHub user comment exactly once to the review issue for the
 * tracked head. The comment is never parsed as authority. When no head is
 * tracked yet (or the tracked head has no issue yet), the comment falls back
 * to the linked issue only when that issue is still reviewable; a terminal
 * issue is never used as a mirror target.
 */
export async function mirrorCommentForHead(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  repository: string,
  prNumber: number,
  state: RereviewState | null,
  delivery: RereviewDelivery,
): Promise<void> {
  const mirrored = buildMirroredComment(delivery.change);
  if (!mirrored) return;

  let targetId: string | null = null;
  if (state?.revision) {
    const { revision } = await loadRereviewRevision(ctx, repository, prNumber, state.revision);
    if (revision && !decideTerminalSkip(revision).skip) {
      targetId = revision.issueId;
    }
  }
  if (!targetId) {
    const linked = await findLinkedIssue(ctx, repository, "pull", prNumber);
    if (linked) {
      const linkedIssue = await ctx.issues.get(linked.issueId, route.companyId);
      if (linkedIssue && !isTerminalLinkedIssueStatus(linkedIssue.status)) {
        targetId = linked.issueId;
      }
    }
  }
  if (!targetId) return;
  await ctx.issues.createComment(targetId, mirrored, route.companyId);
}
