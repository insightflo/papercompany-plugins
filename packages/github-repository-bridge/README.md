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

The bridge implements a structured re-review loop for PRs on a `mergeApprovals`
route:

- **New issue per new head**: a genuinely new PR head SHA, after the
  authoritative complete required-check set for that exact head passes, creates
  exactly one NEW Papercompany review issue with the steward as assignee. The
  initial PR review reuses the normal linked issue; every later head gets its
  own issue. Issue creation/assignment is the existing execution trigger — the
  bridge never calls `agents.invoke` and never passes Runtime invoke context.
- **Never revive terminal issues**: a blocked/done/cancelled/closed issue (for
  example an earlier REQUEST_CHANGES, including ones predating per-SHA state)
  is never revived or reused as a review target; a new head gets a NEW issue.
- **Exact-head authority**: `pull_request.synchronize` with a new exact 40-char
  head SHA is the structured authority that advances the revision. A
  `check_run` / `workflow_run` delivery never decides on its own: every check
  delivery for the tracked head refetches the authoritative FULL check-run set
  for that exact SHA through the GitHub App, then evaluates all required
  checks. Eligibility is never completed by combining recorded webhook
  conclusions alone.
- **Deduplicated trigger**: the review is triggered at most once per
  repository+PR+exact SHA, so synchronize/check webhook retries and concurrent
  deliveries create exactly one issue per head. Concurrency safety: the Runtime
  runs exactly one worker process per installed plugin, and the SDK dispatches
  inbound webhook RPCs concurrently inside that worker, so the intake
  serializes all deliveries for the same repository+PR through an in-process
  promise mutex (the load→decide→create→record critical section is atomic);
  after a worker restart the persisted per-SHA revision record dedupes.
- **Comment mirroring**: GitHub comments are mirrored to the review issue
  exactly once and are never parsed as execution authority; bridge-origin
  comments are never re-mirrored (no comment loops).
- **Stale-verdict rejection**: a steward verdict is fail-closed — it requires
  the exact tracked head AND the exact linked issueId recorded for that
  revision; a stale verdict is rejected and never mutates GitHub.

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
  "issueId": "<exact review issue id recorded for that head (required for both verdicts)>",
  "evidence": { "summary": "...", "notes": [...] }
}
```

- `verdict: "pass"` continues through the exact-SHA merge approval path
  (identical to `steward-merge-request`).
- `verdict: "request_changes"` posts/updates the evidence on the GitHub PR
  through the configured GitHub App (`POST /issues/{pr}/comments` with the
  steward evidence), idempotently per repository+PR+SHA+verdict, then blocks
  the exact review issue. The blocked issue stays terminal and is never
  revived.
- Fail-closed: BOTH verdicts require the exact 40-char `headSha` AND the exact
  `issueId` of the review issue recorded for that revision. A missing/blank
  `issueId` or a stale verdict (older head, or an issueId that does not match
  the revision's recorded issue) is rejected at the endpoint with no GitHub
  side effect.

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
