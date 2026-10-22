// Staff passcode, sessions and login throttling.
// The passcode itself is never stored: only a salted PBKDF2 hash.
import type { DB } from "./core.server.ts";
import { clock } from "./core.server.ts";

const ITERATIONS = 100_000; // the maximum Cloudflare Workers allows for PBKDF2
const COOKIE = "tb_staff";
const SESSION_DAYS = 120;
const MAX_FAILS = 8;
const FAIL_WINDOW = 15 * 60_000;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => {
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const random = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function derive(pass: string, saltHex: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations }, key, 256);
  return hex(bits);
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const passcodeProblem = (p: unknown) =>
  typeof p !== "string" || p.length < 6 ? "Use at least 6 characters." : p.length > 64 ? "Use 64 characters or fewer." : "";

export async function hasPasscode(db: DB) {
  return !!(await db.prepare("SELECT 1 AS x FROM settings WHERE key = 'staff_pass'").first());
}

export async function setPasscode(db: DB, pass: string) {
  const salt = hex(random(16));
  const hash = await derive(pass, salt, ITERATIONS);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('staff_pass', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ salt, hash, iterations: ITERATIONS }))
    .run();
}

export async function checkPasscode(db: DB, pass: unknown) {
  if (typeof pass !== "string" || !pass) return false;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'staff_pass'").first<{ value: string }>();
  if (!row) return false;
  const { salt, hash, iterations } = JSON.parse(row.value) as { salt: string; hash: string; iterations: number };
  return same(await derive(pass, salt, iterations), hash);
}

/** First-time setup: the one-time code proves it is the owner creating the passcode. */
export async function setupWithCode(db: DB, code: unknown, pass: string): Promise<"ok" | "exists" | "bad_code"> {
  if (await hasPasscode(db)) return "exists";
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'setup_code_sha256'").first<{ value: string }>();
  const norm = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!row || !norm || !same(await sha256(norm), row.value)) return "bad_code";
  await setPasscode(db, pass);
  await db.prepare("DELETE FROM settings WHERE key = 'setup_code_sha256'").run();
  return "ok";
}

/* -------------------------------------------------------------- sessions */

export async function createSession(db: DB, device: string) {
  const token = hex(random(32));
  const now = clock.now().getTime();
  await db
    .prepare("INSERT INTO sessions (id, created_at, expires_at, device) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), now, now + SESSION_DAYS * 86_400_000, device.slice(0, 160))
    .run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now).run();
  return token;
}

export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function tokenOf(request: Request) {
  const m = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : "";
}

/** Returns the session id for a signed-in staff device, or "". */
export async function sessionOf(db: DB, request: Request) {
  const token = tokenOf(request);
  if (!token) return "";
  const id = await sha256(token);
  const row = await db.prepare("SELECT id FROM sessions WHERE id = ?1 AND expires_at > ?2").bind(id, clock.now().getTime()).first<{ id: string }>();
  return row ? row.id : "";
}

export async function endSession(db: DB, request: Request) {
  const token = tokenOf(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(await sha256(token)).run();
}

export async function endOtherSessions(db: DB, keepId: string) {
  await db.prepare("DELETE FROM sessions WHERE id <> ?1").bind(keepId).run();
}

/* ------------------------------------------------------------- throttling */

export async function blocked(db: DB, ip: string) {
  const now = clock.now().getTime();
  await db.prepare("DELETE FROM attempts WHERE at < ?1").bind(now - FAIL_WINDOW).run();
  const r = await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ?1").bind(ip).first<{ n: number }>();
  return (r?.n ?? 0) >= MAX_FAILS;
}
export async function failed(db: DB, ip: string) {
  await db.prepare("INSERT INTO attempts (ip, at) VALUES (?1, ?2)").bind(ip, clock.now().getTime()).run();
}
export async function cleared(db: DB, ip: string) {
  await db.prepare("DELETE FROM attempts WHERE ip = ?1").bind(ip).run();
}
