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
      "stewardAgentId": "<runtime-steward-agent-id>"
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

## Current safety boundary

- Outbound GitHub comments, branch creation, closing, and merging are disabled.
- Production deployment is not part of this plugin.
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
