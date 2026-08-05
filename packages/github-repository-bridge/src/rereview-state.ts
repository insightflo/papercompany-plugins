/**
 * Persistence and GitHub HTTP helpers shared by the re-review intake and the
 * steward review-result path.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  REREVIEW_ENTITY,
  rereviewStateExternalId,
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
    lastWakeAt: asString(data.lastWakeAt) || null,
    lastWakeCommentId: asString(data.lastWakeCommentId) || null,
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

export async function findLinkedIssueId(
  ctx: PluginContext,
  repository: string,
  objectKind: string,
  objectNumber: number,
): Promise<string> {
  const [link] = await ctx.entities.list({
    entityType: LINK_ENTITY,
    externalId: `${repository}:${objectKind}:${objectNumber}`,
    limit: 1,
  });
  const issueId = typeof link?.data?.issueId === "string" ? link.data.issueId : "";
  return issueId;
}

export function githubHeaders(token: string): Record<string, string> {
  return githubAuthHeaders(token);
}
