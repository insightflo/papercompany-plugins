/**
 * External-id builders and comment-mirroring helpers for the structured
 * re-review loop. Kept as a focused module so `rereview.ts` stays under the
 * 300-line source split.
 */
import type { GitHubChange } from "./delivery.js";
import { normalizeSha } from "./rereview.js";

/** Plugin-owned entity tracking the re-review revision per repository+PR. */
export const REREVIEW_ENTITY = "github-rereview-state";
/** Plugin-owned entity recording one review issue per exact PR head SHA. */
export const REREVIEW_ISSUE_ENTITY = "github-rereview-issue";
/** Plugin-owned entity recording one REQUEST_CHANGES publication per SHA+verdict. */
export const REREVIEW_PUBLICATION_ENTITY = "github-rereview-publication";

export const SOURCE_MARKER = "<!-- papercompany-github-bridge:source=github -->";
export const STEWARD_RC_MARKER = "<!-- papercompany-github-bridge:steward-request-changes -->";

export function rereviewStateExternalId(repository: string, prNumber: number): string {
  return `rereview:${repository.toLowerCase()}:${prNumber}`;
}

/** Per-SHA entity key: repository + PR + exact head SHA (dedupes retries/concurrency). */
export function rereviewRevisionExternalId(repository: string, prNumber: number, sha: string): string {
  return `rereview-issue:${repository.toLowerCase()}:${prNumber}:${normalizeSha(sha)}`;
}

/** Idempotency key for REQUEST_CHANGES publication: repo + PR + SHA + verdict. */
export function rereviewPublicationExternalId(
  repository: string,
  prNumber: number,
  sha: string,
  verdict: string,
): string {
  return `rereview-publication:${repository.toLowerCase()}:${prNumber}:${normalizeSha(sha)}:${verdict}`;
}

/**
 * Render the per-SHA review issue description. The issue is created with the
 * steward as assignee, so the Runtime's existing issue-creation/assignment
 * review path is the execution trigger — no direct agent invoke and no
 * Runtime invoke-context extension is used.
 */
export function buildReviewIssueDescription(input: {
  repository: string;
  prNumber: number;
  headSha: string;
}): string {
  return [
    `Review the exact PR head \`${input.headSha}\` of ${input.repository}#${input.prNumber}.`,
    "",
    `Full head: \`${input.headSha}\``,
  ].join("\n");
}

/**
 * Mirror a GitHub comment into a Papercompany comment body. Bridge-origin
 * comments (containing any bridge marker) are never re-mirrored, which
 * prevents bridge-origin comment loops. The same rule guards the generic
 * bridge mirror so a GitHub comment is mirrored exactly once.
 */
export function isBridgeOrigin(body: string): boolean {
  return body.includes("<!-- papercompany-github-bridge");
}

export function buildMirroredComment(change: GitHubChange): string | null {
  if (!change.comment) return null;
  if (isBridgeOrigin(change.comment.body)) return null;
  return [
    SOURCE_MARKER,
    `GitHub comment by @${change.comment.author || "unknown"}`,
    change.comment.url,
    "",
    change.comment.body,
  ].join("\n");
}
