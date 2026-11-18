import { getEnv } from "./auth.ts";

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
  objectKey: string;
  expiresInSeconds?: number;
  downloadFilename?: string;
}

export async function createR2PresignedUrl(
  opts: PresignOptions
): Promise<string> {
  const accountId = getEnv("R2_ACCOUNT_ID");
  const accessKeyId = getEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = getEnv("R2_SECRET_ACCESS_KEY");
  const bucket = getEnv("R2_BUCKET_NAME");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Cloudflare R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME) are not configured."
    );
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";
  const expires = opts.expiresInSeconds ?? 14400; // Default 4 hours

  const now = new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = iso; // YYYYMMDDTHHMMSSZ
  const dateStamp = iso.slice(0, 8); // YYYYMMDD

  const encodedKey = opts.objectKey
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeRfc3986)
    .join("/");
  const canonicalUri = `/${encodeRfc3986(bucket)}/${encodedKey}`;

  const queryEntries: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    [
      "X-Amz-Credential",
      `${accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`,
    ],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
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
