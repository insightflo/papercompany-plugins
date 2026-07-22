# GitHub Repository Bridge

GitHub webhook intake for repository-scoped Papercompany work.

The first release runs in shadow mode. It verifies GitHub signatures, rejects
repositories outside the configured allowlist, deduplicates deliveries, and
creates or updates one durable Papercompany Issue for each GitHub Issue or pull
request. It records the explicit Papercompany project workspace and steward in
the plugin-owned link entity and on the linked Issue.

## Configuration

```json
{
  "webhookSecretRef": "INFLO_GITHUB_WEBHOOK_SECRET",
  "shadowMode": true,
  "repositories": [
    {
      "repository": "insightflo/papercompany-runtime",
      "companyId": "<inflo-company-id>",
      "projectId": "<papercompany-platform-project-id>",
      "projectWorkspaceId": "<runtime-workspace-id>",
      "stewardAgentId": "<runtime-steward-agent-id>",
      "deployApprovals": {
        "branch": "main",
        "requiredChecks": ["verify"],
        "approvalTitle": "Deploy Runtime main to A1",
        "dispatch": {
          "endpointRef": "INFLO_OPERATIONS_DISPATCH_URL",
          "eventType": "papercompany-deploy-a1-approved",
          "githubApp": {
            "appIdRef": "INFLO_GITHUB_APP_ID",
            "privateKeyRef": "INFLO_GITHUB_APP_PRIVATE_KEY",
            "installationRepository": "insightflo/papercompany-operations"
          }
        }
      }
    }
  ]
}
```

Configure the GitHub App webhook URL as:

```text
POST /api/plugins/insightflo.github-repository-bridge/webhooks/github
```

The `webhookSecretRef` is a Papercompany secret reference, not the resolved
secret value. Resolved secrets are never written to plugin state or logs.

The preferred dispatch authentication is `githubApp`. The plugin signs a
short-lived App JWT, discovers the installation for `installationRepository`,
and mints a fresh installation token for each dispatch attempt. The App ID and
private key stay in Papercompany secrets. Existing `tokenRef` configurations
remain supported for compatibility, but `tokenRef` and `githubApp` cannot be
configured together.

Deploy approval tracking accepts either a branch `push` delivery or a GitHub
check delivery carrying the configured branch and exact commit. This keeps the
gate working for GitHub App installations that emit check events but do not
subscribe to push events.

## Current safety boundary

- Outbound GitHub comments, branch creation, closing, and merging are disabled.
- The plugin requests Human Operator approval and dispatches only the exact
  approved commit; environment-specific deployment remains in Operations.
- Only configured `owner/name` repositories are accepted.
- New comments and pull-request revisions update and wake the existing linked
  Papercompany Issue instead of creating duplicates.

## Verification

```bash
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @insightflo/paperclip-github-repository-bridge test
pnpm --filter @insightflo/paperclip-github-repository-bridge typecheck
pnpm --filter @insightflo/paperclip-github-repository-bridge build
```
