declare const Netlify:
  | { env?: { get(name: string): string | undefined } }
  | undefined;
declare const process:
  | { env?: Record<string, string | undefined> }
  | undefined;

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

export function getEnv(name: string): string {
  if (typeof Netlify !== "undefined" && Netlify.env?.get) {
    return Netlify.env.get(name) ?? "";
  }
  return typeof process !== "undefined" ? process?.env?.[name] ?? "" : "";
}

function getSigningSecret(): string {
  const secret = getEnv("WEBHOOK_SECRET") || getEnv("PORTAL_PASSCODE");
  return secret || "dev-local-fallback-secret-change-in-production";
}

export async function createPortalSessionToken(): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `portal:${exp}`;
  const sig = await hmacSign(getSigningSecret(), payload);
  return btoa(`${payload}:${sig}`);
}

export async function verifyPortalAuth(req: Request): Promise<boolean> {
  const configuredPasscode = getEnv("PORTAL_PASSCODE");
  // If no passcode is configured yet, only allow status inspection, not mutations
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

    const expectedSig = await hmacSign(getSigningSecret(), `portal:${expStr}`);
    return timingSafeEqual(sig, expectedSig);
  } catch {
    return false;
  }
}

export function verifyPasscodeInput(inputPasscode: string): boolean {
  const configuredPasscode = getEnv("PORTAL_PASSCODE");
  if (!configuredPasscode || !inputPasscode) return false;
  return timingSafeEqual(inputPasscode, configuredPasscode);
}

export function verifyWorkerWebhook(req: Request): boolean {
  const secret = getEnv("WEBHOOK_SECRET");
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7).trim();
  return timingSafeEqual(provided, secret);
}

export function getSystemReadiness() {
  return {
    passcodeConfigured: Boolean(getEnv("PORTAL_PASSCODE")),
    webhookConfigured: Boolean(getEnv("WEBHOOK_SECRET")),
    githubConfigured: Boolean(getEnv("GITHUB_REPO") && getEnv("GITHUB_TOKEN")),
    r2Configured: Boolean(
      getEnv("R2_ACCOUNT_ID") &&
        getEnv("R2_ACCESS_KEY_ID") &&
        getEnv("R2_SECRET_ACCESS_KEY") &&
        getEnv("R2_BUCKET_NAME")
    ),
    githubRepo: getEnv("GITHUB_REPO") || null,
  };
}
