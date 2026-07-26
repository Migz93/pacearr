import crypto from "node:crypto";

export function createSessionId() {
  return crypto.randomBytes(32).toString("base64url");
}

export function signedValue(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function createSecret() {
  return crypto.randomBytes(32).toString("base64url");
}
