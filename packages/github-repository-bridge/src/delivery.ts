export type GitHubObjectKind = "issue" | "pull";

export interface GitHubCommentChange {
  id: string;
  author: string;
  body: string;
  url: string;
  updatedAt: string;
}

export interface GitHubChange {
  repository: string;
  objectKind: GitHubObjectKind;
  objectNumber: number;
  externalKey: string;
  action: string;
  title: string;
  body: string;
  state: string;
  url: string;
  revision: string;
  comment: GitHubCommentChange | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function repositoryName(payload: JsonRecord): string {
  return asString(asRecord(payload.repository).full_name).toLowerCase();
}

function readComment(value: unknown): GitHubCommentChange | null {
  const comment = asRecord(value);
  const id = comment.id;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return {
    id: String(id),
    author: asString(asRecord(comment.user).login),
    body: asString(comment.body),
    url: asString(comment.html_url),
    updatedAt: asString(comment.updated_at || comment.submitted_at),
  };
}

function objectChange(input: {
  payload: JsonRecord;
  object: JsonRecord;
  kind: GitHubObjectKind;
  number: number;
  comment?: GitHubCommentChange | null;
}): GitHubChange | null {
  const repository = repositoryName(input.payload);
  if (!repository) return null;
  const headSha = asString(asRecord(input.object.head).sha);
  return {
    repository,
    objectKind: input.kind,
    objectNumber: input.number,
    externalKey: `${input.kind}:${input.number}`,
    action: asString(input.payload.action),
    title: asString(input.object.title),
    body: asString(input.object.body),
    state: asString(input.object.state),
    url: asString(input.object.html_url),
    revision: headSha || asString(input.object.updated_at),
    comment: input.comment ?? null,
  };
}

function parseIssue(eventName: string, payload: JsonRecord): GitHubChange | null {
  const issue = asRecord(payload.issue);
  const number = asNumber(issue.number);
  if (!number) return null;
  const kind: GitHubObjectKind = issue.pull_request ? "pull" : "issue";
  const comment = eventName === "issue_comment" ? readComment(payload.comment) : null;
  return objectChange({ payload, object: issue, kind, number, comment });
}

function parsePullRequest(eventName: string, payload: JsonRecord): GitHubChange | null {
  const pull = asRecord(payload.pull_request);
  const number = asNumber(pull.number || payload.number);
  if (!number) return null;
  const commentSource = eventName === "pull_request_review" ? payload.review : payload.comment;
  return objectChange({
    payload,
    object: pull,
    kind: "pull",
    number,
    comment: eventName === "pull_request" ? null : readComment(commentSource),
  });
}

function parseCheckRun(payload: JsonRecord): GitHubChange | null {
  const check = asRecord(payload.check_run);
  const [pull] = Array.isArray(check.pull_requests) ? check.pull_requests : [];
  const number = asNumber(asRecord(pull).number);
  const repository = repositoryName(payload);
  if (!number || !repository) return null;
  return {
    repository,
    objectKind: "pull",
    objectNumber: number,
    externalKey: `pull:${number}`,
    action: asString(payload.action),
    title: `Check: ${asString(check.name)}`,
    body: "",
    state: asString(check.conclusion || check.status),
    url: asString(check.html_url),
    revision: asString(check.head_sha),
    comment: null,
  };
}

function parseWorkflowRun(payload: JsonRecord): GitHubChange | null {
  const run = asRecord(payload.workflow_run);
  const [pull] = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  const number = asNumber(asRecord(pull).number);
  const repository = repositoryName(payload);
  if (!number || !repository) return null;
  return {
    repository,
    objectKind: "pull",
    objectNumber: number,
    externalKey: `pull:${number}`,
    action: asString(payload.action),
    title: `Workflow: ${asString(run.name)}`,
    body: "",
    state: asString(run.conclusion || run.status),
    url: asString(run.html_url),
    revision: asString(run.head_sha),
    comment: null,
  };
}

export function parseGitHubDelivery(eventName: string, value: unknown): GitHubChange | null {
  const payload = asRecord(value);
  if (eventName === "issues" || eventName === "issue_comment") return parseIssue(eventName, payload);
  if (["pull_request", "pull_request_review", "pull_request_review_comment"].includes(eventName)) {
    return parsePullRequest(eventName, payload);
  }
  if (eventName === "check_run") return parseCheckRun(payload);
  if (eventName === "workflow_run") return parseWorkflowRun(payload);
  return null;
}
