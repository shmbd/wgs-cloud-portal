import type { Config, Context } from "@netlify/functions";
import { verifyPortalAuth } from "../../src/server/auth.ts";
import { type DbJobRow, getDb, mapRowToJob } from "../../src/server/db.ts";
import { createR2PresignedUrl } from "../../src/server/r2-presign.ts";
import type { PipelineOptions, StageLogEntry } from "../../src/types.ts";

function sanitizeToken(input: string, fallback: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

export default async (req: Request, _context: Context) => {
  if (!(await verifyPortalAuth(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  if (req.method === "GET") {
    const rows = await db.sql<DbJobRow>`
      SELECT * FROM wgs_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return Response.json({ jobs: rows.map(mapRowToJob) });
  }

  if (req.method === "POST") {
    try {
      const body = (await req.json()) as {
        sampleName?: string;
        genus?: string;
        species?: string;
        strain?: string;
        r1Filename?: string;
        r2Filename?: string;
        r1SizeBytes?: number;
        r2SizeBytes?: number;
        pipelineOptions?: Partial<PipelineOptions>;
      };

      const sampleName = sanitizeToken(body.sampleName ?? "", "");
      if (!sampleName) {
        return Response.json(
          { error: "Sample name is required (e.g., SH-1393)." },
          { status: 400 }
        );
      }

      if (!body.r1Filename || !body.r2Filename) {
        return Response.json(
          { error: "Both paired-end R1 and R2 FASTQ filenames are required." },
          { status: 400 }
        );
      }

      const genus = (body.genus ?? "Streptomyces").trim().slice(0, 60) || "Streptomyces";
      const species = (body.species ?? "sp.").trim().slice(0, 60) || "sp.";
      const strain = (body.strain ?? sampleName).trim().slice(0, 60);

      const jobId = `wgs_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
      const safeR1 = sanitizeToken(body.r1Filename, "R1.fastq.gz");
      const safeR2 = sanitizeToken(body.r2Filename, "R2.fastq.gz");

      const r1Key = `jobs/${jobId}/raw/${safeR1}`;
      const r2Key = `jobs/${jobId}/raw/${safeR2}`;

      const options: PipelineOptions = {
        runFastp: body.pipelineOptions?.runFastp ?? true,
        spadesMode: body.pipelineOptions?.spadesMode === "careful" ? "careful" : "isolate",
        minContigLen: Number(body.pipelineOptions?.minContigLen ?? 500) || 500,
        runProkka: body.pipelineOptions?.runProkka ?? true,
        runAbricate: body.pipelineOptions?.runAbricate ?? true,
      };

      const initialLogs: StageLogEntry[] = [
        {
          timestamp: new Date().toISOString(),
          stage: "upload",
          message: `Job created for ${genus} ${species} (${sampleName}). Uploading paired-end reads to Cloudflare R2...`,
          level: "info",
        },
      ];

      const r1UploadUrl = await createR2PresignedUrl({
        method: "PUT",
        objectKey: r1Key,
        expiresInSeconds: 14400,
      });
      const r2UploadUrl = await createR2PresignedUrl({
        method: "PUT",
        objectKey: r2Key,
        expiresInSeconds: 14400,
      });

      const r1Size = Math.max(0, Math.floor(Number(body.r1SizeBytes ?? 0)));
      const r2Size = Math.max(0, Math.floor(Number(body.r2SizeBytes ?? 0)));
      const optionsJson = JSON.stringify(options);
      const logsJson = JSON.stringify(initialLogs);

      const inserted = await db.sql<DbJobRow>`
        INSERT INTO wgs_jobs (
          id, sample_name, genus, species, strain,
          status, current_stage, progress,
          r1_filename, r2_filename, r1_size_bytes, r2_size_bytes,
          r1_key, r2_key, pipeline_options, stage_logs
        ) VALUES (
          ${jobId}, ${sampleName}, ${genus}, ${species}, ${strain},
          ${"uploading"}, ${"Uploading raw FASTQ files to cloud storage"}, ${5},
          ${safeR1}, ${safeR2}, ${r1Size}, ${r2Size},
          ${r1Key}, ${r2Key}, ${optionsJson}::jsonb, ${logsJson}::jsonb
        )
        RETURNING *
      `;

      return Response.json({
        job: mapRowToJob(inserted[0]),
        r1UploadUrl,
        r2UploadUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create job";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: "/api/jobs",
};
