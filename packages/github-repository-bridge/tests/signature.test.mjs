import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyGitHubSignature } from "../src/signature.ts";

test("accepts the GitHub sha256 signature for the exact raw body", () => {
  const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
  const secret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyGitHubSignature(body, signature, secret), true);
});

test("rejects a signature for a different body", () => {
  const secret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update("original").digest("hex")}`;

  assert.equal(verifyGitHubSignature("changed", signature, secret), false);
});

test("rejects malformed or missing signatures", () => {
  assert.equal(verifyGitHubSignature("body", undefined, "secret"), false);
  assert.equal(verifyGitHubSignature("body", "sha1=abc", "secret"), false);
  assert.equal(verifyGitHubSignature("body", "sha256=abc", "secret"), false);
});
