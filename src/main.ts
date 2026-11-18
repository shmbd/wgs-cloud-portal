import { DEMO_SH1393_JOB } from "./demo-data.ts";
import type { AnnotatedGene, WgsJob } from "./types.ts";

interface ReadinessState {
  passcodeConfigured: boolean;
  webhookConfigured: boolean;
  githubConfigured: boolean;
  r2Configured: boolean;
  githubRepo: string | null;
}

const TOKEN_KEY = "bioforge_wgs_token";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  authenticated: false,
  readiness: null as ReadinessState | null,
  showChecklist: false,
  jobs: [] as WgsJob[],
  selectedJob: DEMO_SH1393_JOB as WgsJob,
  activeTab: "overview" as "overview" | "assembly" | "annotation" | "amr" | "logs",
  geneSearch: "",
  geneTypeFilter: "ALL",
  loginError: "",
  formError: "",
  formSuccess: "",
  r1File: null as File | null,
  r2File: null as File | null,
  sampleName: "",
  genus: "Streptomyces",
  species: "sp.",
  strain: "",
  runFastp: true,
  spadesMode: "isolate" as "isolate" | "careful",
  minContigLen: 500,
  runProkka: true,
  runAbricate: true,
  uploading: false,
  r1Progress: 0,
  r2Progress: 0,
  uploadRateMbps: 0,
};

function esc(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString();
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetch(path, { ...init, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data as T;
}

function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number, mbps: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTs = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
        const elapsedSec = Math.max(0.2, (performance.now() - startTs) / 1000);
        const mbps = ev.loaded / (1024 * 1024) / elapsedSec;
        onProgress(pct, mbps);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100, 0);
        resolve();
      } else {
        reject(
          new Error(
            `R2 upload failed (HTTP ${xhr.status}). Ensure CORS is enabled on your Cloudflare R2 bucket.`
          )
        );
      }
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "Network/CORS error during R2 upload. Check your Cloudflare R2 CORS policy in SETUP_GUIDE.md."
        )
      );
    xhr.send(file);
  });
}

async function checkAuthStatus() {
  try {
    const res = await apiFetch<{
      authenticated: boolean;
      readiness: ReadinessState;
    }>("/api/auth/status");
    state.authenticated = res.authenticated;
    state.readiness = res.readiness;
    if (state.authenticated) {
      await refreshJobs(true);
    }
  } catch {
    // Offline or static preview fallback
  }
  render();
}

async function refreshJobs(selectNewestIfDemo = false) {
  if (!state.authenticated) return;
  try {
    const res = await apiFetch<{ jobs: WgsJob[] }>("/api/jobs");
    state.jobs = res.jobs;
    if (selectNewestIfDemo && state.selectedJob.isDemo && res.jobs.length > 0) {
      await selectJob(res.jobs[0].id);
      return;
    }
    if (!state.selectedJob.isDemo) {
      const stillExists = res.jobs.find((j) => j.id === state.selectedJob.id);
      if (stillExists) {
        await selectJob(state.selectedJob.id);
        return;
      }
    }
    render();
  } catch {
    // Ignore transient polling failures
  }
}

async function selectJob(jobId: string) {
  if (jobId === DEMO_SH1393_JOB.id) {
    state.selectedJob = DEMO_SH1393_JOB;
    render();
    return;
  }
  try {
    const res = await apiFetch<{ job: WgsJob }>(`/api/jobs/${jobId}`);
    state.selectedJob = res.job;
    render();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to load job details");
  }
}

function exportGenesCsv(genes: AnnotatedGene[], sampleName: string) {
  const header = ["locus_tag", "ftype", "length_bp", "gene", "EC_number", "COG", "product"];
  const rows = genes.map((g) =>
    [g.locus_tag, g.ftype, g.length_bp, g.gene, g.ec_number, g.cog, g.product]
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );
  const blob = new Blob([[header.join(","), ...rows].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sampleName}_annotated_genes.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderTopbar(): string {
  const r = state.readiness;
  const allReady =
    r &&
    r.passcodeConfigured &&
    r.webhookConfigured &&
    r.githubConfigured &&
    r.r2Configured;

  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-icon">WGS</div>
        <div>
          <div class="brand-title">BioForge WGS Cloud</div>
          <div class="brand-sub">Automated Bacterial &amp; Streptomyces Assembly, QC &amp; Annotation</div>
        </div>
      </div>
      <div class="topbar-actions">
        <span class="chip">GitHub Runner: 4 vCPU · 16 GB RAM</span>
        <span class="chip">Storage: Cloudflare R2 Auto-Purge</span>
        <button class="btn btn-secondary btn-sm" id="btn-toggle-checklist">
          ${allReady ? "✓ Cloud Ready" : "⚙ Cloud Setup Status"}
        </button>
        <button class="btn btn-secondary btn-sm" id="btn-load-demo">
          View SH-1393 Showcase
        </button>
        ${
          state.authenticated
            ? `<button class="btn btn-secondary btn-sm" id="btn-logout">Lock Portal</button>`
            : ""
        }
      </div>
    </header>
  `;
}

function renderChecklistBanner(): string {
  if (!state.showChecklist) return "";
  const r = state.readiness;
  const item = (ok: boolean | undefined, label: string, hint: string) => `
    <div class="check-card">
      <div style="font-weight:600; color:${ok ? "#6ee7b7" : "#fcd34d"}">
        ${ok ? "✓" : "○"} ${esc(label)}
      </div>
      <div style="color:var(--text-muted); font-size:0.75rem; margin-top:0.2rem">${esc(hint)}</div>
    </div>
  `;
  return `
    <div style="max-width:1600px; margin:1rem auto 0; padding:0 1.5rem;">
      <div class="card">
        <div class="card-title">
          <span>Cloud Integration Readiness</span>
          <span style="font-size:0.78rem; color:var(--text-muted)">See SETUP_GUIDE.md for step-by-step instructions</span>
        </div>
        <div class="checklist-grid">
          ${item(r?.passcodeConfigured, "PORTAL_PASSCODE", "Protects web uploads & downloads")}
          ${item(r?.webhookConfigured, "WEBHOOK_SECRET", "Authenticates GitHub runner callbacks")}
          ${item(r?.githubConfigured, "GITHUB_REPO & GITHUB_TOKEN", r?.githubRepo ? `Connected: ${r.githubRepo}` : "Triggers 16 GB RAM workflow")}
          ${item(r?.r2Configured, "Cloudflare R2 Keys", "Streams 1 GB FASTQs with $0 egress")}
        </div>
      </div>
    </div>
  `;
}

function renderSidebar(): string {
  if (!state.authenticated) {
    return `
      <aside>
        <div class="card">
          <div class="card-title">Unlock Lab Portal</div>
          <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:0.85rem;">
            Sign in with your lab passcode to upload paired-end FASTQ reads and dispatch cloud assembly &amp; annotation runs.
          </p>
          ${state.loginError ? `<div class="banner error">${esc(state.loginError)}</div>` : ""}
          <form id="form-login">
            <div class="field">
              <label>Lab Passcode</label>
              <input type="password" id="input-passcode" placeholder="Enter PORTAL_PASSCODE" required />
            </div>
            <button type="submit" class="btn btn-primary">Unlock Cloud Pipeline</button>
          </form>
        </div>

        <div class="card">
          <div class="card-title">Interactive Showcase</div>
          <div class="job-item ${state.selectedJob.isDemo ? "active" : ""}" data-job-id="${DEMO_SH1393_JOB.id}">
            <div class="job-item-top">
              <span class="job-sample">SH-1393 (Streptomyces)</span>
              <span class="badge demo">Showcase</span>
            </div>
            <div style="font-size:0.77rem; color:var(--text-muted); margin-top:0.3rem;">
              7.54 Mb · 114 contigs · N50 181.3 kb · 71.77% GC
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  return `
    <aside>
      <div class="card">
        <div class="card-title">
          <span>New WGS Analysis</span>
          <span class="chip ok">16 GB Cloud Runner</span>
        </div>
        ${state.formError ? `<div class="banner error">${esc(state.formError)}</div>` : ""}
        ${state.formSuccess ? `<div class="banner info">${esc(state.formSuccess)}</div>` : ""}

        <form id="form-new-job">
          <div class="grid-2">
            <div class="field">
              <label>Sample / Isolate ID *</label>
              <input type="text" id="inp-sample" value="${esc(state.sampleName)}" placeholder="e.g. SH-1393" required ${state.uploading ? "disabled" : ""} />
            </div>
            <div class="field">
              <label>Strain Label</label>
              <input type="text" id="inp-strain" value="${esc(state.strain)}" placeholder="e.g. MBD-SH1393" ${state.uploading ? "disabled" : ""} />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>Genus</label>
              <input type="text" id="inp-genus" value="${esc(state.genus)}" placeholder="Streptomyces" ${state.uploading ? "disabled" : ""} />
            </div>
            <div class="field">
              <label>Species</label>
              <input type="text" id="inp-species" value="${esc(state.species)}" placeholder="sp." ${state.uploading ? "disabled" : ""} />
            </div>
          </div>

          <div class="field">
            <label>Forward Reads (R1 — .fastq.gz / .fq.gz) *</label>
            <label class="file-drop">
              <input type="file" id="inp-r1" accept=".gz,.fastq,.fq" ${state.uploading ? "disabled" : ""} />
              <div class="file-drop-name">
                ${state.r1File ? `${esc(state.r1File.name)} (${fmtBytes(state.r1File.size)})` : "Click to select R1 paired-end file"}
              </div>
              <div class="file-drop-hint">Supports .fastq.gz, .fq.gz, .fq_China.gz, .fastq_NIB.gz</div>
            </label>
          </div>

          <div class="field">
            <label>Reverse Reads (R2 — .fastq.gz / .fq.gz) *</label>
            <label class="file-drop">
              <input type="file" id="inp-r2" accept=".gz,.fastq,.fq" ${state.uploading ? "disabled" : ""} />
              <div class="file-drop-name">
                ${state.r2File ? `${esc(state.r2File.name)} (${fmtBytes(state.r2File.size)})` : "Click to select R2 paired-end file"}
              </div>
              <div class="file-drop-hint">Direct encrypted stream to Cloudflare R2</div>
            </label>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>SPAdes Mode</label>
              <select id="inp-spades-mode" ${state.uploading ? "disabled" : ""}>
                <option value="isolate" ${state.spadesMode === "isolate" ? "selected" : ""}>--isolate (Fast, High-Cov)</option>
                <option value="careful" ${state.spadesMode === "careful" ? "selected" : ""}>--careful (BayesHammer)</option>
              </select>
            </div>
            <div class="field">
              <label>Min Contig (bp)</label>
              <input type="number" id="inp-min-len" value="${state.minContigLen}" min="200" max="5000" step="100" ${state.uploading ? "disabled" : ""} />
            </div>
          </div>

          <div class="checkbox-list">
            <label class="checkbox-row">
              <input type="checkbox" id="chk-fastp" ${state.runFastp ? "checked" : ""} ${state.uploading ? "disabled" : ""} />
              <span>Adapter trimming &amp; Read QC (<b>fastp</b>)</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" id="chk-prokka" ${state.runProkka ? "checked" : ""} ${state.uploading ? "disabled" : ""} />
              <span>Genome Annotation (<b>Prokka</b> — GBK, GFF, FAA)</span>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" id="chk-abricate" ${state.runAbricate ? "checked" : ""} ${state.uploading ? "disabled" : ""} />
              <span>AMR &amp; Virulence Screening (<b>ABRicate</b> CARD/VFDB)</span>
            </label>
          </div>

          <button type="submit" class="btn btn-primary" ${state.uploading ? "disabled" : ""}>
            ${state.uploading ? "Uploading FASTQ Streams..." : "Upload & Start Cloud Pipeline"}
          </button>

          ${
            state.uploading
              ? `
            <div class="upload-box">
              <div style="font-size:0.78rem; display:flex; justify-content:space-between;">
                <span>R1 Upload: ${state.r1Progress}%</span>
                <span class="mono">${state.uploadRateMbps > 0 ? `${state.uploadRateMbps.toFixed(1)} MB/s` : ""}</span>
              </div>
              <div class="progress-track"><div class="progress-fill" style="width:${state.r1Progress}%"></div></div>
              <div style="font-size:0.78rem; margin-top:0.55rem;">R2 Upload: ${state.r2Progress}%</div>
              <div class="progress-track"><div class="progress-fill" style="width:${state.r2Progress}%"></div></div>
              <div style="font-size:0.73rem; color:var(--text-muted); margin-top:0.5rem;">
                Keep this tab open only until upload reaches 100%. Once queued, you can turn off your PC!
              </div>
            </div>
          `
              : ""
          }
        </form>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Submitted Jobs (${state.jobs.length})</span>
          <button class="btn btn-secondary btn-sm" id="btn-refresh-jobs">Refresh</button>
        </div>
        <div class="job-list">
          ${state.jobs
            .map(
              (j) => `
            <div class="job-item ${state.selectedJob.id === j.id ? "active" : ""}" data-job-id="${esc(j.id)}">
              <div class="job-item-top">
                <span class="job-sample">${esc(j.sampleName)}</span>
                <span class="badge ${esc(j.status)}">${esc(j.status)}</span>
              </div>
              <div style="font-size:0.76rem; color:var(--text-muted); margin-top:0.2rem;">
                <i>${esc(j.genus)} ${esc(j.species)}</i> · ${esc(j.currentStage)}
              </div>
              <div class="progress-track" style="height:5px; margin-top:0.45rem;">
                <div class="progress-fill" style="width:${j.progress}%"></div>
              </div>
            </div>
          `
            )
            .join("")}
          <div class="job-item ${state.selectedJob.isDemo ? "active" : ""}" data-job-id="${DEMO_SH1393_JOB.id}">
            <div class="job-item-top">
              <span class="job-sample">SH-1393 (Showcase)</span>
              <span class="badge demo">Demo</span>
            </div>
            <div style="font-size:0.76rem; color:var(--text-muted); margin-top:0.2rem;">
              <i>Streptomyces sp.</i> · Reference Demo Dataset
            </div>
          </div>
        </div>
      </div>
    </aside>
  `;
}

function renderActiveTab(job: WgsJob): string {
  const m = job.metrics || {};
  const asm = m.assembly;
  const ann = m.annotation;
  const qc = m.readQc;
  const amr = m.amrHits || [];

  if (state.activeTab === "overview") {
    return `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Assembly Size (≥500 bp)</div>
          <div class="kpi-value">${asm?.totalLengthGe500 ? `${(asm.totalLengthGe500 / 1e6).toFixed(2)} Mb` : "—"}</div>
          <div class="kpi-sub">${fmtNum(asm?.totalLengthGe500)} bp total</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Contig N50</div>
          <div class="kpi-value">${asm?.n50 ? `${(asm.n50 / 1e3).toFixed(1)} kb` : "—"}</div>
          <div class="kpi-sub">Largest: ${fmtNum(asm?.largestContig)} bp (L50: ${fmtNum(asm?.l50)})</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Contigs (≥500 bp)</div>
          <div class="kpi-value">${fmtNum(asm?.contigsGe500)}</div>
          <div class="kpi-sub">≥1 kb: ${fmtNum(asm?.contigsGe1000)} contigs</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">GC Content</div>
          <div class="kpi-value">${asm?.gcPercent !== undefined ? `${asm.gcPercent}%` : "—"}</div>
          <div class="kpi-sub">${esc(job.genus)} ${esc(job.species)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Predicted CDS</div>
          <div class="kpi-value">${fmtNum(ann?.cdsCount)}</div>
          <div class="kpi-sub">${fmtNum(ann?.functionalProteins)} functional · ${fmtNum(ann?.hypotheticalProteins)} hypothetical</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">RNA &amp; AMR Hits</div>
          <div class="kpi-value">${ann ? `${ann.rRnaCount ?? 0} rRNA · ${ann.tRnaCount ?? 0} tRNA` : "—"}</div>
          <div class="kpi-sub">${amr.length} AMR/Virulence gene hits</div>
        </div>
      </div>

      <div class="grid-2" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem;">
        <div class="card" style="margin:0;">
          <div class="card-title">Read Quality Filtering (fastp)</div>
          ${
            qc
              ? `
            <table>
              <tbody>
                <tr><td>Raw Paired Reads</td><td class="mono">${fmtNum(qc.rawTotalReads)} (${fmtBytes(qc.rawTotalBases || 0)})</td></tr>
                <tr><td>Clean Retained Reads</td><td class="mono">${fmtNum(qc.cleanTotalReads)} (${fmtBytes(qc.cleanTotalBases || 0)})</td></tr>
                <tr><td>Q30 / Q20 Bases</td><td class="mono">${qc.q30RateAfter}% Q30 · ${qc.q20RateAfter}% Q20</td></tr>
                <tr><td>Read GC &amp; Duplication</td><td class="mono">${qc.gcContentReads}% GC · ${qc.duplicationRate}% dup</td></tr>
                <tr><td>Adapter-Trimmed Reads</td><td class="mono">${fmtNum(qc.adapterTrimmedReads)}</td></tr>
              </tbody>
            </table>
          `
              : `<p style="color:var(--text-muted); font-size:0.83rem;">Read QC metrics will appear here once fastp finishes.</p>`
          }
        </div>

        <div class="card" style="margin:0;">
          <div class="card-title">Run Configuration &amp; Storage Status</div>
          <table>
            <tbody>
              <tr><td>Forward / Reverse Input</td><td class="mono">${esc(job.r1Filename)} / ${esc(job.r2Filename)}</td></tr>
              <tr><td>Input Payload Size</td><td class="mono">${fmtBytes(job.r1SizeBytes + job.r2SizeBytes)}</td></tr>
              <tr><td>SPAdes Mode / Cutoff</td><td class="mono">--${esc(job.pipelineOptions.spadesMode)} · ≥${job.pipelineOptions.minContigLen} bp</td></tr>
              <tr><td>R2 Raw FASTQ Cleanup</td><td class="mono">${job.rawReadsDeleted ? "✓ Purged automatically" : "Pending assembly completion"}</td></tr>
              <tr><td>Cloud Compute Runtime</td><td class="mono">${m.runtimeSeconds ? `${Math.floor(m.runtimeSeconds / 60)}m ${m.runtimeSeconds % 60}s` : "In progress"}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (state.activeTab === "assembly") {
    if (!asm) {
      return `<p style="color:var(--text-muted);">Assembly metrics will populate automatically as soon as SPAdes and QUAST complete.</p>`;
    }
    const maxBinBp = Math.max(1, ...(asm.contigBins || []).map((b) => b.totalBp));
    return `
      <div class="card" style="margin-bottom:1rem;">
        <div class="card-title">Contig Size Distribution (Total Base Pairs per Bin)</div>
        <div class="bar-chart">
          ${(asm.contigBins || [])
            .map(
              (b) => `
            <div class="bar-row">
              <div><b>${esc(b.label)}</b> <span style="color:var(--text-muted)">(${b.count} contigs)</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (b.totalBp / maxBinBp) * 100)}%"></div></div>
              <div class="bar-val">${(b.totalBp / 1e6).toFixed(2)} Mb</div>
            </div>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Top Largest Assembled Scaffolds / Contigs</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Contig Header</th>
                <th>Length (bp)</th>
                <th>Coverage</th>
                <th>GC (%)</th>
              </tr>
            </thead>
            <tbody>
              ${(asm.topContigs || [])
                .map(
                  (c, idx) => `
                <tr>
                  <td class="mono">${idx + 1}</td>
                  <td class="mono">${esc(c.name)}</td>
                  <td class="mono">${fmtNum(c.length)}</td>
                  <td class="mono">${c.coverage ? `${c.coverage}×` : "—"}</td>
                  <td class="mono">${c.gc}%</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (state.activeTab === "annotation") {
    if (!ann) {
      return `<p style="color:var(--text-muted);">Genome annotation summary and searchable gene table will appear once Prokka finishes.</p>`;
    }
    const maxCat = Math.max(
      1,
      ...(ann.functionalCategories || []).map((c) => c.count)
    );
    const allGenes = job.genes || [];
    const q = state.geneSearch.trim().toLowerCase();
    const filteredGenes = allGenes.filter((g) => {
      if (state.geneTypeFilter !== "ALL" && g.ftype !== state.geneTypeFilter) {
        return false;
      }
      if (!q) return true;
      return (
        g.gene.toLowerCase().includes(q) ||
        g.product.toLowerCase().includes(q) ||
        g.locus_tag.toLowerCase().includes(q) ||
        g.ec_number.toLowerCase().includes(q) ||
        g.cog.toLowerCase().includes(q)
      );
    });

    return `
      <div class="card" style="margin-bottom:1rem;">
        <div class="card-title">
          <span>Functional Subsystem Breakdown (${fmtNum(ann.cdsCount)} CDS · Coding Density ${ann.codingDensityPercent}%)</span>
        </div>
        <div class="bar-chart">
          ${(ann.functionalCategories || [])
            .map(
              (c) => `
            <div class="bar-row">
              <div>${esc(c.category)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (c.count / maxCat) * 100)}%"></div></div>
              <div class="bar-val">${fmtNum(c.count)} CDS</div>
            </div>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Annotated Gene Explorer (${fmtNum(filteredGenes.length)} matching features)</span>
          <button class="btn btn-secondary btn-sm" id="btn-export-csv">Export CSV</button>
        </div>
        <div class="filter-bar">
          <input type="text" id="inp-gene-search" value="${esc(state.geneSearch)}" placeholder="Search gene (e.g. pks, nrps, rpoB, gyrB, tetR), product, EC number, or locus tag..." />
          <select id="sel-gene-type">
            <option value="ALL" ${state.geneTypeFilter === "ALL" ? "selected" : ""}>All Features</option>
            <option value="CDS" ${state.geneTypeFilter === "CDS" ? "selected" : ""}>CDS Only</option>
            <option value="rRNA" ${state.geneTypeFilter === "rRNA" ? "selected" : ""}>rRNA</option>
            <option value="tRNA" ${state.geneTypeFilter === "tRNA" ? "selected" : ""}>tRNA</option>
          </select>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Locus Tag</th>
                <th>Type</th>
                <th>Gene</th>
                <th>Length (bp)</th>
                <th>EC / COG</th>
                <th>Annotated Product</th>
              </tr>
            </thead>
            <tbody>
              ${filteredGenes
                .slice(0, 200)
                .map(
                  (g) => `
                <tr>
                  <td class="mono">${esc(g.locus_tag)}</td>
                  <td><span class="chip">${esc(g.ftype)}</span></td>
                  <td class="mono" style="color:var(--cyan)">${esc(g.gene || "—")}</td>
                  <td class="mono">${fmtNum(g.length_bp)}</td>
                  <td class="mono">${esc([g.ec_number, g.cog].filter(Boolean).join(" · ") || "—")}</td>
                  <td>${esc(g.product)}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
        ${
          filteredGenes.length > 200
            ? `<div style="font-size:0.76rem; color:var(--text-muted); margin-top:0.55rem;">Showing first 200 of ${fmtNum(filteredGenes.length)} matches — use search or Export CSV for the full list.</div>`
            : ""
        }
      </div>
    `;
  }

  if (state.activeTab === "amr") {
    return `
      <div class="card">
        <div class="card-title">Antimicrobial Resistance &amp; Virulence Gene Hits (ABRicate: CARD · NCBI · VFDB)</div>
        ${
          amr.length === 0
            ? `<p style="color:var(--text-muted); font-size:0.84rem;">${job.status === "completed" ? "No high-identity AMR or virulence determinants above threshold (≥75% identity, ≥60% coverage) detected." : "AMR screening runs after genome assembly completes."}</p>`
            : `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>DB</th>
                  <th>Gene</th>
                  <th>Resistance Class</th>
                  <th>% Identity</th>
                  <th>% Coverage</th>
                  <th>Contig Location</th>
                  <th>Product</th>
                </tr>
              </thead>
              <tbody>
                ${amr
                  .map(
                    (h) => `
                  <tr>
                    <td><span class="chip ok">${esc(h.database)}</span></td>
                    <td class="mono" style="font-weight:600; color:var(--cyan)">${esc(h.gene)}</td>
                    <td>${esc(h.resistance || "—")}</td>
                    <td class="mono">${h.identityPercent.toFixed(1)}%</td>
                    <td class="mono">${h.coveragePercent.toFixed(1)}%</td>
                    <td class="mono">${esc(h.sequence)}:${h.start}-${h.end} (${esc(h.strand)})</td>
                    <td>${esc(h.product)}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
        }
      </div>
    `;
  }

  return `
    <div class="log-box">
      ${(job.stageLogs || [])
        .map(
          (l) => `
        <div class="log-entry">
          <span class="log-time">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
          <span class="log-msg ${esc(l.level || "info")}">[${esc(l.stage)}] ${esc(l.message)}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderWorkspace(): string {
  const job = state.selectedJob;
  const dl = job.downloadLinks || {};

  return `
    <main>
      <div class="card">
        <div class="hero-header">
          <div>
            <div class="hero-title">
              <span class="mono">${esc(job.sampleName)}</span>
              <span style="font-weight:400; color:var(--text-muted)"><i>${esc(job.genus)} ${esc(job.species)}</i> ${job.strain ? `(${esc(job.strain)})` : ""}</span>
              <span class="badge ${job.isDemo ? "demo" : esc(job.status)}">${job.isDemo ? "SH-1393 Showcase" : esc(job.status)}</span>
            </div>
            <div class="hero-meta">
              Stage: <b>${esc(job.currentStage)}</b> · Progress: <b>${job.progress}%</b>
              ${job.ghRunUrl ? ` · <a href="${esc(job.ghRunUrl)}" target="_blank" rel="noopener" style="color:var(--cyan)">Open Live GitHub Runner Logs ↗</a>` : ""}
            </div>
          </div>
          ${
            !job.isDemo && state.authenticated
              ? `<button class="btn btn-danger btn-sm" id="btn-delete-job">Delete Job</button>`
              : ""
          }
        </div>

        <div class="progress-track" style="height:10px; margin-bottom:0.85rem;">
          <div class="progress-fill" style="width:${job.progress}%"></div>
        </div>

        ${job.errorMessage ? `<div class="banner error"><b>Error:</b> ${esc(job.errorMessage)}</div>` : ""}

        ${
          dl.resultsZipUrl || dl.contigsFastaUrl || dl.genbankUrl || dl.quastHtmlUrl
            ? `
          <div class="download-bar">
            <span style="font-size:0.82rem; font-weight:600; color:#6ee7b7; margin-right:0.35rem;">Download Outputs:</span>
            ${dl.resultsZipUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(dl.resultsZipUrl)}">⬇ Complete Results (.ZIP)</a>` : ""}
            ${dl.contigsFastaUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(dl.contigsFastaUrl)}">⬇ Filtered Contigs (.FASTA)</a>` : ""}
            ${dl.genbankUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(dl.genbankUrl)}">⬇ Prokka Annotation (.GBK)</a>` : ""}
            ${dl.quastHtmlUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(dl.quastHtmlUrl)}">⬇ QUAST Report (.HTML)</a>` : ""}
          </div>
        `
            : job.isDemo
              ? `
          <div class="banner info">
            <b>Interactive Showcase Active:</b> Displaying real assembly metrics from <b>Streptomyces sp. SH-1393</b> (7,535,635 bp, 114 contigs ≥500 bp, N50 = 181,304 bp, 71.77% GC) alongside representative Prokka &amp; CARD annotations. Unlock the portal on the left to run new genomes in the cloud!
          </div>
        `
              : ""
        }

        <div class="tabs">
          <button class="tab-btn ${state.activeTab === "overview" ? "active" : ""}" data-tab="overview">Overview &amp; Read QC</button>
          <button class="tab-btn ${state.activeTab === "assembly" ? "active" : ""}" data-tab="assembly">Assembly &amp; QUAST</button>
          <button class="tab-btn ${state.activeTab === "annotation" ? "active" : ""}" data-tab="annotation">Genome Annotation (Prokka)</button>
          <button class="tab-btn ${state.activeTab === "amr" ? "active" : ""}" data-tab="amr">AMR &amp; Virulence</button>
          <button class="tab-btn ${state.activeTab === "logs" ? "active" : ""}" data-tab="logs">Pipeline Logs (${job.stageLogs.length})</button>
        </div>

        ${renderActiveTab(job)}
      </div>
    </main>
  `;
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;

  const activeElId = (document.activeElement as HTMLElement | null)?.id;
  const selectionStart = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;

  app.innerHTML = `
    ${renderTopbar()}
    ${renderChecklistBanner()}
    <div class="layout">
      ${renderSidebar()}
      ${renderWorkspace()}
    </div>
  `;

  bindEvents();

  if (activeElId) {
    const restored = document.getElementById(activeElId) as HTMLInputElement | null;
    if (restored) {
      restored.focus();
      if (selectionStart !== null && typeof restored.setSelectionRange === "function") {
        try {
          restored.setSelectionRange(selectionStart, selectionStart);
        } catch {
          // Ignore non-text inputs
        }
      }
    }
  }
}

function bindEvents() {
  document.getElementById("btn-toggle-checklist")?.addEventListener("click", () => {
    state.showChecklist = !state.showChecklist;
    render();
  });

  document.getElementById("btn-load-demo")?.addEventListener("click", () => {
    state.selectedJob = DEMO_SH1393_JOB;
    render();
  });

  document.getElementById("btn-logout")?.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    state.authenticated = false;
    state.selectedJob = DEMO_SH1393_JOB;
    render();
  });

  document.getElementById("form-login")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.loginError = "";
    const pass = (document.getElementById("input-passcode") as HTMLInputElement)?.value || "";
    try {
      const res = await apiFetch<{ token: string; readiness: ReadinessState }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ passcode: pass }),
      });
      state.token = res.token;
      localStorage.setItem(TOKEN_KEY, res.token);
      state.authenticated = true;
      state.readiness = res.readiness;
      await refreshJobs(true);
    } catch (err) {
      state.loginError = err instanceof Error ? err.message : "Login failed";
      render();
    }
  });

  document.getElementById("inp-sample")?.addEventListener("input", (e) => {
    state.sampleName = (e.target as HTMLInputElement).value;
  });
  document.getElementById("inp-strain")?.addEventListener("input", (e) => {
    state.strain = (e.target as HTMLInputElement).value;
  });
  document.getElementById("inp-genus")?.addEventListener("input", (e) => {
    state.genus = (e.target as HTMLInputElement).value;
  });
  document.getElementById("inp-species")?.addEventListener("input", (e) => {
    state.species = (e.target as HTMLInputElement).value;
  });
  document.getElementById("inp-spades-mode")?.addEventListener("change", (e) => {
    state.spadesMode = (e.target as HTMLSelectElement).value as "isolate" | "careful";
  });
  document.getElementById("inp-min-len")?.addEventListener("change", (e) => {
    state.minContigLen = Number((e.target as HTMLInputElement).value) || 500;
  });
  document.getElementById("chk-fastp")?.addEventListener("change", (e) => {
    state.runFastp = (e.target as HTMLInputElement).checked;
  });
  document.getElementById("chk-prokka")?.addEventListener("change", (e) => {
    state.runProkka = (e.target as HTMLInputElement).checked;
  });
  document.getElementById("chk-abricate")?.addEventListener("change", (e) => {
    state.runAbricate = (e.target as HTMLInputElement).checked;
  });

  document.getElementById("inp-r1")?.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.[0]) {
      state.r1File = files[0];
      if (!state.sampleName) {
        state.sampleName = files[0].name.replace(/(_R?1.*|\.f(ast)?q.*)$/i, "");
      }
      render();
    }
  });

  document.getElementById("inp-r2")?.addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.[0]) {
      state.r2File = files[0];
      render();
    }
  });

  document.getElementById("form-new-job")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.formError = "";
    state.formSuccess = "";

    if (!state.r1File || !state.r2File) {
      state.formError = "Please select both R1 and R2 paired-end FASTQ files.";
      render();
      return;
    }

    state.uploading = true;
    state.r1Progress = 0;
    state.r2Progress = 0;
    render();

    try {
      const created = await apiFetch<{
        job: WgsJob;
        r1UploadUrl: string;
        r2UploadUrl: string;
      }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          sampleName: state.sampleName,
          genus: state.genus,
          species: state.species,
          strain: state.strain || state.sampleName,
          r1Filename: state.r1File.name,
          r2Filename: state.r2File.name,
          r1SizeBytes: state.r1File.size,
          r2SizeBytes: state.r2File.size,
          pipelineOptions: {
            runFastp: state.runFastp,
            spadesMode: state.spadesMode,
            minContigLen: state.minContigLen,
            runProkka: state.runProkka,
            runAbricate: state.runAbricate,
          },
        }),
      });

      await uploadWithProgress(created.r1UploadUrl, state.r1File, (pct, mbps) => {
        state.r1Progress = pct;
        state.uploadRateMbps = mbps;
        render();
      });

      await uploadWithProgress(created.r2UploadUrl, state.r2File, (pct, mbps) => {
        state.r2Progress = pct;
        state.uploadRateMbps = mbps;
        render();
      });

      const started = await apiFetch<{ job: WgsJob }>(
        `/api/jobs/${created.job.id}/start`,
        { method: "POST" }
      );

      state.uploading = false;
      state.r1File = null;
      state.r2File = null;
      state.sampleName = "";
      state.strain = "";
      state.selectedJob = started.job;
      state.formSuccess =
        "Upload 100% complete & GitHub 16 GB runner triggered! You can safely close this browser or shut down your PC.";
      await refreshJobs(false);
    } catch (err) {
      state.uploading = false;
      state.formError = err instanceof Error ? err.message : "Pipeline submission failed";
      render();
    }
  });

  document.getElementById("btn-refresh-jobs")?.addEventListener("click", () => {
    refreshJobs(false);
  });

  document.querySelectorAll<HTMLElement>("[data-job-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.jobId;
      if (id) selectJob(id);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      const tab = el.dataset.tab as typeof state.activeTab;
      if (tab) {
        state.activeTab = tab;
        render();
      }
    });
  });

  document.getElementById("inp-gene-search")?.addEventListener("input", (e) => {
    state.geneSearch = (e.target as HTMLInputElement).value;
    render();
  });

  document.getElementById("sel-gene-type")?.addEventListener("change", (e) => {
    state.geneTypeFilter = (e.target as HTMLSelectElement).value;
    render();
  });

  document.getElementById("btn-export-csv")?.addEventListener("click", () => {
    exportGenesCsv(state.selectedJob.genes || [], state.selectedJob.sampleName);
  });

  document.getElementById("btn-delete-job")?.addEventListener("click", async () => {
    if (state.selectedJob.isDemo) return;
    if (!confirm(`Delete job ${state.selectedJob.sampleName} and all cloud files?`)) return;
    try {
      await apiFetch(`/api/jobs/${state.selectedJob.id}`, { method: "DELETE" });
      state.selectedJob = DEMO_SH1393_JOB;
      await refreshJobs(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete job");
    }
  });
}

// Poll active cloud jobs automatically every 8 seconds
setInterval(() => {
  if (!state.authenticated || state.uploading) return;
  const hasActive = state.jobs.some((j) =>
    ["uploading", "queued", "running"].includes(j.status)
  );
  if (hasActive || ["queued", "running"].includes(state.selectedJob.status)) {
    refreshJobs(false);
  }
}, 8000);

render();
checkAuthStatus();
