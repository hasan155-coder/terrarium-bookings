// The Stripe and Resend keys can be pasted in on the staff tablet instead of the Cloudflare dashboard.
// A key set in Cloudflare (STRIPE_SECRET_KEY / RESEND_API_KEY) always wins over one saved here.
// Saved keys never leave the server: the tablet only ever sees whether one is set and its last four characters.
import type { DB, Row } from "./booking/core.server.ts";
import { stamp } from "./booking/core.server.ts";
import * as auth from "./booking/auth.server.ts";
import { sendEmail, type MailEnv } from "./email.ts";
import type { StripeEnv } from "./stripe.ts";

type KeyEnv = MailEnv & StripeEnv & { KEY_SOURCE?: { stripe: Source; email: Source } };
type Source = "cloudflare" | "tablet" | "";

const STRIPE_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/;
const RESEND_RE = /^re_[A-Za-z0-9_]{16,}$/;

let cache: { at: number; stripe: string; resend: string } | null = null;
export const forgetKeys = () => { cache = null; };

async function stored(db: DB) {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('stripe_key', 'resend_key')").all<{ key: string; value: string }>()).results;
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? "";
  cache = { at: Date.now(), stripe: get("stripe_key"), resend: get("resend_key") };
  return cache;
}

/** The environment with any keys saved on the tablet filled in where Cloudflare has none. */
export async function withKeys<E extends KeyEnv>(env: E, db: DB | undefined): Promise<E> {
  const src = { stripe: (env.STRIPE_SECRET_KEY ? "cloudflare" : "") as Source, email: (env.RESEND_API_KEY ? "cloudflare" : "") as Source };
  if (!db) return { ...env, KEY_SOURCE: src };
  try {
    const k = await stored(db);
    const out = { ...env, KEY_SOURCE: src };
    if (!env.STRIPE_SECRET_KEY && k.stripe) { out.STRIPE_SECRET_KEY = k.stripe; src.stripe = "tablet"; }
    if (!env.RESEND_API_KEY && k.resend) { out.RESEND_API_KEY = k.resend; src.email = "tablet"; }
    return out;
  } catch {
    return { ...env, KEY_SOURCE: src };
  }
}

const tail = (k?: string) => (k ? k.slice(-4) : "");
const modeOf = (k?: string) => (!k ? "off" : /^(sk|rk)_test_/.test(k) ? "test" : "live");

export function keyStatus(env: KeyEnv) {
  const s = env.KEY_SOURCE ?? { stripe: env.STRIPE_SECRET_KEY ? "cloudflare" : "", email: env.RESEND_API_KEY ? "cloudflare" : "" };
  return {
    stripe: { set: !!env.STRIPE_SECRET_KEY, mode: modeOf(env.STRIPE_SECRET_KEY), ends: tail(env.STRIPE_SECRET_KEY), source: s.stripe },
    email: { set: !!env.RESEND_API_KEY, ends: tail(env.RESEND_API_KEY), source: s.email },
  };
}

/** Asks Stripe whether the key works (Checkout Sessions read is all the booking system needs). */
async function stripeWorks(env: StripeEnv, key: string): Promise<string> {
  const base = (env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/checkout/sessions?limit=1`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) return "";
    if (res.status === 401) return "Stripe did not accept that key. Copy it again from Stripe and paste the whole key.";
    if (res.status === 403) return "That key works but cannot open payment pages. In Stripe, give it Checkout Sessions: Write.";
    return "Stripe could not check the key just now. Try again in a minute.";
  } catch {
    return "Stripe could not be reached just now. Try again in a minute.";
  }
}

/** Saves, replaces or removes the keys. Needs the staff passcode again, and tells the restaurant by email. */
export async function saveKeys(env: KeyEnv, db: DB, input: Row, ip: string): Promise<{ status: number; body: Row }> {
  if (await auth.blocked(db, ip || "unknown")) return { status: 429, body: { ok: false, code: "blocked", message: "Too many tries. Wait 15 minutes and try again." } };
  if (!(await auth.checkPasscode(db, input.passcode))) {
    await auth.failed(db, ip || "unknown");
    return { status: 401, body: { ok: false, code: "bad_pass", message: "That passcode is not right." } };
  }
  const stripe = typeof input.stripe === "string" ? input.stripe.trim() : undefined;
  const resend = typeof input.resend === "string" ? input.resend.trim() : undefined;
  if (stripe === undefined && resend === undefined) return { status: 400, body: { ok: false, code: "nothing", message: "Paste a key first." } };
  if (stripe && !STRIPE_RE.test(stripe))
    return { status: 400, body: { ok: false, code: "bad_stripe", message: "That doesn't look like a Stripe secret key. It starts with rk_live_ or sk_live_ (or _test_), with no spaces." } };
  if (stripe && /^pk_/.test(stripe)) return { status: 400, body: { ok: false, code: "bad_stripe", message: "That is the publishable key. Use the secret or restricted key." } };
  if (resend && !RESEND_RE.test(resend))
    return { status: 400, body: { ok: false, code: "bad_resend", message: "That doesn't look like a Resend key. It starts with re_ and has no spaces." } };
  if (stripe) {
    const problem = await stripeWorks(env, stripe);
    if (problem) return { status: 400, body: { ok: false, code: "stripe_rejected", message: problem } };
  }
  const put = (k: string, v: string) =>
    v
      ? db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run()
      : db.prepare("DELETE FROM settings WHERE key = ?1").bind(k).run();
  const changed: string[] = [];
  if (stripe !== undefined) { await put("stripe_key", stripe); changed.push(stripe ? `card payment key (${modeOf(stripe)}, ending ${tail(stripe)})` : "card payment key removed"); }
  if (resend !== undefined) { await put("resend_key", resend); changed.push(resend ? `email key (ending ${tail(resend)})` : "email key removed"); }
  await auth.cleared(db, ip || "unknown");
  forgetKeys();
  const fresh = await withKeys({ ...env, STRIPE_SECRET_KEY: env.KEY_SOURCE?.stripe === "cloudflare" ? env.STRIPE_SECRET_KEY : undefined, RESEND_API_KEY: env.KEY_SOURCE?.email === "cloudflare" ? env.RESEND_API_KEY : undefined }, db);
  if (fresh.RESEND_API_KEY && env.RESTAURANT_EMAIL) {
    const when = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "long", timeStyle: "short" });
    const text = `On ${when}, someone with the staff passcode changed the booking system's ${changed.join(" and ")} on the tablet.\n\nIf this was not you, change the staff passcode on the tablet and check the keys under Settings.`;
    await sendEmail(fresh, { to: [env.RESTAURANT_EMAIL], subject: "Booking system keys changed on the tablet", text, html: `<p style="font:15px/1.6 Helvetica,Arial,sans-serif">${text.replace(/\n/g, "<br>")}</p>` }).catch(() => false);
  }
  return { status: 200, body: { ok: true, keys: keyStatus(fresh), saved_at: stamp() } };
}
