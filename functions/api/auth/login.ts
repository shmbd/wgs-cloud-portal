import {
  createPortalSessionToken,
  getSystemReadiness,
  verifyPasscodeInput,
} from "../../../src/server/auth.ts";
import type { PagesContext } from "../../../src/server/env.ts";

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  try {
    const body = (await context.request.json()) as { passcode?: string };
    const passcode = body.passcode ?? "";
    const readiness = getSystemReadiness(context.env);

    if (!readiness.passcodeConfigured) {
      return Response.json(
        {
          error:
            "PORTAL_PASSCODE is not set yet in Cloudflare Pages Environment Variables.",
        },
        { status: 503 }
      );
    }

    if (!verifyPasscodeInput(passcode, context.env)) {
      return Response.json(
        { error: "Invalid lab passcode." },
        { status: 401 }
      );
    }

    const token = await createPortalSessionToken(context.env);
    return Response.json({ token, readiness });
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
}
