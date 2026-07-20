import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { requireBridgeConfig, type GitHubRepositoryRoute } from "./config.js";
import { parseGitHubDelivery, type GitHubChange } from "./delivery.js";
import { verifyGitHubSignature } from "./signature.js";

const DELIVERY_ENTITY = "github-delivery";
const LINK_ENTITY = "github-object-link";
const SOURCE_MARKER = "<!-- papercompany-github-bridge:source=github -->";

function header(input: PluginWebhookInput, name: string): string | undefined {
  const found = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function repositoryFromPayload(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const repository = (value as Record<string, unknown>).repository;
  if (!repository || typeof repository !== "object") return "";
  const fullName = (repository as Record<string, unknown>).full_name;
  return typeof fullName === "string" ? fullName.toLowerCase() : "";
}

function renderDescription(change: GitHubChange, route: GitHubRepositoryRoute): string {
  const kind = change.objectKind === "pull" ? "Pull request" : "Issue";
  return [
    SOURCE_MARKER,
    `${kind} imported from GitHub.`,
    "",
    `- Repository: ${change.repository}`,
    `- Number: #${change.objectNumber}`,
    `- Workspace: ${route.projectWorkspaceId}`,
    `- State: ${change.state || "unknown"}`,
    `- Revision: ${change.revision || "unknown"}`,
    `- URL: ${change.url}`,
    "",
    change.body || "(No description provided.)",
  ].join("\n");
}

function issueStatus(change: GitHubChange): "todo" | "done" {
  return change.action === "closed" || change.state === "closed" ? "done" : "todo";
}

function mirrorComment(change: GitHubChange): string | null {
  if (change.comment) {
    if (change.comment.body.includes("<!-- papercompany-github-bridge")) return null;
    return [
      SOURCE_MARKER,
      `GitHub comment by @${change.comment.author || "unknown"}`,
      change.comment.url,
      "",
      change.comment.body,
    ].join("\n");
  }
  if (!change.title.startsWith("Check:") && !change.title.startsWith("Workflow:")) return null;
  return [SOURCE_MARKER, `${change.title}: ${change.state || "unknown"}`, change.url].join("\n");
}

async function deliveryAlreadyHandled(ctx: PluginContext, deliveryId: string): Promise<boolean> {
  return (await ctx.entities.list({ entityType: DELIVERY_ENTITY, externalId: deliveryId, limit: 1 })).length > 0;
}

async function recordDelivery(
  ctx: PluginContext,
  deliveryId: string,
  status: "processed" | "ignored",
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.entities.upsert({
    entityType: DELIVERY_ENTITY,
    scopeKind: "instance",
    externalId: deliveryId,
    status,
    data,
  });
}

async function wakeExistingSteward(ctx: PluginContext, route: GitHubRepositoryRoute, change: GitHubChange): Promise<void> {
  const agent = await ctx.agents.get(route.stewardAgentId, route.companyId);
  if (!agent) return;
  try {
    await ctx.agents.invoke(route.stewardAgentId, route.companyId, {
      reason: "github_delivery",
      prompt: `GitHub ${change.action} event received for ${change.repository} ${change.externalKey}. Review the linked Papercompany issue.`,
    });
  } catch (error) {
    ctx.logger.warn("GitHub delivery was stored but the repository steward wake failed", {
      repository: change.repository,
      stewardAgentId: route.stewardAgentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createLinkedIssue(ctx: PluginContext, route: GitHubRepositoryRoute, change: GitHubChange) {
  const issue = await ctx.issues.create({
    companyId: route.companyId,
    projectId: route.projectId,
    title: `[${change.repository} #${change.objectNumber}] ${change.title}`,
    description: renderDescription(change, route),
    status: issueStatus(change),
    priority: "medium",
    assigneeAgentId: route.stewardAgentId,
  });
  const workspacePatch: Parameters<PluginContext["issues"]["update"]>[1] & { projectWorkspaceId: string } = {
    projectWorkspaceId: route.projectWorkspaceId,
  };
  return ctx.issues.update(issue.id, workspacePatch, route.companyId);
}

export async function processGitHubWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  if (input.endpointKey !== "github") throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
  const config = requireBridgeConfig(await ctx.config.get());
  const secret = await ctx.secrets.resolve(config.webhookSecretRef);
  if (!verifyGitHubSignature(input.rawBody, header(input, "x-hub-signature-256"), secret)) {
    throw new Error("Invalid GitHub webhook signature");
  }
  const deliveryId = header(input, "x-github-delivery")?.trim();
  const eventName = header(input, "x-github-event")?.trim();
  if (!deliveryId || !eventName) throw new Error("GitHub webhook headers are incomplete");
  if (await deliveryAlreadyHandled(ctx, deliveryId)) return;

  const payload = input.parsedBody ?? JSON.parse(input.rawBody);
  const repository = repositoryFromPayload(payload);
  const change = parseGitHubDelivery(eventName, payload);
  if (!change) {
    await recordDelivery(ctx, deliveryId, "ignored", { eventName, repository });
    return;
  }
  const route = config.repositories.find((candidate) => candidate.repository === repository);
  if (!route) throw new Error(`GitHub repository is outside the allowlist: ${repository || "unknown"}`);

  const linkExternalId = `${change.repository}:${change.externalKey}`;
  const [link] = await ctx.entities.list({ entityType: LINK_ENTITY, externalId: linkExternalId, limit: 1 });
  let issueId = typeof link?.data.issueId === "string" ? link.data.issueId : "";
  const existing = issueId ? await ctx.issues.get(issueId, route.companyId) : null;
  if (link && !existing) throw new Error(`GitHub mapping conflict for ${linkExternalId}`);

  if (!existing) {
    const issue = await createLinkedIssue(ctx, route, change);
    issueId = issue.id;
  } else {
    const isObjectEvent = eventName === "issues" || eventName === "pull_request";
    await ctx.issues.update(issueId, {
      ...(isObjectEvent ? {
        title: `[${change.repository} #${change.objectNumber}] ${change.title}`,
        description: renderDescription(change, route),
      } : {}),
      ...(change.action === "closed" || change.action === "reopened" ? { status: issueStatus(change) } : {}),
    }, route.companyId);
    await wakeExistingSteward(ctx, route, change);
  }
  const comment = mirrorComment(change);
  if (comment) await ctx.issues.createComment(issueId, comment, route.companyId);

  await ctx.entities.upsert({
    entityType: LINK_ENTITY,
    scopeKind: "project_workspace",
    scopeId: route.projectWorkspaceId,
    externalId: linkExternalId,
    title: `${change.repository} ${change.externalKey}`,
    status: change.state || change.action,
    data: {
      issueId,
      repository: change.repository,
      objectKind: change.objectKind,
      objectNumber: change.objectNumber,
      projectId: route.projectId,
      projectWorkspaceId: route.projectWorkspaceId,
      stewardAgentId: route.stewardAgentId,
      revision: change.revision,
      url: change.url,
      shadowMode: config.shadowMode,
    },
  });
  await recordDelivery(ctx, deliveryId, "processed", { eventName, repository, issueId, linkExternalId });
  await ctx.activity.log({
    companyId: route.companyId,
    message: `Processed GitHub ${eventName}.${change.action} for ${linkExternalId}`,
    entityType: "issue",
    entityId: issueId,
    metadata: { deliveryId, projectWorkspaceId: route.projectWorkspaceId, shadowMode: config.shadowMode },
  });
}
