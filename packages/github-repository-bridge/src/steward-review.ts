/**
 * Authenticated steward review-result endpoint for the structured re-review
 * loop. The webhook entrypoint verifies the shared-secret HMAC, parses the
 * structured verdict, and delegates to `acceptStewardReviewResult` in
 * `rereview-bridge.ts`. Kept as a focused module so the generic merge-approval
 * endpoint in `merge-approvals.ts` stays untouched.
 */
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { requireBridgeConfig } from "./config.js";
import { verifyHmacSignature } from "./signature.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function webhookHeader(input: PluginWebhookInput, name: string): string | undefined {
  const found = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export interface StewardReviewResult {
  repository: string;
  prNumber: number;
  headSha: string;
  verdict: "pass" | "request_changes";
  issueId: string;
  evidence?: unknown;
}

/**
 * Parse a structured steward review-result. Fail-closed: BOTH PASS and
 * REQUEST_CHANGES require the exact 40-char head SHA AND the exact review
 * issueId. A missing or blank issueId (or any other incomplete field) is
 * rejected — never accepted with a fallback.
 */
export function parseStewardReviewResult(value: unknown): StewardReviewResult | null {
  const raw = asRecord(value);
  const repository = asString(raw.repository ?? raw.repo).toLowerCase();
  const prNumber = asNumber(raw.prNumber ?? raw.pullRequestNumber ?? raw.pr);
  const headSha = asString(raw.headSha ?? raw.sha ?? raw.head).toLowerCase();
  const verdict = asString(raw.verdict ?? raw.decision).toLowerCase();
  const issueId = asString(raw.issueId ?? raw.linkedIssueId);
  if (
    !repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) ||
    !prNumber || !/^[0-9a-f]{40}$/.test(headSha) ||
    (verdict !== "pass" && verdict !== "request_changes") ||
    !issueId
  ) {
    return null;
  }
  return {
    repository,
    prNumber,
    headSha,
    verdict: verdict as "pass" | "request_changes",
    issueId,
    evidence: raw.evidence ?? raw.reviewEvidence ?? null,
  };
}

/**
 * Handle a steward review-result delivery on the `steward-review-result`
 * endpoint. Authenticated with the same shared secret as the merge endpoint.
 * A PASS continues through the exact-SHA merge approval path; REQUEST_CHANGES
 * posts/updates evidence on the GitHub PR through the configured GitHub App.
 * A stale verdict (older than the tracked revision) is rejected.
 */
export async function processStewardReviewResult(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  if (input.endpointKey !== "steward-review-result") {
    throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
  }
  const config = requireBridgeConfig(await ctx.config.get());
  if (!config.stewardApiSecretRef) throw new Error("steward review API is not configured (stewardApiSecretRef missing)");
  const secret = await ctx.secrets.resolve(config.stewardApiSecretRef);
  if (!verifyHmacSignature(input.rawBody, webhookHeader(input, "x-pc-signature-256"), secret)) {
    throw new Error("Invalid steward review-result signature");
  }
  const request = parseStewardReviewResult(input.parsedBody ?? JSON.parse(input.rawBody));
  if (!request) throw new Error("steward review-result body is incomplete");
  const { acceptStewardReviewResult } = await import("./rereview-bridge.js");
  const outcome = await acceptStewardReviewResult(ctx, config, request);
  if (!outcome.accepted) {
    throw new Error(`steward review-result rejected: ${outcome.reason}`);
  }
}
