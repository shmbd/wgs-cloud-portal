# BioForge WGS Cloud Portal — Setup & Deployment Guide

This project runs a **100% cloud-hosted bacterial & *Streptomyces* Whole-Genome Sequencing (WGS) pipeline** (`fastp` → `SPAdes` → `QUAST` → `Prokka` → `ABRicate`) for **$0/month** on free tiers:

- **Netlify**: Hosts the web dashboard, serverless API (`netlify/functions`), auto-provisioned Postgres job tracker (`@netlify/database`), and gene catalog store (`@netlify/blobs`).
- **Cloudflare R2 (Free 10 GB, $0 bandwidth)**: Receives direct encrypted ~1 GB paired-end `.fastq.gz` uploads from your browser and automatically deletes raw reads as soon as SPAdes finishes so your free 10 GB bucket never fills up.
- **GitHub Actions (4 vCPU, 16 GB RAM Ubuntu runner)**: Executes the heavy assembly and annotation in the cloud—**you can shut down your PC immediately after uploading**.

---

## Step 1: Push This Folder to a Private GitHub Repository

1. Create a **new Private repository** on GitHub (for example: `wgs-cloud-portal`).
2. Open a terminal in `D:\wgs-cloud-portal` and push the code:
   ```powershell
   cd D:\wgs-cloud-portal
   git init
   git branch -M main
   git add .
   git commit -m "Initial BioForge WGS Cloud Portal"
   git remote add origin https://github.com/<YOUR_USERNAME>/wgs-cloud-portal.git
   git push -u origin main
   ```

---

## Step 2: Create a Free Cloudflare R2 Bucket (5 Minutes)

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com/) → **R2 Object Storage** → **Create bucket** → name it `wgs-pipeline-storage`.
2. Open your bucket → **Settings** → **CORS Policy** → click **Add CORS policy** and paste:
   ```json
   [
     {
       "AllowedOrigins": [
         "https://*.netlify.app",
         "http://localhost:5173",
         "http://localhost:8888"
       ],
       "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. Go back to **R2 Overview** → **Manage R2 API Tokens** → **Create API token**:
   - Permissions: **Object Read & Write** scoped to `wgs-pipeline-storage`
   - Copy these 4 values:
     - `R2_ACCOUNT_ID` (your 32-character Cloudflare Account ID)
     - `R2_ACCESS_KEY_ID`
     - `R2_SECRET_ACCESS_KEY`
     - `R2_BUCKET_NAME` (`wgs-pipeline-storage`)

---

## Step 3: Create Your GitHub Token & Repo Secret

1. **Generate a Fine-Grained Personal Access Token**:
   - Go to GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
   - **Repository access**: *Only select repositories* → pick `wgs-cloud-portal`.
   - **Repository permissions** → **Actions**: **Read and write** (`Metadata: Read-only` is selected automatically).
   - Generate and copy the token (`github_pat_...`) as `GITHUB_TOKEN`.
2. **Add `WEBHOOK_SECRET` to GitHub Actions Secrets**:
   - Pick any strong random string (e.g. `mbd_nib_wgs_secret_2026_9f8a7b6c5d`).
   - In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
     - Name: `WEBHOOK_SECRET`
     - Secret: *(paste that exact string)*

---

## Step 4: Deploy to Netlify & Set Environment Variables

1. Log in to [app.netlify.com](https://app.netlify.com/) → **Add new site** → **Import an existing project** → connect your GitHub `wgs-cloud-portal` repository.
   - Build command: `npm run build` *(auto-detected from `netlify.toml`)*
   - Publish directory: `dist` *(auto-detected from `netlify.toml`)*
   - Netlify automatically provisions your **Netlify Database** (`netlify/database/migrations/0001_init.sql`) and **Netlify Blobs**.
2. Go to **Site configuration** → **Environment variables** and add (with **Functions** + **Builds** scopes):

   | Variable | Value |
   | :--- | :--- |
   | `PORTAL_PASSCODE` | Password you will type in the web UI to unlock uploads |
   | `WEBHOOK_SECRET` | Exact same `WEBHOOK_SECRET` added to GitHub Actions Secrets |
   | `GITHUB_REPO` | `<YOUR_USERNAME>/wgs-cloud-portal` |
   | `GITHUB_TOKEN` | Your `github_pat_...` token from Step 3 |
   | `GITHUB_BRANCH` | `main` |
   | `R2_ACCOUNT_ID` | Your Cloudflare Account ID |
   | `R2_ACCESS_KEY_ID` | Your R2 Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | Your R2 Secret Access Key |
   | `R2_BUCKET_NAME` | `wgs-pipeline-storage` |

3. Trigger a **Redeploy** (**Deploys** → **Trigger deploy** → **Deploy site**) so the environment variables are active in Functions.
4. Open your live `.netlify.app` URL and click **⚙ Cloud Setup Status** in the top bar—all 4 indicators will show green (`✓ Cloud Ready`)!

---

## Local Preview on Your PC (Optional)

If you open `D:\wgs-cloud-portal` in your IDE/terminal:
```powershell
cd D:\wgs-cloud-portal
npm install
npm run dev
```
Vite + `@netlify/vite-plugin` emulates Netlify Functions, Netlify Database, and Netlify Blobs locally at `http://localhost:5173`.
