import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { verifyPortalAuth } from "../../src/server/auth.ts";
import { type DbJobRow, getDb, mapRowToJob } from "../../src/server/db.ts";
import { createR2PresignedUrl } from "../../src/server/r2-presign.ts";
import type { AnnotatedGene, DownloadLinks } from "../../src/types.ts";

export default async (req: Request, context: Context) => {
  if (!(await verifyPortalAuth(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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

  if (req.method === "GET") {
    const job = mapRowToJob(row);

    // Load full annotated gene table from Netlify Blobs if available
    try {
      const reportStore = getStore({
        name: "wgs-reports",
        consistency: "strong",
      });
      const genesData = (await reportStore.get(`genes/${jobId}.json`, {
        type: "json",
      })) as AnnotatedGene[] | null;
      if (genesData) {
        job.genes = genesData;
      }
    } catch {
      // Non-fatal if blobs store has no gene table yet
    }

    // Generate fresh download links if output keys exist
    const downloadLinks: DownloadLinks = {};
    try {
      if (row.results_zip_key) {
        downloadLinks.resultsZipUrl = await createR2PresignedUrl({
          method: "GET",
          objectKey: row.results_zip_key,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_WGS_Results.zip`,
        });
      }
      if (row.contigs_key) {
        downloadLinks.contigsFastaUrl = await createR2PresignedUrl({
          method: "GET",
          objectKey: row.contigs_key,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_contigs.fasta`,
        });
      }
      if (row.gbk_key) {
        downloadLinks.genbankUrl = await createR2PresignedUrl({
          method: "GET",
          objectKey: row.gbk_key,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}.gbk`,
        });
      }
      if (row.quast_html_key) {
        downloadLinks.quastHtmlUrl = await createR2PresignedUrl({
          method: "GET",
          objectKey: row.quast_html_key,
          expiresInSeconds: 7200,
          downloadFilename: `${job.sampleName}_quast_report.html`,
        });
      }
    } catch {
      // R2 env vars might not be configured in local preview
    }

    job.downloadLinks = downloadLinks;
    return Response.json({ job });
  }

  if (req.method === "DELETE") {
    // Best-effort R2 object cleanup
    const keysToDelete = [
      row.r1_key,
      row.r2_key,
      row.results_zip_key,
      row.contigs_key,
      row.gbk_key,
      row.quast_html_key,
    ].filter((k): k is string => Boolean(k));

    await Promise.allSettled(
      keysToDelete.map(async (key) => {
        const delUrl = await createR2PresignedUrl({
          method: "DELETE",
          objectKey: key,
          expiresInSeconds: 300,
        });
        await fetch(delUrl, { method: "DELETE" });
      })
    );

    try {
      const reportStore = getStore({
        name: "wgs-reports",
        consistency: "strong",
      });
      await reportStore.delete(`genes/${jobId}.json`);
    } catch {
      // Ignore blob cleanup errors
    }

    await db.sql`DELETE FROM wgs_jobs WHERE id = ${jobId}`;
    return Response.json({ deleted: true });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: "/api/jobs/:id",
};
