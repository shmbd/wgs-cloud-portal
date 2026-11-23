export interface Env {
  PORTAL_PASSCODE?: string;
  WEBHOOK_SECRET?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  GITHUB_BRANCH?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

export interface PagesContext<Params extends Record<string, string> = Record<string, string>> {
  request: Request;
  env: Env;
  params: Params;
  waitUntil: (promise: Promise<unknown>) => void;
}
