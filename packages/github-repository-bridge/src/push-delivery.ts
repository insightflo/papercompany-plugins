/**
 * Deploy-path delivery parsing for the GitHub bridge.
 *
 * These parsers are intentionally separate from `delivery.ts` (which handles
 * issue / pull-request mirroring). They extract the commit identity needed for
 * approval-driven deployment: a `push` to a branch, and the `check_run` /
 * `workflow_run` conclusions that gate whether a commit's approval may be
 * created. No A1 / host / operator-specific value lives here — only generic
 * GitHub webhook fields.
 */
export interface PushDelivery {
  repository: string;
  ref: string;
  branch: string;
  before: string;
  after: string;
  commitMessage: string;
  commitAuthor: string;
  url: string;
}

export interface CommitCheck {
  repository: string;
  branch: string;
  sha: string;
  name: string;
  status: string;
  conclusion: string;
  url: string;
  source: "check_run" | "workflow_run";
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function repositoryName(payload: JsonRecord): string {
  return asString(asRecord(payload.repository).full_name).toLowerCase();
}

/** Convert a GitHub ref like `refs/heads/main` into the bare branch name. */
export function branchFromRef(ref: string): string {
  const match = /refs\/heads\/(.+)$/.exec(ref);
  return match ? match[1]! : "";
}

/**
 * Parse a `push` webhook payload into a deploy-relevant delivery.
 * Returns null when required commit identity is missing.
 */
export function parsePush(value: unknown): PushDelivery | null {
  const payload = asRecord(value);
  const repository = repositoryName(payload);
  const ref = asString(payload.ref);
  const branch = branchFromRef(ref);
  const after = asString(payload.after);
  // A zero / empty `after` indicates a branch deletion — never deployable.
  if (!repository || !branch || !after || /^[0]+$/.test(after)) return null;
  const headCommit = asRecord(payload.head_commit);
  const author = asRecord(headCommit.author);
  return {
    repository,
    ref,
    branch,
    before: asString(payload.before),
    after,
    commitMessage: asString(headCommit.message),
    commitAuthor: asString(author.name) || asString(asRecord(payload.pusher).name),
    url: asString(headCommit.url),
  };
}

function parseCheckRun(payload: JsonRecord): CommitCheck | null {
  const check = asRecord(payload.check_run);
  const suite = asRecord(check.check_suite);
  const sha = asString(check.head_sha);
  const repository = repositoryName(payload);
  const name = asString(check.name);
  if (!sha || !repository || !name) return null;
  return {
    repository,
    branch: asString(suite.head_branch),
    sha,
    name,
    status: asString(check.status),
    conclusion: asString(check.conclusion),
    url: asString(check.html_url),
    source: "check_run",
  };
}

function parseWorkflowRun(payload: JsonRecord): CommitCheck | null {
  const run = asRecord(payload.workflow_run);
  const sha = asString(run.head_sha);
  const repository = repositoryName(payload);
  const name = asString(run.name);
  if (!sha || !repository || !name) return null;
  return {
    repository,
    branch: asString(run.head_branch),
    sha,
    name,
    status: asString(run.status),
    conclusion: asString(run.conclusion),
    url: asString(run.html_url),
    source: "workflow_run",
  };
}

/**
 * Parse a check_run / workflow_run delivery keyed by the exact commit SHA,
 * independent of any pull request. Used to gate deploy approvals.
 */
export function parseCommitCheck(eventName: string, value: unknown): CommitCheck | null {
  const payload = asRecord(value);
  if (eventName === "check_run") return parseCheckRun(payload);
  if (eventName === "workflow_run") return parseWorkflowRun(payload);
  return null;
}
