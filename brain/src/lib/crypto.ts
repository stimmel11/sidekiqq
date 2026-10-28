import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { optional, required } from "./env";

const ALG = "aes-256-gcm";
const VERSION = "v1";

/** Decode a 32-byte key given as base64/base64url or 64-char hex. */
export function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) throw new Error("Encryption key must decode to exactly 32 bytes");
  return buf;
}

export function encryptionKeyFromEnv(): Buffer {
  return decodeKey(required("TOKEN_ENCRYPTION_KEY"));
}

/**
 * Current key plus, during a rotation, the previous one (`TOKEN_ENCRYPTION_KEY_PREV`, decrypt only).
 * Used by the connection store (docs/CONNECTORS.md §7), which re-encrypts on read with the old key.
 */
export function keyRingFromEnv(): { current: Buffer; previous?: Buffer } {
  const prev = optional("TOKEN_ENCRYPTION_KEY_PREV");
  return { current: encryptionKeyFromEnv(), ...(prev ? { previous: decodeKey(prev) } : {}) };
}

/** AES-256-GCM; output `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds the ciphertext to its purpose. */
export function encrypt(plaintext: string, key: Buffer, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string, key: Buffer, aad = ""): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unrecognised ciphertext format");
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 challenge for a code verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A fresh PKCE pair: 43-char base64url verifier (32 random bytes) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}
