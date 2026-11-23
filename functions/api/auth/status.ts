import { getSystemReadiness, verifyPortalAuth } from "../../../src/server/auth.ts";
import type { PagesContext } from "../../../src/server/env.ts";

export async function onRequest(context: PagesContext): Promise<Response> {
  if (context.request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const authenticated = await verifyPortalAuth(context.request, context.env);
  return Response.json({
    authenticated,
    readiness: getSystemReadiness(context.env),
  });
}
