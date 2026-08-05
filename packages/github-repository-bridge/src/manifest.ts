import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "insightflo.github-repository-bridge",
  apiVersion: 1,
  version: "0.3.0",
  displayName: "GitHub Repository Bridge",
  description: "Routes allowlisted GitHub work into Papercompany issues and creates Human Operator approvals for both deployment (main-check) and steward-PASS PR squash merge.",
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
    "approvals.create",
    "events.subscribe",
    "http.outbound",
    "jobs.schedule",
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
    {
      endpointKey: "steward-merge-request",
      displayName: "Steward Merge Request",
      description: "Authenticated internal API a repository steward calls with a PASS verdict to request a Human Operator PR squash-merge approval.",
    },
    {
      endpointKey: "steward-review-result",
      displayName: "Steward Review Result",
      description: "Authenticated internal API a repository steward calls with a structured PASS or REQUEST_CHANGES verdict; PASS routes to the merge approval, REQUEST_CHANGES posts evidence on the PR.",
    },
  ],
  jobs: [
    {
      jobKey: "drain-dispatch-outbox",
      displayName: "Drain dispatch outbox",
      description: "Retries pending repository_dispatch deliveries for approved deploy commits.",
      schedule: "*/2 * * * *",
    },
    {
      jobKey: "drain-merge-outbox",
      displayName: "Drain squash-merge outbox",
      description: "Revalidates the exact PR head and performs approved squash merges with bounded retries.",
      schedule: "*/2 * * * *",
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
      stewardApiSecretRef: {
        type: "string",
        title: "Steward merge API secret reference",
        description: "Papercompany secret reference used to HMAC-sign the steward merge-request endpoint. Required when any repository configures mergeApprovals.",
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
            deployApprovals: {
              type: "object",
              description: "Optional: create a Human Operator approval once the exact commit on this branch passes every required check.",
              properties: {
                branch: { type: "string", description: "Branch that triggers an approval (e.g. main)." },
                requiredChecks: { type: "array", items: { type: "string" }, description: "Check names that must succeed for the exact SHA." },
                approvalTitle: { type: "string" },
                dispatch: {
                  type: "object",
                  properties: {
                    endpointRef: { type: "string", description: "Secret reference resolving to the repository_dispatch URL." },
                    tokenRef: { type: "string", description: "Secret reference resolving to the dispatch bearer token." },
                    githubApp: {
                      type: "object",
                      description: "Preferred: mint a short-lived installation token for every dispatch.",
                      properties: {
                        appIdRef: { type: "string", description: "Secret reference resolving to the GitHub App ID." },
                        privateKeyRef: { type: "string", description: "Secret reference resolving to the GitHub App private key." },
                        installationRepository: { type: "string", description: "Repository whose App installation receives the dispatch, in owner/name format." },
                      },
                      required: ["appIdRef", "privateKeyRef", "installationRepository"],
                    },
                    eventType: { type: "string", description: "repository_dispatch event_type." },
                  },
                  required: ["endpointRef", "eventType"],
                },
              },
              required: ["branch", "requiredChecks", "approvalTitle", "dispatch"],
            },
            mergeApprovals: {
              type: "object",
              description: "Optional: create a Human Operator approval to squash-merge a pull request after a repository steward PASS, then perform the exact-revision squash merge via the GitHub App.",
              properties: {
                baseBranch: { type: "string", description: "PR base branch eligible for the squash-merge approval (e.g. main)." },
                requiredChecks: { type: "array", items: { type: "string" }, description: "PR check names that must succeed for the exact head SHA." },
                approvalTitle: { type: "string" },
                githubApp: {
                  type: "object",
                  description: "GitHub App credentials used to read PR state and perform the squash merge.",
                  properties: {
                    appIdRef: { type: "string", description: "Secret reference resolving to the GitHub App ID." },
                    privateKeyRef: { type: "string", description: "Secret reference resolving to the GitHub App private key." },
                    installationRepository: { type: "string", description: "Repository hosting the pull request, where the App is installed, in owner/name format." },
                  },
                  required: ["appIdRef", "privateKeyRef", "installationRepository"],
                },
              },
              required: ["baseBranch", "requiredChecks", "approvalTitle", "githubApp"],
            },
          },
          required: ["repository", "companyId", "projectId", "projectWorkspaceId", "stewardAgentId"],
        },
      },
    },
    required: ["webhookSecretRef", "repositories"],
  },
};

export default manifest;
