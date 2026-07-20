import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const SHA256_HEX_LENGTH = 64;

export function verifyGitHubSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith(SIGNATURE_PREFIX) || !secret) return false;

  const receivedHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]+$/i.test(receivedHex) || receivedHex.length !== SHA256_HEX_LENGTH) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
