import { NextResponse, type NextRequest } from "next/server";

// A path with broken percent-encoding ("/agent/tasks/%E0%A4%A") otherwise gets Next's bare "400: Bad Request" page,
// even under /api where clients expect JSON. API paths get the API's error shape; pages get the app's own
// not-found page.
export function proxy(req: NextRequest) {
  const raw = req.nextUrl.pathname;
  try {
    decodeURIComponent(raw);
    return NextResponse.next();
  } catch {
    if (raw.startsWith("/api/")) return NextResponse.json({ error: "BAD_URL", message: "This address is not valid." }, { status: 400 });
    return NextResponse.rewrite(new URL("/not-a-page", req.url));
  }
}

export const config = { matcher: ["/((?!_next/).*)"] };
