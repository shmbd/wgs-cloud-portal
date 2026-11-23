# BioForge WGS Cloud Portal — Cloudflare Pages + 16 GB GitHub Runner Guide

This project runs a **100% free, zero-credit-cap** Whole-Genome Sequencing (WGS) pipeline (`fastp` → `SPAdes` → `QUAST` → `Prokka` → `ABRicate`):

- **Cloudflare Pages**: Hosts the web UI and serverless `functions/api/*` endpoints (**500 free deploys/month**, **unlimited bandwidth**, **100,000 free API requests/day**, **no credit system**).
- **Cloudflare R2 (`wgs-pipeline-storage`)**: Stores both job metadata JSON and encrypted FASTQ/result streams (**0 idle database drain**, auto-deletes ~1 GB raw FASTQ files right after SPAdes finishes).
- **GitHub Actions (Public Repo = 4 vCPUs, 16 GB RAM, Unlimited Free Minutes)**: Runs assembly & annotation **2× faster** with strict `::add-mask::` log masking so presigned URLs and genome files stay 100% private inside R2.

---

## Step 1: Push the Updated Code to GitHub

```powershell
cd D:\wgs-cloud-portal
git add .
git commit -m "Migrate to Cloudflare Pages + R2 store + masked 16GB runner"
git push
```

---

## Step 2: Unlock 2× Faster Compute (4 vCPU / 16 GB RAM + Unlimited Minutes)

1. Open your GitHub repository: `https://github.com/shmbd/wgs-cloud-portal/settings`
2. Scroll to the bottom (**Danger Zone**) → **Change repository visibility** → **Change to Public**.
   *(Safe: Your repo contains zero secrets and zero genome files—all sequences stay private in Cloudflare R2, and all presigned URLs are masked in logs.)*

---

## Step 3: Add `*.pages.dev` to Your Cloudflare R2 CORS Policy

1. Open your R2 bucket settings:
   `https://dash.cloudflare.com/72528d98e8dcae6a6411bd6fc4728a6a/r2/default/buckets/wgs-pipeline-storage/settings`
2. Scroll to **CORS Policy** → **Edit** → **JSON** and paste:
   ```json
   [
     {
       "AllowedOrigins": [
         "https://*.pages.dev",
         "http://localhost:5173"
       ],
       "AllowedMethods": [
         "GET",
         "PUT",
         "DELETE",
         "HEAD"
       ],
       "AllowedHeaders": [
         "content-type",
         "Content-Type"
       ],
       "ExposeHeaders": [
         "ETag"
       ],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. Click **Save**.

---

## Step 4: Deploy on Cloudflare Pages (2 Minutes)

1. In your [Cloudflare Dashboard](https://dash.cloudflare.com/), look at the left sidebar → click **Compute (Workers)** → **Workers & Pages** → click **Create** (top right).
2. Switch to the **Pages** tab at the top → click **Import an existing Git repository** (or **Connect to Git**).
3. Select your GitHub account and choose **`wgs-cloud-portal`**.
4. Set build settings:
   - **Project name**: `mbd-wgs-portal` *(gives you `https://mbd-wgs-portal.pages.dev`)*
   - **Production branch**: `main`
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
5. Expand **Environment variables (advanced)** (or add them after creation under **Settings → Variables and Secrets**) and add these 9 variables:
   - `PORTAL_PASSCODE` = your login passcode (e.g. `1349`)
   - `WEBHOOK_SECRET` = exact same `WEBHOOK_SECRET` saved in GitHub Actions Secrets
   - `GITHUB_REPO` = `shmbd/wgs-cloud-portal`
   - `GITHUB_TOKEN` = your valid `github_pat_...` token (with **Actions: Read and write**)
   - `GITHUB_BRANCH` = `main`
   - `R2_ACCOUNT_ID` = `72528d98e8dcae6a6411bd6fc4728a6a`
   - `R2_ACCESS_KEY_ID` = your active R2 Access Key ID
   - `R2_SECRET_ACCESS_KEY` = your matching R2 Secret Access Key
   - `R2_BUCKET_NAME` = `wgs-pipeline-storage`
6. Click **Save and Deploy**! *(If you add/edit variables after the first deploy, go to **Deployments → Retry deployment** once so the variables take effect.)*

---

## Step 5 (Optional): Pause/Delete Old Netlify Project
To keep all 300 Netlify credits solely for `mbd-nib` and `saddam-hossain`, open `https://app.netlify.com/projects/mbd-wgs-portal/configuration/general` → scroll to bottom → **Delete project**.
