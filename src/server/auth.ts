import crypto from "node:crypto";

export function createSessionId() {
  return crypto.randomBytes(32).toString("base64url");
}

export function signedValue(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function isValidSignature(secret: string, value: string, signature: string) {
  const expected = Buffer.from(signedValue(secret, value));
  const provided = Buffer.from(signature);
  // timingSafeEqual requires equal-length inputs. HMAC-SHA256 hex output has a fixed
  // length, so rejecting anything else before the comparison is both safe and avoids
  // turning malformed cookie input into an exception.
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

export function hashSessionId(sessionId: string) {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

export function createSecret() {
  return crypto.randomBytes(32).toString("base64url");
}
