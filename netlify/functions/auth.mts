import type { Config, Context } from "@netlify/functions";
import {
  createPortalSessionToken,
  getSystemReadiness,
  verifyPasscodeInput,
  verifyPortalAuth,
} from "../../src/server/auth.ts";

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname.endsWith("/status")) {
    const authenticated = await verifyPortalAuth(req);
    return Response.json({
      authenticated,
      readiness: getSystemReadiness(),
    });
  }

  if (req.method === "POST" && url.pathname.endsWith("/login")) {
    try {
      const body = (await req.json()) as { passcode?: string };
      const passcode = body.passcode ?? "";
      const readiness = getSystemReadiness();

      if (!readiness.passcodeConfigured) {
        return Response.json(
          {
            error:
              "PORTAL_PASSCODE is not set yet in Netlify Environment Variables.",
          },
          { status: 503 }
        );
      }

      if (!verifyPasscodeInput(passcode)) {
        return Response.json(
          { error: "Invalid lab passcode." },
          { status: 401 }
        );
      }

      const token = await createPortalSessionToken();
      return Response.json({ token, readiness });
    } catch {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: ["/api/auth/status", "/api/auth/login"],
};
