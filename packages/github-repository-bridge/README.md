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
PR is open, its base is `baseBranch`, the live head still matches `headSha`, it
is mergeable, every `requiredChecks` succeeded for that exact SHA, and there is
no superseding request. If draft status is the only remaining blocker, the
plugin marks the PR ready for review through the same GitHub App, then re-reads
the live PR and checks before creating the approval. A repeated PASS for the
same PR+SHA is idempotent; a PASS for an older head supersedes any stored request
for that PR. On success the plugin creates one Human Operator approval
(`payload.kind = "merge"`), distinct from a deployment approval.

## Structured re-review loop

The bridge implements a structured natural re-review loop for PRs on a
`mergeApprovals` route:

- **Same-issue reuse**: a new PR head reuses the existing linked Papercompany
  issue; a second issue is never created for a new head.
- **Comment-before-wake**: a GitHub comment is mirrored to the linked issue
  BEFORE any steward wake, and is never parsed as execution authority.
- **No check-event wake storm**: `check_run` / `workflow_run` deliveries never
  wake the steward directly; they only contribute required-check conclusions.
- **Exact-head authority**: `pull_request.synchronize` with a new exact 40-char
  head SHA (plus live required-check state for that SHA through the GitHub App)
  is the structured authority that advances the revision.
- **Latest-SHA coalescing**: repeated deliveries are coalesced by the latest
  head SHA; the steward is invoked exactly once per eligible revision.
- **Issue-linked wake**: when the latest revision is eligible, the bridge moves
  the same blocked issue back to reviewable state and invokes the steward
  exactly once with exact `issueId` / `commentId` / `taskKey` context via the
  Runtime wake contract, so the steward run is issue-linked (never an
  `issueId null` run).
- **Stale-verdict rejection**: a steward verdict whose head SHA is not the
  tracked woken revision is rejected; it never posts on GitHub or routes to a
  merge approval.

### Steward review-result endpoint

The structured, authenticated steward review-result path is:

```text
POST /api/plugins/insightflo.github-repository-bridge/webhooks/steward-review-result
```

Signed with the same `x-pc-signature-256` HMAC as the merge endpoint:

```json
{
  "repository": "insightflo/papercompany-runtime",
  "prNumber": 42,
  "headSha": "<exact 40-char pull-request head SHA>",
  "verdict": "pass | request_changes",
  "issueId": "<linked Papercompany issue id>",
  "evidence": { "summary": "...", "notes": [...] }
}
```

- `verdict: "pass"` continues through the exact-SHA merge approval path
  (identical to `steward-merge-request`).
- `verdict: "request_changes"` posts/updates the evidence on the GitHub PR
  through the configured GitHub App (`POST /issues/{pr}/comments` with the
  steward evidence), so REQUEST_CHANGES is visible on the PR.
- A stale verdict (head SHA older than the tracked revision) is rejected and
  never mutates GitHub.

## Structured re-review loop

The bridge implements a structured natural re-review loop for PRs on a
`mergeApprovals` route:

- **Same-issue reuse**: a new PR head reuses the existing linked Papercompany
  issue; a second issue is never created for a new head.
- **Comment-before-wake**: a GitHub comment is mirrored to the linked issue
  BEFORE any steward wake, and is never parsed as execution authority.
- **No check-event wake storm**: `check_run` / `workflow_run` deliveries never
  wake the steward directly; they only contribute required-check conclusions.
- **Exact-head authority**: `pull_request.synchronize` with a new exact 40-char
  head SHA (plus live required-check state for that SHA through the GitHub App)
  is the structured authority that advances the revision.
- **Latest-SHA coalescing**: repeated deliveries are coalesced by the latest
  head SHA; the steward is invoked exactly once per eligible revision.
- **Issue-linked wake**: when the latest revision is eligible, the bridge moves
  the same blocked issue back to reviewable state and invokes the steward
  exactly once with exact `issueId` / `commentId` / `taskKey` context via the
  Runtime wake contract, so the steward run is issue-linked (never an
  `issueId null` run).
- **Stale-verdict rejection**: a steward verdict whose head SHA is not the
  tracked woken revision is rejected; it never posts on GitHub or routes to a
  merge approval.

### Steward review-result endpoint

The structured, authenticated steward review-result path is:

```text
POST /api/plugins/insightflo.github-repository-bridge/webhooks/steward-review-result
```

Signed with the same `x-pc-signature-256` HMAC as the merge endpoint:

```json
{
  "repository": "insightflo/papercompany-runtime",
  "prNumber": 42,
  "headSha": "<exact 40-char pull-request head SHA>",
  "verdict": "pass | request_changes",
  "issueId": "<linked Papercompany issue id>",
  "evidence": { "summary": "...", "notes": [...] }
}
```

- `verdict: "pass"` continues through the exact-SHA merge approval path
  (identical to `steward-merge-request`).
- `verdict: "request_changes"` posts/updates the evidence on the GitHub PR
  through the configured GitHub App (`POST /issues/{pr}/comments` with the
  steward evidence), so REQUEST_CHANGES is visible on the PR.
- A stale verdict (head SHA older than the tracked revision) is rejected and
  never mutates GitHub.

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

- **Pull requests: Read & Write** (read PR state, mark an eligible draft ready, perform the squash merge)
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
