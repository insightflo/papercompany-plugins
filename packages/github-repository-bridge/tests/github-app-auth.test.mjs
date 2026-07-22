import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  createGitHubAppJwt,
  mintGitHubAppInstallationToken,
} from "../src/github-app-auth.ts";

function decodePart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function testKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey,
  };
}

test("creates a short-lived RS256 GitHub App JWT", () => {
  const keys = testKeys();
  const now = new Date("2026-07-22T00:00:00Z");
  const jwt = createGitHubAppJwt({ appId: "12345", privateKey: keys.privateKey, now });
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");

  assert.deepEqual(decodePart(headerPart), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodePart(payloadPart), {
    iat: Math.floor(now.getTime() / 1000) - 60,
    exp: Math.floor(now.getTime() / 1000) + 9 * 60,
    iss: "12345",
  });
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), keys.publicKey, Buffer.from(signaturePart, "base64url")),
    true,
  );
});

test("mints an installation token for the configured target repository", async () => {
  const keys = testKeys();
  const calls = [];
  const http = {
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.endsWith("/repos/acme/operations/installation")) {
        return new Response(JSON.stringify({ id: 9876 }), { status: 200 });
      }
      if (url.endsWith("/app/installations/9876/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  };

  const token = await mintGitHubAppInstallationToken({
    http,
    appId: "12345",
    privateKey: keys.privateKey,
    repository: "acme/operations",
    now: new Date("2026-07-22T00:00:00Z"),
  });

  assert.equal(token, "installation-token");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers.authorization, calls[0].init.headers.authorization);
});

test("does not hide a GitHub installation lookup failure", async () => {
  const keys = testKeys();
  const http = {
    async fetch() {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    },
  };

  await assert.rejects(
    mintGitHubAppInstallationToken({
      http,
      appId: "12345",
      privateKey: keys.privateKey,
      repository: "acme/operations",
    }),
    /installation lookup failed.*HTTP 404/i,
  );
});
