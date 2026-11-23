import { verifyPortalAuth } from "../../../../src/server/auth.ts";
import type { PagesContext } from "../../../../src/server/env.ts";
import { createR2PresignedUrl } from "../../../../src/server/r2-presign.ts";
import {
  deleteJobAndArtifacts,
  getJobGenes,
  getJobRecord,
  toPublicJob,
} from "../../../../src/server/store.ts";
import type { DownloadLinks } from "../../../../src/types.ts";

export async function onRequest(
  context: PagesContext<{ id: string }>
): Promise<Response> {
  const { request: req, env, params } = context;

  if (!(await verifyPortalAuth(req, env))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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
    const job = toPublicJob(rec);
    const genes = await getJobGenes(env, jobId).catch(() => null);
    if (genes) {
      job.genes = genes;
    }

    const downloadLinks: DownloadLinks = {};
    try {
      if (rec.resultsZipKey) {
        downloadLinks.resultsZipUrl = await createR2PresignedUrl(env, {
          method: "GET",
          objectKey: rec.resultsZipKey,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_WGS_Results.zip`,
        });
      }
      if (rec.contigsKey) {
        downloadLinks.contigsFastaUrl = await createR2PresignedUrl(env, {
          method: "GET",
          objectKey: rec.contigsKey,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_contigs.fasta`,
        });
      }
      if (rec.gbkKey) {
        downloadLinks.genbankUrl = await createR2PresignedUrl(env, {
          method: "GET",
          objectKey: rec.gbkKey,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}.gbk`,
        });
      }
      if (rec.quastHtmlKey) {
        downloadLinks.quastHtmlUrl = await createR2PresignedUrl(env, {
          method: "GET",
          objectKey: rec.quastHtmlKey,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_quast_report.html`,
        });
      }
    } catch {
      // Ignore presign error if keys incomplete
    }

    job.downloadLinks = downloadLinks;
    return Response.json({ job });
  }

  if (req.method === "DELETE") {
    await deleteJobAndArtifacts(env, rec);
    return Response.json({ deleted: true });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
