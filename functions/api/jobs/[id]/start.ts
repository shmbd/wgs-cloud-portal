import { verifyPortalAuth } from "../../../../src/server/auth.ts";
import type { PagesContext } from "../../../../src/server/env.ts";
import {
  getJobRecord,
  saveJobRecord,
  toPublicJob,
} from "../../../../src/server/store.ts";

export async function onRequest(
  context: PagesContext<{ id: string }>
): Promise<Response> {
  const { request: req, env, params } = context;

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  if (!(await verifyPortalAuth(req, env))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = params.id;
  if (!jobId) {
    return Response.json({ error: "Missing job id." }, { status: 400 });
  }

  const githubRepo = (env.GITHUB_REPO || "").trim();
  const githubToken = (env.GITHUB_TOKEN || "").trim();
  const githubBranch = (env.GITHUB_BRANCH || "").trim() || "main";

  if (!githubRepo || !githubToken) {
    return Response.json(
      {
        error:
          "GITHUB_REPO and GITHUB_TOKEN must be configured in Cloudflare Pages Environment Variables.",
      },
      { status: 503 }
    );
  }

  const rec = await getJobRecord(env, jobId);
  if (!rec) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  const portalUrl = new URL(req.url).origin.replace(/\/+$/, "");
  const ghDispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/wgs-pipeline.yml/dispatches`;

  const ghResp = await fetch(ghDispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "BioForge-WGS-Cloudflare-Pages",
    },
    body: JSON.stringify({
      ref: githubBranch,
      inputs: {
        job_id: jobId,
        portal_url: portalUrl,
      },
    }),
  });

  const nowIso = new Date().toISOString();

  if (!ghResp.ok) {
    const errText = await ghResp.text();
    rec.status = "failed";
    rec.currentStage = "Failed to trigger GitHub Actions";
    rec.errorMessage = `GitHub API error (${ghResp.status}): ${errText.slice(0, 300)}`;
    rec.updatedAt = nowIso;
    rec.stageLogs = [
      ...rec.stageLogs,
      {
        timestamp: nowIso,
        stage: "dispatch",
        message: `GitHub Actions trigger failed (${ghResp.status}): ${errText.slice(0, 300)}`,
        level: "error",
      },
    ];
    await saveJobRecord(env, rec);

    return Response.json(
      {
        error: `Failed to trigger GitHub Actions (${ghResp.status}). Verify GITHUB_REPO, GITHUB_TOKEN, and that wgs-pipeline.yml is pushed to branch '${githubBranch}'.`,
      },
      { status: 502 }
    );
  }

  rec.status = "queued";
  rec.currentStage = "Queued on GitHub Actions Linux runner";
  rec.progress = 12;
  rec.errorMessage = null;
  rec.ghRunUrl = `https://github.com/${githubRepo}/actions`;
  rec.updatedAt = nowIso;
  rec.stageLogs = [
    ...rec.stageLogs,
    {
      timestamp: nowIso,
      stage: "queued",
      message:
        "Raw FASTQ upload verified! Dispatched job to GitHub Actions runner. You can safely close your browser or turn off your PC.",
      level: "success",
    },
  ];
  await saveJobRecord(env, rec);

  return Response.json({ job: toPublicJob(rec) });
}
