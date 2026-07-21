import type { PluginConfigValidationResult } from "@paperclipai/plugin-sdk";

export interface GitHubRepositoryRoute {
  repository: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string;
  stewardAgentId: string;
  deployApprovals?: DeployApprovalsConfig | undefined;
}
export interface DispatchTarget {
  endpointRef: string;
  tokenRef: string;
  eventType: string;
}

export interface DeployApprovalsConfig {
  branch: string;
  requiredChecks: string[];
  approvalTitle: string;
  dispatch: DispatchTarget;
}

export interface GitHubBridgeConfig {
  webhookSecretRef: string;
  shadowMode: boolean;
  repositories: GitHubRepositoryRoute[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDeployApprovals(value: unknown, index: number, errors: string[]): DeployApprovalsConfig | undefined {
  const raw = asRecord(value);
  const branch = asString(raw.branch);
  const rawChecks = Array.isArray(raw.requiredChecks) ? raw.requiredChecks : [];
  const requiredChecks = rawChecks.map((c) => asString(c)).filter((c) => c.length > 0);
  const approvalTitle = asString(raw.approvalTitle);
  const dispatchRaw = asRecord(raw.dispatch);
  const dispatch = {
    endpointRef: asString(dispatchRaw.endpointRef),
    tokenRef: asString(dispatchRaw.tokenRef),
    eventType: asString(dispatchRaw.eventType),
  };
  const prefix = `repositories[${index}].deployApprovals`;
  if (!branch) errors.push(`${prefix}.branch is required`);
  if (requiredChecks.length === 0) errors.push(`${prefix}.requiredChecks must list at least one check`);
  if (!approvalTitle) errors.push(`${prefix}.approvalTitle is required`);
  if (!dispatch.endpointRef) errors.push(`${prefix}.dispatch.endpointRef is required`);
  if (!dispatch.tokenRef) errors.push(`${prefix}.dispatch.tokenRef is required`);
  if (!dispatch.eventType) errors.push(`${prefix}.dispatch.eventType is required`);
  const hasError = errors.some((message) => message.startsWith(prefix));
  return hasError ? undefined : { branch, requiredChecks, approvalTitle, dispatch };
}

function parseRoute(value: unknown, index: number, errors: string[]): GitHubRepositoryRoute | null {
  const raw = asRecord(value);
  const route: GitHubRepositoryRoute = {
    repository: asString(raw.repository).toLowerCase(),
    companyId: asString(raw.companyId),
    projectId: asString(raw.projectId),
    projectWorkspaceId: asString(raw.projectWorkspaceId),
    stewardAgentId: asString(raw.stewardAgentId),
  };
  if (!/^[^/\s]+\/[^/\s]+$/.test(route.repository)) {
    errors.push(`repositories[${index}].repository must use owner/name format`);
  }
  for (const key of ["companyId", "projectId", "projectWorkspaceId", "stewardAgentId"] as const) {
    if (!route[key]) errors.push(`repositories[${index}].${key} is required`);
  }
  const deployApprovals = raw.deployApprovals === undefined
    ? undefined
    : parseDeployApprovals(raw.deployApprovals, index, errors);
  if (deployApprovals) route.deployApprovals = deployApprovals;
  return errors.some((message) => message.startsWith(`repositories[${index}]`)) ? null : route;
}

export function readBridgeConfig(value: unknown): { config: GitHubBridgeConfig | null; errors: string[] } {
  const raw = asRecord(value);
  const errors: string[] = [];
  const webhookSecretRef = asString(raw.webhookSecretRef);
  if (!webhookSecretRef) errors.push("webhookSecretRef is required");
  if (raw.shadowMode === false) errors.push("shadow mode must remain enabled until outbound GitHub actions are implemented");
  const rawRepositories = Array.isArray(raw.repositories) ? raw.repositories : [];
  if (rawRepositories.length === 0) errors.push("repositories must contain at least one route");
  const repositories = rawRepositories
    .map((route, index) => parseRoute(route, index, errors))
    .filter((route): route is GitHubRepositoryRoute => Boolean(route));
  const seen = new Set<string>();
  for (const route of repositories) {
    if (seen.has(route.repository)) errors.push(`duplicate repository route: ${route.repository}`);
    seen.add(route.repository);
  }
  return {
    config: errors.length === 0 ? {
      webhookSecretRef,
      shadowMode: raw.shadowMode !== false,
      repositories,
    } : null,
    errors,
  };
}

export function validateBridgeConfig(value: unknown): PluginConfigValidationResult {
  const { errors } = readBridgeConfig(value);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function requireBridgeConfig(value: unknown): GitHubBridgeConfig {
  const result = readBridgeConfig(value);
  if (!result.config) throw new Error(`Invalid GitHub bridge configuration: ${result.errors.join("; ")}`);
  return result.config;
}
