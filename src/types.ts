export type JobStatus =
  | "uploading"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface PipelineOptions {
  runFastp: boolean;
  spadesMode: "isolate" | "careful";
  minContigLen: number;
  runProkka: boolean;
  runAbricate: boolean;
}

export interface StageLogEntry {
  timestamp: string;
  stage: string;
  message: string;
  level?: "info" | "success" | "warn" | "error";
}

export interface ReadQcMetrics {
  rawTotalReads?: number;
  rawTotalBases?: number;
  cleanTotalReads?: number;
  cleanTotalBases?: number;
  q20RateAfter?: number;
  q30RateAfter?: number;
  gcContentReads?: number;
  duplicationRate?: number;
  adapterTrimmedReads?: number;
}

export interface ContigBin {
  label: string;
  count: number;
  totalBp: number;
}

export interface TopContigInfo {
  name: string;
  length: number;
  coverage: number;
  gc: number;
}

export interface AssemblyMetrics {
  totalContigsAll?: number;
  totalLengthAll?: number;
  contigsGe500?: number;
  totalLengthGe500?: number;
  contigsGe1000?: number;
  totalLengthGe1000?: number;
  largestContig?: number;
  n50?: number;
  n90?: number;
  l50?: number;
  gcPercent?: number;
  contigBins?: ContigBin[];
  topContigs?: TopContigInfo[];
}

export interface AnnotatedGene {
  locus_tag: string;
  ftype: string;
  length_bp: number;
  gene: string;
  ec_number: string;
  cog: string;
  product: string;
}

export interface AnnotationMetrics {
  cdsCount?: number;
  rRnaCount?: number;
  tRnaCount?: number;
  tmRnaCount?: number;
  hypotheticalProteins?: number;
  functionalProteins?: number;
  codingDensityPercent?: number;
  functionalCategories?: { category: string; count: number }[];
}

export interface AmrHit {
  database: string;
  sequence: string;
  start: number;
  end: number;
  strand: string;
  gene: string;
  coveragePercent: number;
  identityPercent: number;
  accession: string;
  product: string;
  resistance: string;
}

export interface JobMetrics {
  readQc?: ReadQcMetrics;
  assembly?: AssemblyMetrics;
  annotation?: AnnotationMetrics;
  amrHits?: AmrHit[];
  runtimeSeconds?: number;
}

export interface DownloadLinks {
  resultsZipUrl?: string;
  contigsFastaUrl?: string;
  genbankUrl?: string;
  quastHtmlUrl?: string;
}

export interface WgsJob {
  id: string;
  sampleName: string;
  genus: string;
  species: string;
  strain: string;
  status: JobStatus;
  currentStage: string;
  progress: number;
  r1Filename: string;
  r2Filename: string;
  r1SizeBytes: number;
  r2SizeBytes: number;
  rawReadsDeleted: boolean;
  pipelineOptions: PipelineOptions;
  metrics: JobMetrics;
  stageLogs: StageLogEntry[];
  errorMessage?: string | null;
  ghRunUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  genes?: AnnotatedGene[];
  downloadLinks?: DownloadLinks;
  isDemo?: boolean;
}
