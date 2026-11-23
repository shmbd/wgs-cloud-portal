import type { AnnotatedGene, WgsJob } from "../types.ts";
import type { Env } from "./env.ts";
import { r2DeleteKey, r2GetJson, r2ListKeys, r2PutJson } from "./r2-presign.ts";

export interface WgsJobRecord extends WgsJob {
  r1Key: string;
  r2Key: string;
  resultsZipKey?: string | null;
  contigsKey?: string | null;
  gbkKey?: string | null;
  quastHtmlKey?: string | null;
}

const META_PREFIX = "jobs_meta/";
const GENES_PREFIX = "jobs_genes/";

export function metaKey(jobId: string): string {
  return `${META_PREFIX}${jobId}.json`;
}

export function genesKey(jobId: string): string {
  return `${GENES_PREFIX}${jobId}.json`;
}

export function toPublicJob(rec: WgsJobRecord): WgsJob {
  const {
    r1Key: _r1,
    r2Key: _r2,
    resultsZipKey: _zip,
    contigsKey: _ctg,
    gbkKey: _gbk,
    quastHtmlKey: _qst,
    ...pub
  } = rec;
  return pub;
}

export async function saveJobRecord(
  env: Env,
  record: WgsJobRecord
): Promise<void> {
  await r2PutJson(env, metaKey(record.id), record);
}

export async function getJobRecord(
  env: Env,
  jobId: string
): Promise<WgsJobRecord | null> {
  return r2GetJson<WgsJobRecord>(env, metaKey(jobId));
}

export async function listJobRecords(
  env: Env,
  limit = 50
): Promise<WgsJobRecord[]> {
  const keys = await r2ListKeys(env, META_PREFIX);
  const sortedNewest = keys
    .filter((k) => k.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);

  const records = await Promise.all(
    sortedNewest.map((k) => r2GetJson<WgsJobRecord>(env, k).catch(() => null))
  );

  return records
    .filter((r): r is WgsJobRecord => r !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function saveJobGenes(
  env: Env,
  jobId: string,
  genes: AnnotatedGene[]
): Promise<void> {
  await r2PutJson(env, genesKey(jobId), genes);
}

export async function getJobGenes(
  env: Env,
  jobId: string
): Promise<AnnotatedGene[] | null> {
  return r2GetJson<AnnotatedGene[]>(env, genesKey(jobId));
}

export async function deleteJobAndArtifacts(
  env: Env,
  rec: WgsJobRecord
): Promise<void> {
  const keys = [
    metaKey(rec.id),
    genesKey(rec.id),
    rec.r1Key,
    rec.r2Key,
    rec.resultsZipKey,
    rec.contigsKey,
    rec.gbkKey,
    rec.quastHtmlKey,
  ].filter((k): k is string => Boolean(k));

  await Promise.allSettled(keys.map((k) => r2DeleteKey(env, k)));
}
