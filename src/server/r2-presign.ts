import type { Env } from "./env.ts";

const encoder = new TextEncoder();

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(message) as BufferSource
  );
  return toHex(digest);
}

async function hmacRaw(
  keyBytes: ArrayBuffer | Uint8Array,
  data: string
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(data) as BufferSource
  );
}

export interface PresignOptions {
  method: "GET" | "PUT" | "DELETE";
  objectKey?: string;
  expiresInSeconds?: number;
  downloadFilename?: string;
  extraQuery?: [string, string][];
}

export async function createR2PresignedUrl(
  env: Env,
  opts: PresignOptions
): Promise<string> {
  const accountId = (env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (env.R2_BUCKET_NAME || "").trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Cloudflare R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) are not configured."
    );
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";
  const expires = opts.expiresInSeconds ?? 14400;

  const now = new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);

  let canonicalUri = `/${encodeRfc3986(bucket)}`;
  if (opts.objectKey) {
    const encodedKey = opts.objectKey
      .replace(/^\/+/, "")
      .split("/")
      .map(encodeRfc3986)
      .join("/");
    canonicalUri = `/${encodeRfc3986(bucket)}/${encodedKey}`;
  }

  const queryEntries: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    [
      "X-Amz-Credential",
      `${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`,
    ],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
    ...(opts.extraQuery ?? []),
  ];

  if (opts.method === "GET" && opts.downloadFilename) {
    const safeName = opts.downloadFilename.replace(/["\\]/g, "_");
    queryEntries.push([
      "response-content-disposition",
      `attachment; filename="${safeName}"`,
    ]);
  }

  queryEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join("\n");

  const kDate = await hmacRaw(
    encoder.encode(`AWS4${secretAccessKey}`),
    dateStamp
  );
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, "aws4_request");
  const signature = toHex(await hmacRaw(kSigning, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

export async function r2PutJson(
  env: Env,
  objectKey: string,
  data: unknown
): Promise<void> {
  const putUrl = await createR2PresignedUrl(env, {
    method: "PUT",
    objectKey,
    expiresInSeconds: 300,
  });
  const resp = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    const xml = await resp.text();
    const codeMatch = xml.match(/<Code>([^<]+)<\/Code>/);
    const msgMatch = xml.match(/<Message>([^<]+)<\/Message>/);
    const r2Code = codeMatch ? codeMatch[1] : `HTTP ${resp.status}`;
    const r2Msg = msgMatch ? msgMatch[1] : xml.slice(0, 200);
    throw new Error(`Cloudflare R2 write error (${r2Code}): ${r2Msg}`);
  }
}

export async function r2GetJson<T>(
  env: Env,
  objectKey: string
): Promise<T | null> {
  const getUrl = await createR2PresignedUrl(env, {
    method: "GET",
    objectKey,
    expiresInSeconds: 300,
  });
  const resp = await fetch(getUrl, { method: "GET" });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Cloudflare R2 read error (HTTP ${resp.status})`);
  }
  return (await resp.json()) as T;
}

export async function r2DeleteKey(env: Env, objectKey: string): Promise<void> {
  const delUrl = await createR2PresignedUrl(env, {
    method: "DELETE",
    objectKey,
    expiresInSeconds: 300,
  });
  await fetch(delUrl, { method: "DELETE" });
}

export async function r2ListKeys(env: Env, prefix: string): Promise<string[]> {
  const listUrl = await createR2PresignedUrl(env, {
    method: "GET",
    expiresInSeconds: 300,
    extraQuery: [
      ["list-type", "2"],
      ["max-keys", "200"],
      ["prefix", prefix],
    ],
  });
  const resp = await fetch(listUrl, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Cloudflare R2 list error (HTTP ${resp.status})`);
  }
  const xml = await resp.text();
  const keys: string[] = [];
  const regex = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    keys.push(
      match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
    );
  }
  return keys;
}
