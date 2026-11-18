#!/usr/bin/env python3
"""
BioForge WGS Cloud Pipeline Orchestrator
Runs inside GitHub Actions (4 vCPU / 16 GB RAM Ubuntu runner):
  1. Fetches job config & scoped R2 presigned URLs from Netlify Portal
  2. Downloads paired-end FASTQ reads from Cloudflare R2
  3. Runs fastp read QC & adapter trimming
  4. Runs SPAdes de novo genome assembly (--isolate / --careful, 14 GB RAM)
  5. Automatically deletes raw FASTQ uploads from Cloudflare R2 to save storage
  6. Runs QUAST assembly evaluation & contig statistics
  7. Runs Prokka bacterial genome annotation (CDS, rRNA, tRNA, GenBank/GFF/FAA)
  8. Runs ABRicate antimicrobial resistance (CARD, NCBI) & virulence (VFDB) screening
  9. Packages all outputs into a ZIP archive, uploads results to R2, and posts
     interactive metrics & annotated gene catalog back to the Netlify Portal.
"""

import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

START_TIME = time.time()

JOB_ID = os.environ.get("JOB_ID", "").strip()
PORTAL_URL = os.environ.get("PORTAL_URL", "").strip().rstrip("/")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").strip()
GH_RUN_URL = os.environ.get("GH_RUN_URL", "").strip()

if not JOB_ID or not PORTAL_URL or not WEBHOOK_SECRET:
    print("ERROR: Missing JOB_ID, PORTAL_URL, or WEBHOOK_SECRET environment variables.", file=sys.stderr)
    sys.exit(1)

CALLBACK_URL = f"{PORTAL_URL}/api/worker/jobs/{JOB_ID}"


def api_request(method: str, url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {WEBHOOK_SECRET}",
        "User-Agent": "BioForge-WGS-Cloud-Worker/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"

    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except Exception as exc:
            if attempt == 3:
                raise
            print(f"[warn] API {method} retry {attempt + 1}/3 after error: {exc}")
            time.sleep(3 * (attempt + 1))
    return {}


def update_portal(
    *,
    status: str = "running",
    stage_title: str | None = None,
    progress: int | None = None,
    log_stage: str | None = None,
    log_msg: str | None = None,
    log_level: str = "info",
    metrics: dict | None = None,
    genes: list | None = None,
    raw_deleted: bool | None = None,
    output_keys: dict | None = None,
    error_msg: str | None = None,
):
    body: dict = {"status": status}
    if GH_RUN_URL:
        body["ghRunUrl"] = GH_RUN_URL
    if stage_title is not None:
        body["currentStage"] = stage_title
    if progress is not None:
        body["progress"] = progress
    if log_stage and log_msg:
        body["log"] = {"stage": log_stage, "message": log_msg, "level": log_level}
    if metrics is not None:
        body["metrics"] = metrics
    if genes is not None:
        body["genes"] = genes
    if raw_deleted is not None:
        body["rawReadsDeleted"] = raw_deleted
    if output_keys is not None:
        body["outputKeys"] = output_keys
    if error_msg is not None:
        body["errorMessage"] = error_msg

    try:
        api_request("POST", CALLBACK_URL, body)
    except Exception as exc:
        print(f"[warn] Non-fatal status update failure: {exc}", file=sys.stderr)


def run_cmd(cmd: list[str], cwd: Path | None = None):
    print(f"+ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def download_file(presigned_url: str, dest: Path):
    run_cmd([
        "curl", "-fSL", "--retry", "4", "--retry-delay", "5",
        "-o", str(dest), presigned_url
    ])


def upload_file(presigned_url: str, src: Path, content_type: str = "application/octet-stream"):
    run_cmd([
        "curl", "-fSL", "--retry", "4", "--retry-delay", "5",
        "-X", "PUT",
        "-H", f"Content-Type: {content_type}",
        "--upload-file", str(src),
        presigned_url
    ])


def delete_r2_url(presigned_url: str) -> bool:
    try:
        req = urllib.request.Request(presigned_url, method="DELETE")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return True
        print(f"[warn] R2 DELETE HTTP {exc.code}: {exc}", file=sys.stderr)
        return False
    except Exception as exc:
        print(f"[warn] R2 DELETE error: {exc}", file=sys.stderr)
        return False


def parse_fasta_records(fasta_path: Path):
    records = []
    header = None
    seq_chunks = []
    with fasta_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    records.append((header, "".join(seq_chunks)))
                header = line[1:].strip()
                seq_chunks = []
            else:
                seq_chunks.append(line.upper())
        if header is not None:
            records.append((header, "".join(seq_chunks)))
    return records


def compute_assembly_metrics(contigs_fasta: Path, filtered_fasta: Path, min_len: int) -> dict:
    records = parse_fasta_records(contigs_fasta)
    all_lengths = sorted([len(seq) for _, seq in records], reverse=True)

    ge500_lengths = [l for l in all_lengths if l >= 500]
    ge1000_lengths = [l for l in all_lengths if l >= 1000]

    gc_bases = 0
    total_bases_500 = 0
    top_contigs = []
    cov_re = re.compile(r"cov_([0-9.]+)")

    # Write filtered contigs for annotation & AMR
    kept_records = []
    for hdr, seq in records:
        length = len(seq)
        gc = (seq.count("G") + seq.count("C")) / length * 100.0 if length else 0.0
        if length >= 500:
            gc_bases += seq.count("G") + seq.count("C")
            total_bases_500 += length
        if length >= min_len:
            kept_records.append((hdr, seq))
        if len(top_contigs) < 20:
            cov_match = cov_re.search(hdr)
            cov = float(cov_match.group(1)) if cov_match else 0.0
            top_contigs.append({
                "name": hdr.split()[0],
                "length": length,
                "coverage": round(cov, 2),
                "gc": round(gc, 2),
            })

    top_contigs.sort(key=lambda x: x["length"], reverse=True)
    top_contigs = top_contigs[:15]

    with filtered_fasta.open("w", encoding="utf-8") as out_fh:
        for hdr, seq in kept_records:
            out_fh.write(f">{hdr}\n")
            for i in range(0, len(seq), 80):
                out_fh.write(seq[i:i + 80] + "\n")

    def calc_nx(lens: list[int], fraction: float) -> tuple[int, int]:
        if not lens:
            return 0, 0
        target = sum(lens) * fraction
        acc = 0
        for idx, val in enumerate(lens, start=1):
            acc += val
            if acc >= target:
                return val, idx
        return lens[-1], len(lens)

    n50, l50 = calc_nx(ge500_lengths, 0.5)
    n90, _ = calc_nx(ge500_lengths, 0.9)

    bins_spec = [
        ("≥ 100 kb", 100_000, 10**12),
        ("50–100 kb", 50_000, 99_999),
        ("10–50 kb", 10_000, 49_999),
        ("1–10 kb", 1_000, 9_999),
        ("500–999 bp", 500, 999),
    ]
    contig_bins = []
    for label, lo, hi in bins_spec:
        matched = [l for l in ge500_lengths if lo <= l <= hi]
        contig_bins.append({
            "label": label,
            "count": len(matched),
            "totalBp": sum(matched),
        })

    return {
        "totalContigsAll": len(all_lengths),
        "totalLengthAll": sum(all_lengths),
        "contigsGe500": len(ge500_lengths),
        "totalLengthGe500": sum(ge500_lengths),
        "contigsGe1000": len(ge1000_lengths),
        "totalLengthGe1000": sum(ge1000_lengths),
        "largestContig": ge500_lengths[0] if ge500_lengths else (all_lengths[0] if all_lengths else 0),
        "n50": n50,
        "n90": n90,
        "l50": l50,
        "gcPercent": round((gc_bases / total_bases_500 * 100.0), 2) if total_bases_500 else 0.0,
        "contigBins": contig_bins,
        "topContigs": top_contigs,
    }


def classify_gene_product(product: str) -> str:
    p = product.lower()
    if "hypothetical protein" in p or "uncharacterized" in p:
        return "Hypothetical / Uncharacterized"
    if any(k in p for k in ["polyketide", "non-ribosomal", "nrps", "pks", "terpene", "siderophore", "lantibiotic", "bacteriocin", "cytochrome p450", "thioesterase"]):
        return "Secondary Metabolism & BGCs"
    if any(k in p for k in ["transcriptional regulator", "two-component", "sigma factor", "repressor", "activator", "sensor histidine", "luxr", "tetr", "marR", "streptomyces antibiotic regulatory"]):
        return "Regulation & Signal Transduction"
    if any(k in p for k in ["abc transporter", "permease", "efflux", "transporter", "symporter", "antiporter", "porin", "secretion"]):
        return "Transport & Efflux Systems"
    if any(k in p for k in ["ribosomal", "trna", "aminoacyl", "elongation factor", "translation", "chaperone", "dna polymerase", "helicase", "gyrase", "recombinase", "repair"]):
        return "Information Storage & Translation"
    if any(k in p for k in ["resistance", "beta-lactamase", "aminoglycoside", "chloramphenicol", "vancomycin", "macrolide", "stress", "catalase", "superoxide"]):
        return "Defense, Stress & Resistance"
    if any(k in p for k in ["transposase", "integrase", "phage", "insertion element", "plasmid"]):
        return "Mobile Genetic Elements"
    return "Core Metabolism & Enzymes"


def parse_prokka_outputs(prokka_dir: Path, prefix: str, genome_len: int) -> tuple[dict, list[dict]]:
    tsv_path = prokka_dir / f"{prefix}.tsv"
    genes = []
    cds_count = 0
    rrna_count = 0
    trna_count = 0
    tmrna_count = 0
    hypo_count = 0
    func_count = 0
    coding_bp = 0
    cat_counts: dict[str, int] = {}

    if tsv_path.exists():
        with tsv_path.open("r", encoding="utf-8") as fh:
            reader = csv.DictReader(fh, delimiter="\t")
            for row in reader:
                ftype = row.get("ftype", "").strip()
                length_bp = int(row.get("length_bp", "0") or 0)
                product = row.get("product", "").strip()
                gene_sym = row.get("gene", "").strip()
                ec_num = row.get("EC_number", "").strip()
                cog = row.get("COG", "").strip()
                locus = row.get("locus_tag", "").strip()

                if ftype == "CDS":
                    cds_count += 1
                    coding_bp += length_bp
                    if "hypothetical protein" in product.lower():
                        hypo_count += 1
                    else:
                        func_count += 1
                    cat = classify_gene_product(product)
                    cat_counts[cat] = cat_counts.get(cat, 0) + 1
                elif ftype == "rRNA":
                    rrna_count += 1
                elif ftype == "tRNA":
                    trna_count += 1
                elif ftype == "tmRNA":
                    tmrna_count += 1

                if len(genes) < 6000:
                    genes.append({
                        "locus_tag": locus,
                        "ftype": ftype,
                        "length_bp": length_bp,
                        "gene": gene_sym,
                        "ec_number": ec_num,
                        "cog": cog,
                        "product": product,
                    })

    categories_sorted = [
        {"category": k, "count": v}
        for k, v in sorted(cat_counts.items(), key=lambda item: item[1], reverse=True)
    ]

    summary = {
        "cdsCount": cds_count,
        "rRnaCount": rrna_count,
        "tRnaCount": trna_count,
        "tmRnaCount": tmrna_count,
        "hypotheticalProteins": hypo_count,
        "functionalProteins": func_count,
        "codingDensityPercent": round(min(100.0, (coding_bp / genome_len * 100.0)), 2) if genome_len else 0.0,
        "functionalCategories": categories_sorted,
    }
    return summary, genes


def run_abricate_scans(filtered_fasta: Path, out_dir: Path) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    hits = []
    seen = set()

    for db_name in ["card", "ncbi", "vfdb"]:
        tsv_out = out_dir / f"abricate_{db_name}.tsv"
        cmd = [
            "micromamba", "run", "-n", "wgs_ann",
            "abricate", "--db", db_name, "--minid", "75", "--mincov", "60",
            str(filtered_fasta)
        ]
        print(f"+ {' '.join(cmd)}", flush=True)
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if res.returncode == 0 and res.stdout:
            tsv_out.write_text(res.stdout, encoding="utf-8")
            reader = csv.DictReader(res.stdout.splitlines(), delimiter="\t")
            for row in reader:
                gene = row.get("GENE", "").strip()
                seq = row.get("SEQUENCE", "").strip()
                start = int(row.get("START", "0") or 0)
                end = int(row.get("END", "0") or 0)
                dedup_key = (seq, start, end, gene)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                hits.append({
                    "database": db_name.upper(),
                    "sequence": seq,
                    "start": start,
                    "end": end,
                    "strand": row.get("STRAND", "+").strip(),
                    "gene": gene,
                    "coveragePercent": float(row.get("%COVERAGE", "0") or 0),
                    "identityPercent": float(row.get("%IDENTITY", "0") or 0),
                    "accession": row.get("ACCESSION", "").strip(),
                    "product": row.get("PRODUCT", "").strip(),
                    "resistance": row.get("RESISTANCE", "").strip(),
                })
    return hits


def main():
    work_dir = Path.cwd() / "wgs_work"
    work_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = work_dir / "results_bundle"
    bundle_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Fetch job spec & presigned R2 URLs
        spec = api_request("GET", CALLBACK_URL)
        job = spec["job"]
        urls = spec["urls"]
        keys = spec["keys"]

        sample = re.sub(r"[^a-zA-Z0-9_-]", "_", job["sampleName"])[:24] or "Sample"
        genus = job.get("genus") or "Streptomyces"
        species = job.get("species") or "sp."
        strain = job.get("strain") or sample
        opts = job.get("pipelineOptions") or {}

        run_fastp = bool(opts.get("runFastp", True))
        spades_mode = opts.get("spadesMode", "isolate")
        min_contig_len = int(opts.get("minContigLen", 500) or 500)
        run_prokka = bool(opts.get("runProkka", True))
        run_abricate = bool(opts.get("runAbricate", True))

        metrics: dict = {}

        update_portal(
            status="running",
            stage_title="Downloading paired-end FASTQ reads from Cloudflare R2",
            progress=16,
            log_stage="download",
            log_msg=f"Cloud runner initialized (4 vCPU, 16 GB RAM). Downloading {job['r1Filename']} and {job['r2Filename']}...",
        )

        raw_r1 = work_dir / "raw_R1.fastq.gz"
        raw_r2 = work_dir / "raw_R2.fastq.gz"
        download_file(urls["r1GetUrl"], raw_r1)
        download_file(urls["r2GetUrl"], raw_r2)

        asm_r1 = raw_r1
        asm_r2 = raw_r2

        # 2. Fastp Read QC & Trimming
        if run_fastp:
            update_portal(
                status="running",
                stage_title="Read QC & adapter trimming (fastp)",
                progress=26,
                log_stage="fastp",
                log_msg="Running fastp paired-end quality filtering and adapter trimming...",
            )
            clean_r1 = work_dir / "clean_R1.fastq.gz"
            clean_r2 = work_dir / "clean_R2.fastq.gz"
            fastp_json = bundle_dir / f"{sample}_fastp.json"
            fastp_html = bundle_dir / f"{sample}_fastp.html"

            run_cmd([
                "micromamba", "run", "-n", "wgs_asm",
                "fastp",
                "-i", str(raw_r1),
                "-I", str(raw_r2),
                "-o", str(clean_r1),
                "-O", str(clean_r2),
                "--detect_adapter_for_pe",
                "--thread", "4",
                "--json", str(fastp_json),
                "--html", str(fastp_html),
            ])

            raw_r1.unlink(missing_ok=True)
            raw_r2.unlink(missing_ok=True)
            asm_r1 = clean_r1
            asm_r2 = clean_r2

            if fastp_json.exists():
                fp = json.loads(fastp_json.read_text(encoding="utf-8"))
                before = fp.get("summary", {}).get("before_filtering", {})
                after = fp.get("summary", {}).get("after_filtering", {})
                metrics["readQc"] = {
                    "rawTotalReads": before.get("total_reads", 0),
                    "rawTotalBases": before.get("total_bases", 0),
                    "cleanTotalReads": after.get("total_reads", 0),
                    "cleanTotalBases": after.get("total_bases", 0),
                    "q20RateAfter": round(after.get("q20_rate", 0) * 100.0, 2),
                    "q30RateAfter": round(after.get("q30_rate", 0) * 100.0, 2),
                    "gcContentReads": round(after.get("gc_content", 0) * 100.0, 2),
                    "duplicationRate": round(fp.get("duplication", {}).get("rate", 0) * 100.0, 2),
                    "adapterTrimmedReads": fp.get("adapter_cutting", {}).get("adapter_trimmed_reads", 0),
                }
                update_portal(
                    status="running",
                    stage_title="Starting SPAdes de novo genome assembly",
                    progress=35,
                    log_stage="fastp",
                    log_msg=f"fastp complete: {after.get('total_reads', 0):,} clean reads ({metrics['readQc']['q30RateAfter']}% Q30).",
                    log_level="success",
                    metrics=metrics,
                )

        # 3. SPAdes Assembly
        spades_flag = "--careful" if spades_mode == "careful" else "--isolate"
        update_portal(
            status="running",
            stage_title=f"De novo assembly (SPAdes {spades_flag}, 14 GB RAM)",
            progress=42,
            log_stage="spades",
            log_msg=f"Running SPAdes ({spades_flag}, 4 threads, 14 GB RAM limit)...",
        )

        spades_dir = work_dir / "spades_out"
        run_cmd([
            "micromamba", "run", "-n", "wgs_asm",
            "spades.py",
            spades_flag,
            "-1", str(asm_r1),
            "-2", str(asm_r2),
            "-t", "4",
            "-m", "14",
            "-o", str(spades_dir),
        ])

        # Free runner disk immediately & purge raw FASTQs from Cloudflare R2
        asm_r1.unlink(missing_ok=True)
        asm_r2.unlink(missing_ok=True)
        for sub in spades_dir.iterdir():
            if sub.is_dir() and (sub.name.startswith("K") or sub.name in {"tmp", "corrected", "split_input"}):
                shutil.rmtree(sub, ignore_errors=True)

        del_r1 = delete_r2_url(urls["r1DeleteUrl"])
        del_r2 = delete_r2_url(urls["r2DeleteUrl"])
        raw_cleaned = del_r1 and del_r2

        contigs_raw = spades_dir / "contigs.fasta"
        if not contigs_raw.exists():
            raise RuntimeError("SPAdes finished without producing contigs.fasta")

        asm_bundle_dir = bundle_dir / "01_assembly"
        asm_bundle_dir.mkdir(parents=True, exist_ok=True)
        for fname in ["contigs.fasta", "scaffolds.fasta", "assembly_graph_with_scaffolds.gfa", "spades.log", "params.txt"]:
            src_f = spades_dir / fname
            if src_f.exists():
                shutil.copy2(src_f, asm_bundle_dir / fname)

        filtered_contigs = asm_bundle_dir / f"{sample}_contigs_ge{min_contig_len}bp.fasta"
        metrics["assembly"] = compute_assembly_metrics(contigs_raw, filtered_contigs, min_contig_len)

        update_portal(
            status="running",
            stage_title="Evaluating assembly quality (QUAST)",
            progress=68,
            log_stage="spades",
            log_msg=(
                f"SPAdes complete: {metrics['assembly']['contigsGe500']} contigs >=500 bp, "
                f"total {metrics['assembly']['totalLengthGe500']:,} bp, "
                f"N50 {metrics['assembly']['n50']:,} bp, GC {metrics['assembly']['gcPercent']}%. "
                f"{'Raw FASTQ uploads auto-deleted from R2.' if raw_cleaned else ''}"
            ),
            log_level="success",
            metrics=metrics,
            raw_deleted=raw_cleaned,
        )

        # 4. QUAST Assembly Assessment
        quast_dir = bundle_dir / "02_quast"
        run_cmd([
            "micromamba", "run", "-n", "wgs_asm",
            "quast.py",
            str(contigs_raw),
            "-o", str(quast_dir),
            "--threads", "4",
            "--min-contig", "500",
            "--no-icarus",
        ])

        # 5. Prokka Genome Annotation
        genes_list: list[dict] = []
        prokka_dir = bundle_dir / "03_prokka_annotation"
        if run_prokka:
            update_portal(
                status="running",
                stage_title=f"Annotating genome (Prokka — {genus} {species})",
                progress=78,
                log_stage="prokka",
                log_msg=f"Running Prokka annotation on contigs >= {min_contig_len} bp...",
            )
            run_cmd([
                "micromamba", "run", "-n", "wgs_ann",
                "prokka",
                "--outdir", str(prokka_dir),
                "--prefix", sample,
                "--locustag", sample[:12].upper(),
                "--genus", genus,
                "--species", species,
                "--strain", strain,
                "--kingdom", "Bacteria",
                "--centre", "MBDNIB",
                "--compliant",
                "--cpus", "4",
                "--force",
                str(filtered_contigs),
            ])
            ann_summary, genes_list = parse_prokka_outputs(
                prokka_dir, sample, metrics["assembly"]["totalLengthGe500"]
            )
            metrics["annotation"] = ann_summary
            update_portal(
                status="running",
                stage_title="Screening AMR & virulence genes (ABRicate)",
                progress=90,
                log_stage="prokka",
                log_msg=(
                    f"Prokka annotated {ann_summary['cdsCount']:,} CDS, "
                    f"{ann_summary['rRnaCount']} rRNA, and {ann_summary['tRnaCount']} tRNA features."
                ),
                log_level="success",
                metrics=metrics,
            )

        # 6. ABRicate AMR & Virulence Screening
        if run_abricate:
            amr_dir = bundle_dir / "04_amr_virulence"
            amr_hits = run_abricate_scans(filtered_contigs, amr_dir)
            metrics["amrHits"] = amr_hits

        # 7. Package & Upload Results to Cloudflare R2
        update_portal(
            status="running",
            stage_title="Packaging & uploading results archive",
            progress=96,
            log_stage="upload_results",
            log_msg="Compressing assembly, QUAST report, GenBank/GFF annotations, and AMR tables...",
        )

        zip_path = work_dir / f"{sample}_WGS_Results.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for file_p in bundle_dir.rglob("*"):
                if file_p.is_file():
                    zf.write(file_p, arcname=str(file_p.relative_to(bundle_dir)))

        output_keys: dict = {}
        upload_file(urls["resultsZipPutUrl"], zip_path, "application/zip")
        output_keys["resultsZipKey"] = keys["resultsZipKey"]

        upload_file(urls["contigsPutUrl"], filtered_contigs, "text/plain")
        output_keys["contigsKey"] = keys["contigsKey"]

        gbk_file = prokka_dir / f"{sample}.gbk"
        if not gbk_file.exists():
            gbk_file = prokka_dir / f"{sample}.gbf"
        if gbk_file.exists():
            upload_file(urls["gbkPutUrl"], gbk_file, "text/plain")
            output_keys["gbkKey"] = keys["gbkKey"]

        quast_html = quast_dir / "report.html"
        if quast_html.exists():
            upload_file(urls["quastHtmlPutUrl"], quast_html, "text/html")
            output_keys["quastHtmlKey"] = keys["quastHtmlKey"]

        metrics["runtimeSeconds"] = int(time.time() - START_TIME)

        update_portal(
            status="completed",
            stage_title="Pipeline completed",
            progress=100,
            log_stage="complete",
            log_msg=f"All WGS analyses finished in {metrics['runtimeSeconds'] // 60}m {metrics['runtimeSeconds'] % 60}s! Results ready for download.",
            log_level="success",
            metrics=metrics,
            genes=genes_list,
            raw_deleted=raw_cleaned,
            output_keys=output_keys,
        )
        print("Pipeline completed successfully!")

    except Exception as exc:
        err_str = str(exc)
        print(f"FATAL PIPELINE ERROR: {err_str}", file=sys.stderr)
        update_portal(
            status="failed",
            stage_title="Pipeline failed",
            log_stage="error",
            log_msg=f"Pipeline failed: {err_str[:400]}",
            log_level="error",
            error_msg=err_str[:500],
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
