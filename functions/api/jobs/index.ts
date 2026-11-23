import { verifyPortalAuth } from "../../../src/server/auth.ts";
import type { PagesContext } from "../../../src/server/env.ts";
import { createR2PresignedUrl } from "../../../src/server/r2-presign.ts";
import {
  listJobRecords,
  saveJobRecord,
  toPublicJob,
  type WgsJobRecord,
} from "../../../src/server/store.ts";
import type { PipelineOptions, StageLogEntry } from "../../../src/types.ts";

function sanitizeToken(input: string, fallback: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request: req, env } = context;

  if (!(await verifyPortalAuth(req, env))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.method === "GET") {
    try {
      const records = await listJobRecords(env, 50);
      return Response.json({ jobs: records.map(toPublicJob) });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to list jobs from R2";
      return Response.json({ error: message }, { status: 500 });
    }
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

      const genus =
        (body.genus ?? "Streptomyces").trim().slice(0, 60) || "Streptomyces";
      const species = (body.species ?? "sp.").trim().slice(0, 60) || "sp.";
      const strain = (body.strain ?? sampleName).trim().slice(0, 60);

      const tsBase36 = Date.now().toString(36).padStart(9, "0");
      const jobId = `wgs_${tsBase36}_${crypto.randomUUID().slice(0, 8)}`;
      const safeR1 = sanitizeToken(body.r1Filename, "R1.fastq.gz");
      const safeR2 = sanitizeToken(body.r2Filename, "R2.fastq.gz");

      const r1Key = `jobs/${jobId}/raw/${safeR1}`;
      const r2Key = `jobs/${jobId}/raw/${safeR2}`;

      const options: PipelineOptions = {
        runFastp: body.pipelineOptions?.runFastp ?? true,
        spadesMode:
          body.pipelineOptions?.spadesMode === "careful"
            ? "careful"
            : "isolate",
        minContigLen: Number(body.pipelineOptions?.minContigLen ?? 500) || 500,
        runProkka: body.pipelineOptions?.runProkka ?? true,
        runAbricate: body.pipelineOptions?.runAbricate ?? true,
      };

      const nowIso = new Date().toISOString();
      const initialLogs: StageLogEntry[] = [
        {
          timestamp: nowIso,
          stage: "upload",
          message: `Job created for ${genus} ${species} (${sampleName}). Uploading paired-end reads to Cloudflare R2...`,
          level: "info",
        },
      ];

      const [r1UploadUrl, r2UploadUrl] = await Promise.all([
        createR2PresignedUrl(env, {
          method: "PUT",
          objectKey: r1Key,
          expiresInSeconds: 14400,
        }),
        createR2PresignedUrl(env, {
          method: "PUT",
          objectKey: r2Key,
          expiresInSeconds: 14400,
        }),
      ]);

      // Verify browser CORS preflight for this exact Pages origin before writing job record
      const reqOrigin = req.headers.get("origin") || new URL(req.url).origin;
      const corsProbe = await fetch(r1UploadUrl, {
        method: "OPTIONS",
        headers: {
          Origin: reqOrigin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      const allowOrigin = corsProbe.headers.get("access-control-allow-origin");
      if (!allowOrigin) {
        return Response.json(
          {
            error: `R2 CORS preflight blocked origin "${reqOrigin}" (HTTP ${corsProbe.status}). Add "${reqOrigin}" (or "https://*.pages.dev") to AllowedOrigins in Cloudflare R2 -> Bucket Settings -> CORS Policy.`,
          },
          { status: 502 }
        );
      }

      const record: WgsJobRecord = {
        id: jobId,
        sampleName,
        genus,
        species,
        strain,
        status: "uploading",
        currentStage: "Uploading raw FASTQ files to Cloudflare R2",
        progress: 5,
        r1Filename: safeR1,
        r2Filename: safeR2,
        r1SizeBytes: Math.max(0, Math.floor(Number(body.r1SizeBytes ?? 0))),
        r2SizeBytes: Math.max(0, Math.floor(Number(body.r2SizeBytes ?? 0))),
        r1Key,
        r2Key,
        rawReadsDeleted: false,
        pipelineOptions: options,
        metrics: {},
        stageLogs: initialLogs,
        errorMessage: null,
        ghRunUrl: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        completedAt: null,
      };

      // Saving the JSON record to R2 also verifies R2 write permissions immediately
      await saveJobRecord(env, record);

      return Response.json({
        job: toPublicJob(record),
        r1UploadUrl,
        r2UploadUrl,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create job";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
