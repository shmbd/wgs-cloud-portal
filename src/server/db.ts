import { getDatabase } from "@netlify/database";
import type {
  JobMetrics,
  JobStatus,
  PipelineOptions,
  StageLogEntry,
  WgsJob,
} from "../types.ts";

let schemaEnsured = false;

export async function getDb() {
  const db = getDatabase();
  if (!schemaEnsured) {
    await db.sql`
      CREATE TABLE IF NOT EXISTS wgs_jobs (
        id TEXT PRIMARY KEY,
        sample_name TEXT NOT NULL,
        genus TEXT NOT NULL DEFAULT 'Streptomyces',
        species TEXT NOT NULL DEFAULT 'sp.',
        strain TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'uploading',
        current_stage TEXT NOT NULL DEFAULT 'Waiting for FASTQ upload',
        progress INTEGER NOT NULL DEFAULT 0,
        r1_filename TEXT NOT NULL,
        r2_filename TEXT NOT NULL,
        r1_size_bytes BIGINT NOT NULL DEFAULT 0,
        r2_size_bytes BIGINT NOT NULL DEFAULT 0,
        r1_key TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        results_zip_key TEXT,
        contigs_key TEXT,
        gbk_key TEXT,
        quast_html_key TEXT,
        raw_reads_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        pipeline_options JSONB NOT NULL DEFAULT '{}'::jsonb,
        metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        stage_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
        error_message TEXT,
        gh_run_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `;
    schemaEnsured = true;
  }
  return db;
}

export interface DbJobRow {
  id: string;
  sample_name: string;
  genus: string;
  species: string;
  strain: string;
  status: JobStatus;
  current_stage: string;
  progress: number;
  r1_filename: string;
  r2_filename: string;
  r1_size_bytes: string | number;
  r2_size_bytes: string | number;
  r1_key: string;
  r2_key: string;
  results_zip_key: string | null;
  contigs_key: string | null;
  gbk_key: string | null;
  quast_html_key: string | null;
  raw_reads_deleted: boolean;
  pipeline_options: PipelineOptions | string;
  metrics: JobMetrics | string;
  stage_logs: StageLogEntry[] | string;
  error_message: string | null;
  gh_run_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

function parseJsonField<T>(val: T | string | null | undefined, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val;
}

export function mapRowToJob(row: DbJobRow): WgsJob {
  return {
    id: row.id,
    sampleName: row.sample_name,
    genus: row.genus,
    species: row.species,
    strain: row.strain,
    status: row.status,
    currentStage: row.current_stage,
    progress: Number(row.progress ?? 0),
    r1Filename: row.r1_filename,
    r2Filename: row.r2_filename,
    r1SizeBytes: Number(row.r1_size_bytes ?? 0),
    r2SizeBytes: Number(row.r2_size_bytes ?? 0),
    rawReadsDeleted: Boolean(row.raw_reads_deleted),
    pipelineOptions: parseJsonField<PipelineOptions>(row.pipeline_options, {
      runFastp: true,
      spadesMode: "isolate",
      minContigLen: 500,
      runProkka: true,
      runAbricate: true,
    }),
    metrics: parseJsonField<JobMetrics>(row.metrics, {}),
    stageLogs: parseJsonField<StageLogEntry[]>(row.stage_logs, []),
    errorMessage: row.error_message,
    ghRunUrl: row.gh_run_url,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    completedAt: row.completed_at
      ? row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : String(row.completed_at)
      : null,
  };
}
