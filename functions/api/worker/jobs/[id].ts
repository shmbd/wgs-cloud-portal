import { verifyWorkerWebhook } from "../../../../src/server/auth.ts";
import type { PagesContext } from "../../../../src/server/env.ts";
import { createR2PresignedUrl } from "../../../../src/server/r2-presign.ts";
import {
  getJobRecord,
  saveJobGenes,
  saveJobRecord,
  toPublicJob,
} from "../../../../src/server/store.ts";
import type {
  AnnotatedGene,
  JobMetrics,
  JobStatus,
  StageLogEntry,
} from "../../../../src/types.ts";

export async function onRequest(
  context: PagesContext<{ id: string }>
): Promise<Response> {
  const { request: req, env, params } = context;

  if (!verifyWorkerWebhook(req, env)) {
    return Response.json({ error: "Unauthorized worker" }, { status: 401 });
  }

  const jobId = params.id;
  if (!jobId) {
    return Response.json({ error: "Missing job id." }, { status: 400 });
  }

  const rec = await getJobRecord(env, jobId);
  if (!rec) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  if (req.method === "GET") {
    const resultsZipKey = `jobs/${jobId}/results/${rec.sampleName}_WGS_Results.zip`;
    const contigsKey = `jobs/${jobId}/results/${rec.sampleName}_contigs.fasta`;
    const gbkKey = `jobs/${jobId}/results/${rec.sampleName}.gbk`;
    const quastHtmlKey = `jobs/${jobId}/results/${rec.sampleName}_quast_report.html`;

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
      createR2PresignedUrl(env, {
        method: "GET",
        objectKey: rec.r1Key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "GET",
        objectKey: rec.r2Key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "DELETE",
        objectKey: rec.r1Key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "DELETE",
        objectKey: rec.r2Key,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "PUT",
        objectKey: resultsZipKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "PUT",
        objectKey: contigsKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "PUT",
        objectKey: gbkKey,
        expiresInSeconds: 21600,
      }),
      createR2PresignedUrl(env, {
        method: "PUT",
        objectKey: quastHtmlKey,
        expiresInSeconds: 21600,
      }),
    ]);

    return Response.json({
      job: toPublicJob(rec),
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

    const nowIso = new Date().toISOString();
    if (body.status) rec.status = body.status;
    if (body.currentStage !== undefined) rec.currentStage = body.currentStage;
    if (body.progress !== undefined) rec.progress = Number(body.progress);
    if (body.ghRunUrl) rec.ghRunUrl = body.ghRunUrl;
    if (body.rawReadsDeleted !== undefined) {
      rec.rawReadsDeleted = Boolean(body.rawReadsDeleted);
    }
    if (body.metrics) {
      rec.metrics = { ...rec.metrics, ...body.metrics };
    }
    if (body.log) {
      rec.stageLogs = [
        ...rec.stageLogs,
        {
          timestamp: nowIso,
          stage: body.log.stage,
          message: body.log.message,
          level: body.log.level ?? "info",
        },
      ];
    }
    if (body.outputKeys) {
      if (body.outputKeys.resultsZipKey) {
        rec.resultsZipKey = body.outputKeys.resultsZipKey;
      }
      if (body.outputKeys.contigsKey) {
        rec.contigsKey = body.outputKeys.contigsKey;
      }
      if (body.outputKeys.gbkKey) {
        rec.gbkKey = body.outputKeys.gbkKey;
      }
      if (body.outputKeys.quastHtmlKey) {
        rec.quastHtmlKey = body.outputKeys.quastHtmlKey;
      }
    }
    if (body.errorMessage !== undefined) {
      rec.errorMessage = body.errorMessage;
    }

    rec.updatedAt = nowIso;
    if (rec.status === "completed" || rec.status === "failed") {
      rec.completedAt = nowIso;
    }

    if (Array.isArray(body.genes) && body.genes.length > 0) {
      await saveJobGenes(env, jobId, body.genes);
    }

    await saveJobRecord(env, rec);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
