import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_PARAMS_SNAPSHOT_CHARS } from "./constants.js";
import type { PcBridgeConfig } from "./config.js";
import type { BridgeDispatchResult } from "./bridge.js";
import type { ValidatedDispatchRequest } from "./validate.js";

export type DispatchSource = "tool" | "ui" | "webhook";

export type DispatchHistoryEntry = {
  id: string;
  requestedAt: string;
  source: DispatchSource;
  handler: string;
  /** Compact JSON snapshot of the dispatched params, capped in length. */
  paramsSnapshot: string;
  ok: boolean;
  httpStatus: number | null;
  /** Best-effort extraction of common result fields (present for naver-publish, optional otherwise). */
  permalink: string | null;
  title: string | null;
  imageCount: number | null;
  error: string | null;
  message: string | null;
  durationMs: number;
};

export type DispatchOutcome = {
  entry: DispatchHistoryEntry;
  result: BridgeDispatchResult;
};

const HISTORY_STATE_KEY = { scopeKind: "instance", stateKey: "dispatch-history" } as const;
// Upper bound read when rewriting history so a lowered historyLimit trims
// older entries on the next write.
const MAX_STORED = 500;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function snapshotParams(params: Record<string, unknown>): string {
  let snapshot: string;
  try {
    snapshot = JSON.stringify(params);
  } catch {
    snapshot = String(params);
  }

  if (snapshot === undefined || snapshot === null) {
    return "";
  }

  return snapshot.length > MAX_PARAMS_SNAPSHOT_CHARS
    ? `${snapshot.slice(0, MAX_PARAMS_SNAPSHOT_CHARS)}…`
    : snapshot;
}

export async function listDispatchHistory(
  ctx: PluginContext,
  limit: number,
): Promise<DispatchHistoryEntry[]> {
  const stored = await ctx.state.get(HISTORY_STATE_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }

  return stored
    .filter((item): item is DispatchHistoryEntry => Boolean(item) && typeof item === "object")
    .slice(0, Math.max(1, limit));
}

export function buildDispatchHistoryEntry(args: {
  source: DispatchSource;
  request: ValidatedDispatchRequest;
  result: BridgeDispatchResult;
  durationMs: number;
}): DispatchHistoryEntry {
  const body = args.result.body;

  return {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    source: args.source,
    handler: args.request.handler,
    paramsSnapshot: snapshotParams(args.request.params),
    ok: args.result.ok,
    httpStatus: args.result.httpStatus,
    permalink: asString(body?.url),
    title: asString(body?.title),
    imageCount: asNumberOrNull(body?.image_count),
    error: args.result.error ?? asString(body?.error),
    message: asString(body?.message),
    durationMs: args.durationMs,
  };
}

export async function recordDispatchHistory(
  ctx: PluginContext,
  config: PcBridgeConfig,
  entry: DispatchHistoryEntry,
): Promise<void> {
  const existing = await listDispatchHistory(ctx, MAX_STORED);
  const next = [entry, ...existing].slice(0, Math.max(1, config.historyLimit));
  await ctx.state.set(HISTORY_STATE_KEY, next);
}
