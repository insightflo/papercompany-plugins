import { sign } from "node:crypto";

interface GitHubAppJwtInput {
  appId: string;
  privateKey: string;
  now?: Date | undefined;
}

interface GitHubAppHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

interface MintInstallationTokenInput extends GitHubAppJwtInput {
  http: GitHubAppHttpClient;
  repository: string;
}

export const GITHUB_API_USER_AGENT = "papercompany-github-repository-bridge";

function encodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGitHubAppJwt(input: GitHubAppJwtInput): string {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: input.appId.trim(),
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), input.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function githubHeaders(jwt: string): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": GITHUB_API_USER_AGENT,
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function mintGitHubAppInstallationToken(input: MintInstallationTokenInput): Promise<string> {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(input.repository.trim());
  if (!match) throw new Error("GitHub App installation repository must use owner/name format");
  const [, owner, repository] = match;
  const jwt = createGitHubAppJwt(input);
  const headers = githubHeaders(jwt);
  const lookup = await input.http.fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
    { method: "GET", headers },
  );
  if (lookup.status < 200 || lookup.status >= 300) {
    throw new Error(`GitHub App installation lookup failed: HTTP ${lookup.status}`);
  }
  const installation = await readJsonObject(lookup);
  const installationId = typeof installation.id === "number" || typeof installation.id === "string"
    ? String(installation.id)
    : "";
  if (!installationId) throw new Error("GitHub App installation lookup returned no installation id");

  const tokenResponse = await input.http.fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    { method: "POST", headers },
  );
  if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
    throw new Error(`GitHub App installation token request failed: HTTP ${tokenResponse.status}`);
  }
  const tokenPayload = await readJsonObject(tokenResponse);
  const token = typeof tokenPayload.token === "string" ? tokenPayload.token : "";
  if (!token) throw new Error("GitHub App installation token response returned no token");
  return token;
}
