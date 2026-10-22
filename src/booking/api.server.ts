// HTTP layer for bookings.
//   /api/public/*  used by the restaurant website (any origin, no login)
//   /api/staff/*   used by the staff tablet dashboard (passcode + cookie)
import * as core from "./core.server.ts";
import * as auth from "./auth.server.ts";
import type { DB, Row } from "./core.server.ts";

const BASE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}
const out = (r: { status: number; body: unknown }, extra: Record<string, string> = {}) => json(r.body, r.status, extra);

async function readBody(request: Request): Promise<Row> {
  const text = await request.text();
  if (text.length > 16_000) throw new Error("Body too large");
  if (!text.trim()) return {};
  const v = JSON.parse(text);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
}

const ipOf = (r: Request) =>
  r.headers.get("CF-Connecting-IP") || (r.headers.get("X-Forwarded-For") ?? "").split(",")[0].trim() || "";
const actionOf = (request: Request, prefix: string) =>
  new URL(request.url).pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");

/* ---------------------------------------------------------------- public */

export async function handlePublic(request: Request, db: DB | undefined): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!db) return json({ ok: false, code: "offline", message: "Online booking is offline. Please call us." }, 503, CORS);
  const url = new URL(request.url);
  const action = actionOf(request, "/api/public");
  try {
    if (request.method === "GET" && action === "calendar") return out(await core.publicCalendar(db, url.searchParams.get("guests")), CORS);
    if (request.method === "GET" && action === "slots")
      return out(await core.publicSlots(db, url.searchParams.get("date"), url.searchParams.get("guests")), CORS);
    if (request.method === "POST" && action === "book") {
      const ip = ipOf(request);
      const ipHash = ip ? (await auth.sha256(`tb-ip:${ip}`)).slice(0, 32) : "";
      return out(await core.createOnline(db, await readBody(request), ipHash), CORS);
    }
    if (request.method === "POST" && action === "cancel") return out(await core.cancelOnline(db, await readBody(request)), CORS);
    return json({ ok: false, code: "not_found" }, 404, CORS);
  } catch (e) {
    console.error(e);
    return json({ ok: false, code: "error", message: "Something went wrong. Please try again or call us." }, 500, CORS);
  }
}

/* ----------------------------------------------------------------- staff */

export async function handleStaff(request: Request, db: DB | undefined): Promise<Response> {
  if (!db) return json({ ok: false, code: "offline", message: "The bookings database is not connected yet." }, 503);
  const url = new URL(request.url);
  const action = actionOf(request, "/api/staff");
  const get = request.method === "GET", post = request.method === "POST";
  // A custom header can only be sent by our own page (other sites would need CORS, which staff routes never allow).
  if (post && request.headers.get("X-TB") !== "1") return json({ ok: false, code: "forbidden" }, 403);
  try {
    if (get && action === "me") {
      const sid = await auth.sessionOf(db, request);
      return json({ ok: true, authed: !!sid, setup: !(await auth.hasPasscode(db)) });
    }
    if (post && (action === "setup" || action === "login")) {
      const ip = ipOf(request) || "unknown";
      if (await auth.blocked(db, ip)) return json({ ok: false, code: "blocked", message: "Too many tries. Wait 15 minutes and try again." }, 429);
      const body = await readBody(request);
      if (action === "setup") {
        const problem = auth.passcodeProblem(body.passcode);
        if (problem) return json({ ok: false, code: "weak", message: problem }, 400);
        const r = await auth.setupWithCode(db, body.code, String(body.passcode));
        if (r === "exists") return json({ ok: false, code: "exists", message: "A passcode is already set. Sign in instead." }, 409);
        if (r === "bad_code") {
          await auth.failed(db, ip);
          return json({ ok: false, code: "bad_code", message: "That setup code is not right." }, 401);
        }
      } else if (!(await auth.checkPasscode(db, body.passcode))) {
        await auth.failed(db, ip);
        return json({ ok: false, code: "bad_pass", message: "That passcode is not right." }, 401);
      }
      await auth.cleared(db, ip);
      const token = await auth.createSession(db, request.headers.get("User-Agent") ?? "");
      return json({ ok: true }, 200, { "Set-Cookie": auth.sessionCookie(token) });
    }
    if (post && action === "logout") {
      await auth.endSession(db, request);
      return json({ ok: true }, 200, { "Set-Cookie": auth.clearCookie() });
    }

    const sid = await auth.sessionOf(db, request);
    if (!sid) return json({ ok: false, code: "auth", message: "Please sign in." }, 401);

    if (get) {
      const q = url.searchParams;
      switch (action) {
        case "day": {
          const date = q.get("date") ?? core.londonNow().date;
          if (!core.isDate(date)) return json({ ok: false, code: "bad_date" }, 400);
          return json(await core.staffDay(db, date));
        }
        case "range": {
          const from = q.get("from") ?? core.londonNow().date;
          const days = Math.min(62, Math.max(1, Number(q.get("days") ?? 14) || 14));
          if (!core.isDate(from)) return json({ ok: false, code: "bad_date" }, 400);
          return json(await core.staffRange(db, from, days));
        }
        case "pulse":
          return json(await core.staffPulse(db, Number(q.get("since") ?? 0) || 0));
        case "recent":
          return json(await core.staffRecent(db));
        case "search":
          return json(await core.staffSearch(db, q.get("q") ?? ""));
        case "settings":
          return json({ ok: true, settings: await core.getSettings(db) });
      }
    }
    if (post) {
      const body = await readBody(request);
      switch (action) {
        case "booking":
          return out(await core.staffCreate(db, body));
        case "update":
          return out(await core.staffUpdate(db, body));
        case "day":
          return out(await core.staffSetDay(db, body));
        case "slot":
          return out(await core.staffSetSlot(db, body));
        case "settings":
          return json({ ok: true, settings: await core.saveSettings(db, body.settings ?? body) });
        case "passcode": {
          if (!(await auth.checkPasscode(db, body.current)))
            return json({ ok: false, code: "bad_pass", message: "Your current passcode is not right." }, 401);
          const problem = auth.passcodeProblem(body.next);
          if (problem) return json({ ok: false, code: "weak", message: problem }, 400);
          await auth.setPasscode(db, String(body.next));
          await auth.endOtherSessions(db, sid);
          return json({ ok: true });
        }
        case "logout-others":
          await auth.endOtherSessions(db, sid);
          return json({ ok: true });
      }
    }
    return json({ ok: false, code: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ ok: false, code: "error", message: "Something went wrong. Try again." }, 500);
  }
}
