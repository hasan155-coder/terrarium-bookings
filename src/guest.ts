// Guest-facing extras on the booking server:
//  - signed one-tap cancel links (no login; the link itself proves the guest received our email)
//  - the small cancel page those links open
//  - day-before reminder emails, sent by the hourly scheduled run
import {
  type Booking, type DB,
  PUBLIC_COLS, addDays, getSettings, londonNow, stamp,
} from "./booking/core.server.ts";
import { londonToUtc, longDate, reminderEmail, restaurantCancelledEmail, sendEmail, type Booked, type MailEnv } from "./email.ts";

export type GuestEnv = MailEnv & { BOOKINGS_URL?: string };

const PHONE = "01829 863469";
const PHONE_INTL = "+441829863469";
const REMIND_FROM = 10 * 60; // reminders go out from 10:00 the day before

/* ------------------------------------------------------------ cancel links */

async function linkSecret(db: DB): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'link_secret'").first<{ value: string }>();
  if (row?.value) return row.value;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('link_secret', ?1)").bind(fresh).run();
  return (await db.prepare("SELECT value FROM settings WHERE key = 'link_secret'").first<{ value: string }>())?.value ?? fresh;
}

async function sign(secret: string, ref: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`cancel:${ref}:${email.trim().toLowerCase()}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function baseUrl(env: GuestEnv): string {
  if (env.BOOKINGS_URL) return env.BOOKINGS_URL.replace(/\/+$/, "");
  try {
    return env.STAFF_URL ? new URL(env.STAFF_URL).origin : "";
  } catch {
    return "";
  }
}

/** The one-tap cancel link for a booking, or "" when there is no email to tie it to. */
export async function cancelUrl(env: GuestEnv, db: DB, ref: string, email: unknown): Promise<string> {
  const base = baseUrl(env), e = String(email ?? "").trim();
  if (!base || !ref || !e) return "";
  return `${base}/cancel?r=${encodeURIComponent(ref)}&t=${await sign(await linkSecret(db), ref, e)}`;
}

const asBooked = (b: Booking): Booked => ({
  ref: b.ref, date: b.date, time: b.time, guests: b.guests, first: b.first, last: b.last, email: b.email, phone: b.phone,
  occasion: b.occasion, notes: b.notes, newsletter: !!b.newsletter,
});

/* ------------------------------------------------------------- cancel page */

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(env: GuestEnv, o: { kicker: string; title: string; body: string; status?: number }) {
  const site = env.PUBLIC_SITE || "";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#181713"><title>${esc(o.title.replace(/<[^>]+>/g, ""))} · Terrarium Bistro</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=Manrope:wght@400;500;600&display=swap">
<style>
:root{--ink:#181713;--card:#1f1d19;--line:#4a3f2c;--rule:#35312a;--cream:#efe6d4;--cream-2:#c8bea9;--mute:#8e8573;--gold:#c9a66b;--gold-hi:#ecd49c;--rose:#e6a093;color-scheme:dark}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;background:radial-gradient(110% 70% at 50% -10%,#2a261f,var(--ink) 62%);color:var(--cream);font:400 16px/1.6 Manrope,"Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;padding:32px max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
main{width:min(520px,100%);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:clamp(26px,6vw,40px)}
.k{font:600 .7rem/1 Manrope,sans-serif;letter-spacing:.3em;text-transform:uppercase;color:var(--gold);margin-bottom:22px}
h1{font:400 clamp(2.1rem,7vw,2.6rem)/1.08 "Cormorant Garamond",Georgia,serif;margin-bottom:14px;text-wrap:balance}
h1 i{color:var(--gold)}
p{color:var(--cream-2)}
dl{display:grid;grid-template-columns:auto 1fr;margin:22px 0 6px}
dt,dd{padding:10px 0;border-top:1px solid var(--rule)}
dt{font:600 .68rem/1.4 Manrope,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--mute);padding-right:22px;padding-top:13px}
dd.ref{color:var(--gold-hi);letter-spacing:.12em;font-weight:600}
form{margin-top:24px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
button,.btn{appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:0 24px;border-radius:2px;font:600 .9rem/1 Manrope,sans-serif;letter-spacing:.04em;text-decoration:none}
button{background:#5a2e26;color:#fbe1db;border:1px solid #a0574a}
button:hover,button:focus-visible{background:#6d3a30}
.btn{border:1px solid var(--gold);color:var(--gold-hi)}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.small{margin-top:22px;padding-top:18px;border-top:1px solid var(--rule);font-size:.9rem}
a{color:var(--gold-hi)}
</style></head><body><main>
<p class="k">${esc(o.kicker)}</p>
<h1>${o.title}</h1>
${o.body}
<p class="small">Terrarium Bistro · 44 High St, Tarporley CW6 0DX · <a href="tel:${PHONE_INTL}">${PHONE}</a>${site ? ` · <a href="${esc(site)}">Website</a>` : ""}</p>
</main></body></html>`;
  return new Response(html, { status: o.status ?? 200, headers: PAGE_HEADERS });
}

const details = (b: Booking) =>
  `<dl><dt>Date</dt><dd>${esc(longDate(b.date))}</dd><dt>Time</dt><dd>${esc(b.time)}</dd><dt>Guests</dt><dd>${b.guests}</dd><dt>Name</dt><dd>${esc(`${b.first} ${b.last}`.trim())}</dd><dt>Reference</dt><dd class="ref">${esc(b.ref)}</dd></dl>`;

/** GET shows the booking and a Cancel button; POST (the button) cancels it. A GET never cancels, so email link scanners are harmless. */
export async function cancelRoute(request: Request, env: GuestEnv, db: DB): Promise<Response> {
  const url = new URL(request.url);
  let r = url.searchParams.get("r") ?? "", t = url.searchParams.get("t") ?? "";
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    r = String(form?.get("r") ?? r);
    t = String(form?.get("t") ?? t);
  } else if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const bad = () =>
    page(env, {
      kicker: "Cancel a booking", status: 404,
      title: "This link is not <i>working.</i>",
      body: `<p>We could not match this link to a booking. It may have been copied only in part. Please call us on <a href="tel:${PHONE_INTL}">${PHONE}</a> and we will sort it out.</p>`,
    });
  const ref = r.trim().toUpperCase().slice(0, 20);
  if (!ref || !/^[0-9a-f]{32}$/.test(t)) return bad();
  const b = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE ref = ?1`).bind(ref).first<Booking>();
  if (!b || !b.email || !sameText(t, await sign(await linkSecret(db), b.ref, b.email))) return bad();

  const today = londonNow().date;
  if (b.status === "cancelled")
    return page(env, { kicker: b.ref, title: "Already <i>cancelled.</i>", body: `<p>This booking was cancelled, so there is nothing more to do. We hope to see you another time.</p>${details(b)}` });
  if (!["booked", "late"].includes(b.status) || b.date < today)
    return page(env, {
      kicker: b.ref, title: "Please give us a <i>call.</i>",
      body: `<p>This booking can no longer be changed online. Call us on <a href="tel:${PHONE_INTL}">${PHONE}</a> and we will help.</p>${details(b)}`,
    });

  if (request.method === "GET") {
    return page(env, {
      kicker: "Cancel your table",
      title: `Cancel your table for <i>${b.guests}?</i>`,
      body: `<p>If you can no longer make it, cancel below and we will offer the table to another guest. If you would rather change the time, call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>${details(b)}
<form method="post" action="/cancel"><input type="hidden" name="r" value="${esc(b.ref)}"><input type="hidden" name="t" value="${esc(t)}">
<button type="submit">Cancel my table</button>${env.PUBLIC_SITE ? `<a class="btn" href="${esc(env.PUBLIC_SITE)}">Keep my table</a>` : ""}</form>`,
    });
  }

  const done = await db
    .prepare("UPDATE bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status IN ('booked','late')")
    .bind(b.id, stamp())
    .run();
  if ((done.meta.changes ?? 0) > 0 && env.RESTAURANT_EMAIL) {
    const m = restaurantCancelledEmail(asBooked(b), env.STAFF_URL);
    await sendEmail(env, { to: [env.RESTAURANT_EMAIL], subject: m.subject, html: m.html, text: m.text, reply_to: b.email }).catch(() => false);
  }
  return page(env, {
    kicker: b.ref,
    title: "Your table is <i>cancelled.</i>",
    body: `<p>Thank you for letting us know, ${esc(b.first)}. We hope to welcome you another time.</p>${details({ ...b, status: "cancelled" })}${env.PUBLIC_SITE ? `<p style="margin-top:22px"><a class="btn" href="${esc(env.PUBLIC_SITE)}#book">Book another time</a></p>` : ""}`,
  });
}

/* --------------------------------------------------------------- reminders */

/**
 * Emails a reminder to every guest booked for tomorrow, once, from 10:00 (UK time).
 * Run hourly; a booking made less than a day before its time gets no reminder, since its confirmation is fresh.
 */
export async function sendReminders(env: GuestEnv, db: DB, now = londonNow()) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!env.RESEND_API_KEY || now.mins < REMIND_FROM) return result;
  if (!(await getSettings(db)).reminders) return result;
  const tomorrow = addDays(now.date, 1);
  const due = await db
    .prepare(
      `SELECT ${PUBLIC_COLS} FROM bookings
       WHERE date = ?1 AND status IN ('booked','late') AND email <> '' AND ref NOT IN (SELECT ref FROM reminders)
       ORDER BY mins, id LIMIT 300`,
    )
    .bind(tomorrow)
    .all<Booking>();
  for (const b of due.results) {
    const start = londonToUtc(b.date, b.time).getTime();
    const fresh = start - new Date(b.created_at).getTime() < 24 * 3600_000;
    // Claim the booking first, so two runs at once can never send it twice.
    const claim = await db.prepare("INSERT OR IGNORE INTO reminders (ref, sent_at) VALUES (?1, ?2)").bind(b.ref, fresh ? "skipped" : stamp()).run();
    if ((claim.meta.changes ?? 0) < 1) continue;
    if (fresh) {
      result.skipped++;
      continue;
    }
    const m = reminderEmail(asBooked(b), await cancelUrl(env, db, b.ref, b.email), env.PUBLIC_SITE);
    const ok = await sendEmail(env, {
      to: [b.email], subject: m.subject, html: m.html, text: m.text,
      reply_to: env.RESTAURANT_EMAIL || undefined, headers: { "X-Entity-Ref-ID": `${b.ref}-reminder` },
    });
    if (ok) result.sent++;
    else {
      // Let the next hourly run try again.
      await db.prepare("DELETE FROM reminders WHERE ref = ?1").bind(b.ref).run();
      result.failed++;
    }
  }
  return result;
}
