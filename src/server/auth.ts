import crypto from "node:crypto";

export function createSessionId() {
  return crypto.randomBytes(32).toString("base64url");
}

export function signedValue(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function isValidSignature(secret: string, value: string, signature: string) {
  const expected = signedValue(secret, value);
  // timingSafeEqual requires equal-length inputs. HMAC-SHA256 hex output has a fixed
  // length, so rejecting anything else before the comparison is both safe and avoids
  // turning malformed cookie input into an exception.
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function hashSessionId(sessionId: string) {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

export function createSecret() {
  return crypto.randomBytes(32).toString("base64url");
}
