import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("RELAY_SECRET must contain at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

/** AES-GCM authenticates both the credential and its owning workspace/connection. */
export function seal(value: string, secret: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function unseal(value: string, secret: string, context: string): string {
  const [version, nonce, tag, payload] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !payload) throw new Error("Invalid encrypted credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
}
