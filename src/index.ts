// Terrarium Bistro booking server (Cloudflare Worker + D1).
//   /            -> the restaurant website
//   /staff       -> staff tablet dashboard (passcode protected)
//   /api/public  -> live availability + instant booking, used by the website
//   /api/staff   -> dashboard data and actions
//   /cancel      -> a guest's one-tap cancel link from their emails
//   /deposit     -> where a big group pays its deposit (link from the website, or texted/emailed by staff)
// Every hour a scheduled run sends the day-before reminder emails, settles card payments
// nobody came back to confirm, releases unpaid holds and sends vouchers due that day.
import { handlePublic, handleStaff } from "./booking/api.server.ts";
import type { DB, Stmt } from "./booking/core.server.ts";
import staffPage from "./booking/staff.html";
import schema from "./schema.sql";
import { sendBookingEmails } from "./email.ts";
import { cancelRoute, cancelUrl, sendReminders } from "./guest.ts";
import * as pay from "./payments.ts";
import { stripeMode, stripeOn } from "./stripe.ts";
import { withKeys } from "./keys.ts";

interface D1 extends DB {
  batch(statements: Stmt[]): Promise<unknown>;
}
interface Env extends pay.PayEnv {
  DB: D1;
  PUBLIC_SITE?: string;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
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

const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const cors = (r: { status: number; body: unknown }) => Response.json(r.body, { status: r.status, headers: CORS });

// A confirmed online booking also emails the guest (and the restaurant) when email is set up.
// Big groups pay a deposit first: the table is held, and the emails go once the deposit is paid.
async function book(request: Request, env: Env): Promise<Response> {
  const raw = await request.clone().text();
  const res = await handlePublic(request, env.DB);
  if (res.status !== 200) return res;
  const body = (await res.clone().json()) as { ok?: boolean; duplicate?: boolean; deposit?: number; booking?: { id: number; ref: string; guests: number } };
  if (!body.ok || !body.booking) return res;
  const held = await env.DB.prepare("SELECT amount, status FROM deposits WHERE booking_id = ?1").bind(body.booking.id).first<{ amount: number; status: string }>();
  if (body.deposit || held?.status === "due") {
    if (!stripeOn(env) && !held) {
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled', staff_note = 'Not kept: card payments were off, so the deposit could not be taken.' WHERE id = ?1").bind(body.booking.id).run();
      return cors({ status: 409, body: { ok: false, code: "deposit_off", message: `For ${body.booking.guests} guests we take a deposit, and card payments are not available online just now. Please call us on 01829 863469.` } });
    }
    const deposit = held
      ? { url: await pay.depositLink(env, env.DB, body.booking.ref), pence: held.amount, holdMins: 30 }
      : await pay.holdForDeposit(env, env.DB, body.booking, body.deposit!);
    return cors({ status: 200, body: { ...body, deposit, emailed: false } });
  }
  if (body.duplicate || !env.RESEND_API_KEY) return res;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  const link = await cancelUrl(env, env.DB, body.booking.ref, input.email).catch(() => "");
  const emailed = await sendBookingEmails(env, input, body.booking.ref, link).catch(() => false);
  return new Response(JSON.stringify({ ...body, emailed }), { status: 200, headers: res.headers });
}

export default {
  async fetch(request: Request, raw: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Keys pasted in on the tablet fill in for Cloudflare secrets that are not set.
    const env = path === "/robots.txt" || path === "/staff" || path === "/staff/" ? raw : await withKeys(raw, raw.DB);
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
      if (path.startsWith("/api/public")) {
        if (request.method === "OPTIONS") return handlePublic(request, env.DB);
        try {
          if (path === "/api/public/voucher-checkout" && request.method === "POST") {
            const text = await request.text();
            if (text.length > 8000) return cors({ status: 413, body: { ok: false, code: "too_big" } });
            let input = {};
            try { input = JSON.parse(text || "{}"); } catch {}
            return cors(await pay.voucherCheckout(env, env.DB, input));
          }
          if (path === "/api/public/voucher" && request.method === "GET") return cors(await pay.voucherLookup(env, env.DB, new URL(request.url).searchParams));
          // Seats held for a deposit that was never paid go back on sale before availability is worked out.
          if (/^\/api\/public\/(calendar|slots|book)$/.test(path)) await pay.releaseLapsedHolds(env, env.DB).catch((e) => console.error("holds", e));
          if (path === "/api/public/book" && request.method === "POST") return book(request, env);
          if (path === "/api/public/calendar" && request.method === "GET") {
            const res = await handlePublic(request, env.DB);
            if (res.status !== 200) return res;
            const body = (await res.json()) as Record<string, unknown>;
            // "test" while Stripe test keys are in: the website then only takes payments when opened with ?testpay=1.
            return Response.json({ ...body, payments: stripeOn(env), paymentsMode: stripeMode(env) }, { headers: CORS });
          }
        } catch (e) {
          console.error("public", e);
          return cors({ status: 500, body: { ok: false, code: "error", message: "Something went wrong. Please try again or call us on 01829 863469." } });
        }
        return handlePublic(request, env.DB);
      }
      return handleStaff(request, env.DB, env);
    }
    if (path === "/cancel") {
      if (!env.DB) return new Response("Bookings are offline. Please call us on 01829 863469.", { status: 503 });
      try {
        await ensureSchema(env.DB);
        return await cancelRoute(request, env, env.DB);
      } catch (e) {
        console.error("cancel", e);
        return new Response("Something went wrong. Please call us on 01829 863469.", { status: 500 });
      }
    }
    if (path === "/deposit" || path === "/deposit/" || path === "/deposit/done") {
      if (!env.DB) return new Response("Bookings are offline. Please call us on 01829 863469.", { status: 503 });
      try {
        await ensureSchema(env.DB);
        return await pay.depositRoute(request, env, env.DB);
      } catch (e) {
        console.error("deposit", e);
        return new Response("Something went wrong. Please call us on 01829 863469.", { status: 500 });
      }
    }
    if (path === "/" && env.PUBLIC_SITE) return Response.redirect(env.PUBLIC_SITE, 302);
    return new Response("Not found", { status: 404 });
  },

  // Hourly (see "triggers" in wrangler.jsonc): reminders, payment checks and scheduled vouchers.
  async scheduled(_event: unknown, raw: Env, ctx: Ctx): Promise<void> {
    if (!raw.DB) return;
    const env = await withKeys(raw, raw.DB);
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        const r = await sendReminders(env, env.DB);
        if (r.sent || r.failed) console.log("reminders", JSON.stringify(r));
        const p = await pay.paymentsHourly(env, env.DB);
        if (p.vouchersPaid || p.depositsPaid || p.released || p.vouchersSent) console.log("payments", JSON.stringify(p));
      })().catch((e) => console.error("hourly", e)),
    );
  },
};
