import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { verifyWorkerWebhook } from "../../src/server/auth.ts";
import { type DbJobRow, getDb, mapRowToJob } from "../../src/server/db.ts";
import { createR2PresignedUrl } from "../../src/server/r2-presign.ts";
import type {
  AnnotatedGene,
  JobMetrics,
  JobStatus,
  StageLogEntry,
} from "../../src/types.ts";

export default async (req: Request, context: Context) => {
  if (!verifyWorkerWebhook(req)) {
    return Response.json({ error: "Unauthorized worker" }, { status: 401 });
  }

  const jobId = context.params.id;
  if (!jobId) {
    return Response.json({ error: "Missing job id." }, { status: 400 });
  }

  const db = await getDb();
  const rows = await db.sql<DbJobRow>`SELECT * FROM wgs_jobs WHERE id = ${jobId}`;
  if (!rows.length) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  const row = rows[0];
  const job = mapRowToJob(row);

  // Worker startup handshake: issue 6-hour presigned R2 URLs for input reads, cleanup, and outputs
  if (req.method === "GET") {
    const resultsZipKey = `jobs/${jobId}/results/${job.sampleName}_WGS_Results.zip`;
    const contigsKey = `jobs/${jobId}/results/${job.sampleName}_contigs.fasta`;
    const gbkKey = `jobs/${jobId}/results/${job.sampleName}.gbk`;
    const quastHtmlKey = `jobs/${jobId}/results/${job.sampleName}_quast_report.html`;

    const [
      r1GetUrl,
      r2GetUrl,
      r1DeleteUrl,
      r2DeleteUrl,
      resultsZipPutUrl,
      contigsPutUrl,
      gbkPutUrl,
      quastHtmlPutUrl,
    ] = await Promise.all([
      createR2PresignedUrl({
        method: "GET",
        objectKey: row.r1_key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "GET",
        objectKey: row.r2_key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "DELETE",
        objectKey: row.r1_key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "DELETE",
        objectKey: row.r2_key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "PUT",
        objectKey: resultsZipKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "PUT",
        objectKey: contigsKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "PUT",
        objectKey: gbkKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl({
        method: "PUT",
        objectKey: quastHtmlKey,
        expiresInSeconds: 21600,
      }),
    ]);

    return Response.json({
      job,
      keys: {
        resultsZipKey,
        contigsKey,
        gbkKey,
        quastHtmlKey,
      },
      urls: {
        r1GetUrl,
        r2GetUrl,
        r1DeleteUrl,
        r2DeleteUrl,
        resultsZipPutUrl,
        contigsPutUrl,
        gbkPutUrl,
        quastHtmlPutUrl,
      },
    });
  }

  // Worker status / metrics / completion callback
  if (req.method === "POST") {
    const body = (await req.json()) as {
      status?: JobStatus;
      currentStage?: string;
      progress?: number;
      ghRunUrl?: string;
      rawReadsDeleted?: boolean;
      log?: { stage: string; message: string; level?: StageLogEntry["level"] };
      metrics?: Partial<JobMetrics>;
      genes?: AnnotatedGene[];
      outputKeys?: {
        resultsZipKey?: string;
        contigsKey?: string;
        gbkKey?: string;
        quastHtmlKey?: string;
      };
      errorMessage?: string | null;
    };

    const nextStatus: JobStatus = body.status ?? job.status;
    const nextStage = body.currentStage ?? job.currentStage;
    const nextProgress =
      body.progress !== undefined ? Number(body.progress) : job.progress;
    const nextGhRunUrl = body.ghRunUrl ?? job.ghRunUrl ?? null;
    const nextRawDeleted =
      body.rawReadsDeleted !== undefined
        ? Boolean(body.rawReadsDeleted)
        : job.rawReadsDeleted;

    const mergedMetrics: JobMetrics = {
      ...job.metrics,
      ...(body.metrics ?? {}),
    };

    const nextLogs: StageLogEntry[] = [...job.stageLogs];
    if (body.log) {
      nextLogs.push({
        timestamp: new Date().toISOString(),
        stage: body.log.stage,
        message: body.log.message,
        level: body.log.level ?? "info",
      });
    }

    if (Array.isArray(body.genes) && body.genes.length > 0) {
      const reportStore = getStore({
        name: "wgs-reports",
        consistency: "strong",
      });
      await reportStore.setJSON(`genes/${jobId}.json`, body.genes);
    }

    const zipKey = body.outputKeys?.resultsZipKey ?? row.results_zip_key;
    const contigsKey = body.outputKeys?.contigsKey ?? row.contigs_key;
    const gbkKey = body.outputKeys?.gbkKey ?? row.gbk_key;
    const quastKey = body.outputKeys?.quastHtmlKey ?? row.quast_html_key;
    const errMsg =
      body.errorMessage !== undefined ? body.errorMessage : row.error_message;
    const isTerminal = nextStatus === "completed" || nextStatus === "failed";

    if (isTerminal) {
      await db.sql`
        UPDATE wgs_jobs
        SET status = ${nextStatus},
            current_stage = ${nextStage},
            progress = ${nextProgress},
            gh_run_url = ${nextGhRunUrl},
            raw_reads_deleted = ${nextRawDeleted},
            metrics = ${JSON.stringify(mergedMetrics)}::jsonb,
            stage_logs = ${JSON.stringify(nextLogs)}::jsonb,
            results_zip_key = ${zipKey},
            contigs_key = ${contigsKey},
            gbk_key = ${gbkKey},
            quast_html_key = ${quastKey},
            error_message = ${errMsg},
            updated_at = NOW(),
            completed_at = NOW()
        WHERE id = ${jobId}
      `;
    } else {
      await db.sql`
        UPDATE wgs_jobs
        SET status = ${nextStatus},
            current_stage = ${nextStage},
            progress = ${nextProgress},
            gh_run_url = ${nextGhRunUrl},
            raw_reads_deleted = ${nextRawDeleted},
            metrics = ${JSON.stringify(mergedMetrics)}::jsonb,
            stage_logs = ${JSON.stringify(nextLogs)}::jsonb,
            results_zip_key = ${zipKey},
            contigs_key = ${contigsKey},
            gbk_key = ${gbkKey},
            quast_html_key = ${quastKey},
            error_message = ${errMsg},
            updated_at = NOW()
        WHERE id = ${jobId}
      `;
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: "/api/worker/jobs/:id",
};
