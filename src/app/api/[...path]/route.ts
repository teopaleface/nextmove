import { handleApi } from "@/server/api/router";

// Every /api/* request goes through one server-side router (session, CSRF, ownership, feature gates).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return handleApi(req, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
