/**
 * Persistence and GitHub HTTP helpers shared by the re-review intake and the
 * steward review-result path. Records are keyed by repository+PR+SHA so
 * webhook retries and concurrent deliveries deduplicate.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  REREVIEW_ENTITY,
  REREVIEW_ISSUE_ENTITY,
  rereviewStateExternalId,
  rereviewRevisionExternalId,
  type RereviewRevision,
  type RereviewState,
} from "./rereview.js";
import { parseCommitChecks } from "./merge-checks.js";
import { GITHUB_API_USER_AGENT } from "./github-app-auth.js";

export const LINK_ENTITY = "github-object-link";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function githubAuthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": GITHUB_API_USER_AGENT,
  };
}

export function splitRepo(repository: string): [string, string] {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
  if (!match) throw new Error(`repository must use owner/name format: ${repository}`);
  return [encodeURIComponent(match[1]!), encodeURIComponent(match[2]!)];
}

/**
 * Fetch the authoritative check-run set for an exact commit SHA through the
 * GitHub App. Returns an empty array when the lookup fails so callers stay
 * fail-closed (never decide from a partial/missing check set).
 */
export async function fetchShaChecks(
  ctx: PluginContext,
  token: string,
  repository: string,
  sha: string,
): Promise<Array<{ name: string; conclusion: string }>> {
  const [owner, repo] = splitRepo(repository);
  const res = await ctx.http.fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    { method: "GET", headers: githubAuthHeaders(token) },
  );
  if (res.status < 200 || res.status >= 300) return [];
  const body: unknown = await res.json().catch(() => ({}));
  return parseCommitChecks(repository, sha, body).map((check) => ({
    name: check.name,
    conclusion: check.conclusion === "success" ? "success" : check.conclusion,
  }));
}

export function readRereviewState(entity: { data?: Record<string, unknown> | null } | null): RereviewState | null {
  const data = entity?.data ?? {};
  const revision = asString(data.revision);
  if (!revision) return null;
  const required = Array.isArray(data.requiredChecks)
    ? (data.requiredChecks as unknown[]).map((entry) => asString(entry)).filter(Boolean)
    : [];
  return {
    revision,
    wokenRevision: asString(data.wokenRevision) || null,
    checksSatisfied: data.checksSatisfied === true,
    requiredChecks: required,
    conclusions: Array.isArray(data.conclusions)
      ? (data.conclusions as unknown[])
          .map((entry) => {
            const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            const name = asString(record.name);
            const conclusion = asString(record.conclusion);
            return name ? { name, conclusion } : null;
          })
          .filter((entry): entry is { name: string; conclusion: string } => entry !== null)
      : [],
    lastWakeAt: asString(data.lastWakeAt) || null,
    lastWakeCommentId: asString(data.lastWakeCommentId) || null,
    firstRevision: data.firstRevision === true,
    linkedHead: asString(data.linkedHead) || null,
  };
}

export function writeRereviewState(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
  state: RereviewState,
): Promise<unknown> {
  return ctx.entities.upsert({
    entityType: REREVIEW_ENTITY,
    scopeKind: "instance",
    externalId: rereviewStateExternalId(repository, prNumber),
    title: `rereview ${repository}#${prNumber}`,
    status: state.checksSatisfied ? "eligible" : "blocked",
    data: { ...state },
  });
}

export async function loadRereviewState(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
): Promise<{ entity: unknown; state: RereviewState | null }> {
  const [entity] = await ctx.entities.list({
    entityType: REREVIEW_ENTITY,
    externalId: rereviewStateExternalId(repository, prNumber),
    limit: 1,
  });
  return { entity, state: readRereviewState(entity ?? null) };
}

export function readRereviewRevision(entity: { data?: Record<string, unknown> | null } | null): RereviewRevision | null {
  const data = entity?.data ?? {};
  const sha = asString(data.sha);
  const issueId = asString(data.issueId);
  if (!sha || !issueId) return null;
  const status = asString(data.status);
  return {
    sha,
    issueId,
    status: status === "pass" || status === "request_changes" || status === "terminal" || status === "woken"
      ? status
      : "pending",
  };
}

export async function loadRereviewRevision(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
  sha: string,
): Promise<{ entity: unknown; revision: RereviewRevision | null }> {
  const [entity] = await ctx.entities.list({
    entityType: REREVIEW_ISSUE_ENTITY,
    externalId: rereviewRevisionExternalId(repository, prNumber, sha),
    limit: 1,
  });
  return { entity, revision: readRereviewRevision(entity ?? null) };
}

/**
 * Record the per-SHA review issue. Idempotent per repository+PR+exact SHA;
 * concurrent deliveries of the same SHA converge on the same issue.
 */
export async function recordRereviewRevision(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
  revision: RereviewRevision,
): Promise<RereviewRevision> {
  const externalId = rereviewRevisionExternalId(repository, prNumber, revision.sha);
  const [existing] = await ctx.entities.list({ entityType: REREVIEW_ISSUE_ENTITY, externalId, limit: 1 });
  if (existing) {
    const current = readRereviewRevision(existing);
    if (current) return current;
  }
  await ctx.entities.upsert({
    entityType: REREVIEW_ISSUE_ENTITY,
    scopeKind: "instance",
    externalId,
    title: `rereview issue ${repository}#${prNumber} @${revision.sha.slice(0, 12)}`,
    status: revision.status,
    data: { ...revision },
  });
  return revision;
}

export async function updateRereviewRevision(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
  revision: RereviewRevision,
): Promise<void> {
  await ctx.entities.upsert({
    entityType: REREVIEW_ISSUE_ENTITY,
    scopeKind: "instance",
    externalId: rereviewRevisionExternalId(repository, prNumber, revision.sha),
    title: `rereview issue ${repository}#${prNumber} @${revision.sha.slice(0, 12)}`,
    status: revision.status,
    data: { ...revision },
  });
}

export async function findLinkedIssueId(
  ctx: PluginContext,
  repository: string,
  objectKind: string,
  objectNumber: number,
): Promise<string> {
  const link = await findLinkEntity(ctx, repository, objectKind, objectNumber);
  return typeof link?.data?.issueId === "string" ? link.data.issueId : "";
}

/**
 * The link entity records the PR head SHA (`revision`) at the time the link
 * was created. The intake uses it to tell the initial head (reuse the linked
 * issue) from a genuinely new head (create a NEW issue).
 */
export async function findLinkedIssue(
  ctx: PluginContext,
  repository: string,
  objectKind: string,
  objectNumber: number,
): Promise<{ issueId: string; revision: string } | null> {
  const link = await findLinkEntity(ctx, repository, objectKind, objectNumber);
  const issueId = typeof link?.data?.issueId === "string" ? link.data.issueId : "";
  const revision = typeof link?.data?.revision === "string" ? link.data.revision : "";
  return issueId ? { issueId, revision } : null;
}

async function findLinkEntity(
  ctx: PluginContext,
  repository: string,
  objectKind: string,
  objectNumber: number,
): Promise<{ data?: Record<string, unknown> | null } | null> {
  const [link] = await ctx.entities.list({
    entityType: LINK_ENTITY,
    externalId: `${repository}:${objectKind}:${objectNumber}`,
    limit: 1,
  });
  return link ?? null;
}

export async function findOrCreateReviewIssue(
  ctx: PluginContext,
  repository: string,
  prNumber: number,
  sha: string,
  revision: RereviewRevision,
): Promise<RereviewRevision> {
  return recordRereviewRevision(ctx, repository, prNumber, revision);
}

export function githubHeaders(token: string): Record<string, string> {
  return githubAuthHeaders(token);
}
