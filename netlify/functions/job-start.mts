import type { Config, Context } from "@netlify/functions";
import { getEnv, verifyPortalAuth } from "../../src/server/auth.ts";
import { type DbJobRow, getDb, mapRowToJob } from "../../src/server/db.ts";
import type { StageLogEntry } from "../../src/types.ts";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  if (!(await verifyPortalAuth(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = context.params.id;
  if (!jobId) {
    return Response.json({ error: "Missing job id." }, { status: 400 });
  }

  const githubRepo = getEnv("GITHUB_REPO");
  const githubToken = getEnv("GITHUB_TOKEN");
  const githubBranch = getEnv("GITHUB_BRANCH") || "main";

  if (!githubRepo || !githubToken) {
    return Response.json(
      {
        error:
          "GITHUB_REPO and GITHUB_TOKEN must be configured in Netlify Environment Variables.",
      },
      { status: 503 }
    );
  }

  const db = await getDb();
  const rows = await db.sql<DbJobRow>`SELECT * FROM wgs_jobs WHERE id = ${jobId}`;
  if (!rows.length) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  const existing = mapRowToJob(rows[0]);
  const portalUrl = (context.site?.url || new URL(req.url).origin).replace(
    /\/+$/,
    ""
  );

  const ghDispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/wgs-pipeline.yml/dispatches`;
  const ghResp = await fetch(ghDispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "BioForge-WGS-Portal",
    },
    body: JSON.stringify({
      ref: githubBranch,
      inputs: {
        job_id: jobId,
        portal_url: portalUrl,
      },
    }),
  });

  if (!ghResp.ok) {
    const errText = await ghResp.text();
    const failLogs: StageLogEntry[] = [
      ...existing.stageLogs,
      {
        timestamp: new Date().toISOString(),
        stage: "dispatch",
        message: `GitHub Actions trigger failed (${ghResp.status}): ${errText.slice(0, 300)}`,
        level: "error",
      },
    ];
    await db.sql`
      UPDATE wgs_jobs
      SET status = ${"failed"},
          current_stage = ${"Failed to trigger GitHub Actions"},
          error_message = ${`GitHub API error (${ghResp.status}): ${errText.slice(0, 300)}`},
          stage_logs = ${JSON.stringify(failLogs)}::jsonb,
          updated_at = NOW()
      WHERE id = ${jobId}
    `;
    return Response.json(
      {
        error: `Failed to trigger GitHub Actions (${ghResp.status}). Verify GITHUB_REPO, GITHUB_TOKEN, and that wgs-pipeline.yml is pushed to branch '${githubBranch}'.`,
      },
      { status: 502 }
    );
  }

  const ghActionsUrl = `https://github.com/${githubRepo}/actions`;
  const nextLogs: StageLogEntry[] = [
    ...existing.stageLogs,
    {
      timestamp: new Date().toISOString(),
      stage: "queued",
      message:
        "Raw FASTQ upload verified! Dispatched job to GitHub Actions (4 vCPU / 16 GB RAM runner). You can safely close your browser or turn off your PC.",
      level: "success",
    },
  ];

  const updated = await db.sql<DbJobRow>`
    UPDATE wgs_jobs
    SET status = ${"queued"},
        current_stage = ${"Queued on GitHub Actions (16 GB RAM Linux runner)"},
        progress = ${12},
        error_message = NULL,
        gh_run_url = ${ghActionsUrl},
        stage_logs = ${JSON.stringify(nextLogs)}::jsonb,
        updated_at = NOW()
    WHERE id = ${jobId}
    RETURNING *
  `;

  return Response.json({ job: mapRowToJob(updated[0]) });
};

export const config: Config = {
  path: "/api/jobs/:id/start",
};
