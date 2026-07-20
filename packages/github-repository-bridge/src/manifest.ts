import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "insightflo.github-repository-bridge",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Repository Bridge",
  description: "Routes allowlisted GitHub work into repository-scoped Papercompany issues.",
  author: "InsightFlo",
  categories: ["automation", "connector"],
  capabilities: [
    "webhooks.receive",
    "secrets.read-ref",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "projects.read",
    "project.workspaces.read",
    "agents.read",
    "agents.invoke",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Webhook",
      description: "Receives allowlisted GitHub Issue, pull request, review, and check events.",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      webhookSecretRef: {
        type: "string",
        title: "Webhook secret reference",
        description: "Papercompany secret reference containing the GitHub App webhook secret.",
      },
      shadowMode: {
        type: "boolean",
        title: "Shadow mode",
        description: "Keep outbound GitHub mutations disabled while validating intake.",
        default: true,
      },
      repositories: {
        type: "array",
        title: "Repository routes",
        items: {
          type: "object",
          properties: {
            repository: { type: "string", description: "Lowercase owner/name allowlist entry." },
            companyId: { type: "string" },
            projectId: { type: "string" },
            projectWorkspaceId: { type: "string" },
            stewardAgentId: { type: "string" },
          },
          required: ["repository", "companyId", "projectId", "projectWorkspaceId", "stewardAgentId"],
        },
      },
    },
    required: ["webhookSecretRef", "repositories"],
  },
};

export default manifest;
