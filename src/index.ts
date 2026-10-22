// Terrarium Bistro booking server (Cloudflare Worker + D1).
//   /            -> the restaurant website
//   /staff       -> staff tablet dashboard (passcode protected)
//   /api/public  -> live availability + instant booking, used by the website
//   /api/staff   -> dashboard data and actions
import { handlePublic, handleStaff } from "./booking/api.server.ts";
import type { DB, Stmt } from "./booking/core.server.ts";
import staffPage from "./booking/staff.html";
import schema from "./schema.sql";

interface D1 extends DB {
  batch(statements: Stmt[]): Promise<unknown>;
}
interface Env {
  DB: D1;
  PUBLIC_SITE?: string;
}

// Tables are created on first use, so a fresh database needs no manual setup.
let schemaReady = false;
async function ensureSchema(db: D1) {
  if (schemaReady) return;
  const statements = schema
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
  schemaReady = true;
}

const STAFF_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    if (path === "/staff" || path === "/staff/") return new Response(staffPage, { headers: STAFF_HEADERS });
    if (path.startsWith("/api/public") || path.startsWith("/api/staff")) {
      if (!env.DB) return Response.json({ ok: false, code: "offline", message: "The bookings database is not connected." }, { status: 503 });
      try {
        await ensureSchema(env.DB);
      } catch (e) {
        console.error("schema", e);
        return Response.json({ ok: false, code: "offline", message: "Bookings are unavailable for a moment. Please call us." }, { status: 503, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      return path.startsWith("/api/public") ? handlePublic(request, env.DB) : handleStaff(request, env.DB);
    }
    if (path === "/" && env.PUBLIC_SITE) return Response.redirect(env.PUBLIC_SITE, 302);
    return new Response("Not found", { status: 404 });
  },
};
