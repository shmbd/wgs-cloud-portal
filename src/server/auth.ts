import type { Env } from "./env.ts";

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message) as BufferSource
  );
  return toHex(sig);
}

function getSigningSecret(env: Env): string {
  const secret = (env.WEBHOOK_SECRET || env.PORTAL_PASSCODE || "").trim();
  return secret || "dev-local-fallback-secret-change-in-production";
}

export async function createPortalSessionToken(env: Env): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `portal:${exp}`;
  const sig = await hmacSign(getSigningSecret(env), payload);
  return btoa(`${payload}:${sig}`);
}

export async function verifyPortalAuth(
  req: Request,
  env: Env
): Promise<boolean> {
  const configuredPasscode = (env.PORTAL_PASSCODE || "").trim();
  if (!configuredPasscode) return false;

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7).trim();

  try {
    const decoded = atob(token);
    const [scope, expStr, sig] = decoded.split(":");
    if (scope !== "portal" || !expStr || !sig) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;

    const expectedSig = await hmacSign(
      getSigningSecret(env),
      `portal:${expStr}`
    );
    return timingSafeEqual(sig, expectedSig);
  } catch {
    return false;
  }
}

export function verifyPasscodeInput(
  inputPasscode: string,
  env: Env
): boolean {
  const configuredPasscode = (env.PORTAL_PASSCODE || "").trim();
  if (!configuredPasscode || !inputPasscode) return false;
  return timingSafeEqual(inputPasscode.trim(), configuredPasscode);
}

export function verifyWorkerWebhook(req: Request, env: Env): boolean {
  const secret = (env.WEBHOOK_SECRET || "").trim();
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7).trim();
  return timingSafeEqual(provided, secret);
}

export function getSystemReadiness(env: Env) {
  return {
    passcodeConfigured: Boolean((env.PORTAL_PASSCODE || "").trim()),
    webhookConfigured: Boolean((env.WEBHOOK_SECRET || "").trim()),
    githubConfigured: Boolean(
      (env.GITHUB_REPO || "").trim() && (env.GITHUB_TOKEN || "").trim()
    ),
    r2Configured: Boolean(
      (env.R2_ACCOUNT_ID || "").trim() &&
        (env.R2_ACCESS_KEY_ID || "").trim() &&
        (env.R2_SECRET_ACCESS_KEY || "").trim() &&
        (env.R2_BUCKET_NAME || "").trim()
    ),
    githubRepo: (env.GITHUB_REPO || "").trim() || null,
  };
}
