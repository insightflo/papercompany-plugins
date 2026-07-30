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
  "stewardApiSecretRef": "INFLO_STEWARD_MERGE_SECRET",
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
      "mergeApprovals": {
        "baseBranch": "main",
        "requiredChecks": ["verify"],
        "approvalTitle": "Merge PR into main",
        "githubApp": {
          "appIdRef": "INFLO_GITHUB_APP_ID",
          "privateKeyRef": "INFLO_GITHUB_APP_PRIVATE_KEY",
          "installationRepository": "insightflo/papercompany-runtime"
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

## Steward PASS → PR squash merge

When a Runtime repository steward finishes review with a PASS it calls the
plugin-owned, authenticated internal API to request a Human Operator merge
approval:

```text
POST /api/plugins/insightflo.github-repository-bridge/webhooks/steward-merge-request
```

The request MUST be authenticated with an HMAC-SHA256 signature over the raw
body, using the shared secret resolved from `stewardApiSecretRef`:

```text
x-pc-signature-256: sha256=<hex HMAC-SHA256(rawBody, stewardSecret)>
```

Unsigned requests or requests whose signature does not match are rejected; no
mutation is performed. The JSON body is:

```json
{
  "repository": "insightflo/papercompany-runtime",
  "prNumber": 42,
  "headSha": "<exact 40-char pull-request head SHA>",
  "issueId": "<linked Papercompany issue id>",
  "reviewEvidence": { "verdict": "pass", "reviewer": "<steward>", "summary": "..." }
}
```

The plugin fail-closed revalidates the exact PR revision before creating any
approval: the repository is allowlisted and has `mergeApprovals` configured, the
PR is open and non-draft, its base is `baseBranch`, the live head still matches
`headSha`, it is mergeable, every `requiredChecks` succeeded for that exact SHA,
and there is no superseding request. A repeated PASS for the same PR+SHA is
idempotent; a PASS for an older head supersedes any stored request for that PR.
On success the plugin creates one Human Operator approval (`payload.kind =
"merge"`), distinct from a deployment approval.

On an approved merge approval the plugin revalidates the exact head and gates
again and then performs a single squash merge through the GitHub App:

```text
PUT /repos/{owner}/{repo}/pulls/{pr}   { "sha": "<headSha>", "merge_method": "squash" }
```

The `sha` pins the exact revision, so GitHub itself rejects a merge if the head
moved. Rejected, superseded, closed, non-mergeable, check-failing, and
changed-head approvals never merge. The merge runs through the retryable merge
outbox (`github-merge-dispatch`) with bounded retries, mirroring the deploy
dispatch outbox; a terminal gate failure is never retried.

### GitHub App permissions for merge

The `mergeApprovals.githubApp` App must be installed on the PR's repository
(`installationRepository`) with:

- **Pull requests: Read & Write** (read PR state, perform the squash merge)
- **Checks: Read** (read check-run status for the exact head SHA)
- **Contents: Read** (read repository/commit contents as applicable)
- **Metadata: Read** (required by GitHub for all App access)

The plugin mints a fresh installation token per operation via a short-lived App
JWT, exactly as for deploy dispatch.

## Current safety boundary

- Shadow mode blocks unprompted outbound GitHub mutations. Both the deploy
  dispatch and the PR squash merge are Human-Operator-approval-gated outbound
  actions, so they proceed when approved; GitHub comments, branch creation, and
  closing remain disabled.
- Deployment: the plugin requests Human Operator approval and dispatches only
  the exact approved commit; environment-specific deployment stays in Operations.
- Merge: the plugin requests a separate Human Operator approval and squash-merges
  only the exact approved PR head; nothing merges without the explicit approval.
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
