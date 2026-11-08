// Card payments on the booking server, through Stripe's hosted Checkout:
//  - gift vouchers bought on the website, plus the voucher register staff use on the tablet
//  - deposits for large groups (online bookings are held while the guest pays; phone bookings get a pay link)
// Payments are confirmed when the guest comes back from Stripe, and again by the hourly run,
// so a guest who closes the page straight after paying is still confirmed.
import {
  type Booking, type DB, type Row,
  PUBLIC_COLS, addDays, checkSlotFor, clock, depositPence, fail, getSettings, isDate, londonNow, stamp, str,
} from "./booking/core.server.ts";
import {
  depositPaidEmail, depositRequestEmail, depositRule, londonToUtc, longDate, money, restaurantDepositEmail,
  restaurantVoucherEmail, sendBookingEmails, sendEmail, voucherEmail, voucherReceiptEmail, type VoucherMail,
} from "./email.ts";
import { asBooked, baseUrl, cancelUrl, details, esc, linkSecret, page, sameText, type GuestEnv } from "./guest.ts";
import { createCheckout, getSession, isPaid, stripeMode, stripeOn, type Session, type StripeEnv } from "./stripe.ts";

export type PayEnv = GuestEnv & StripeEnv;
type Out = { status: number; body: Row };
const ok = (body: Row): Out => ({ status: 200, body: { ok: true, ...body } });

const PHONE = "01829 863469";
const PHONE_INTL = "+441829863469";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HOLD_MINS = 30; // how long an online booking is held while the guest pays the deposit
const VOUCHER = { min: 10, max: 500 };

const site = (env: PayEnv) => (env.PUBLIC_SITE || "").replace(/#.*$/, "");
const nowIso = () => stamp();
const minsFromNow = (m: number) => new Date(clock.now().getTime() + m * 60_000).toISOString();

async function mac(db: DB, msg: string, len = 24): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await linkSecret(db)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

/* =================================================================== vouchers */

export type Voucher = {
  id: number; serial: string; amount: number; balance: number; status: string; source: string; paid_by: string;
  to_name: string; from_name: string; message: string; buyer_email: string; recipient_email: string;
  deliver: string; send_on: string; sent_at: string | null; stripe_session: string | null; stripe_payment: string | null;
  paid_at: string | null; expires_on: string; note: string; created_at: string; updated_at: string;
};

// Same alphabet and check character as the website, so a mistyped number is spotted.
const ALPH = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function newSerial(): string {
  const body = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => ALPH[x & 31]).join("");
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPH.indexOf(body[i]) * (i % 2 ? 3 : 7) + i;
  return `TB-${body.slice(0, 4)}-${body.slice(4)}-${ALPH[sum % 32]}`;
}
const compact = (q: string) => q.toUpperCase().replace(/[^0-9A-Z]/g, "");

function plusYear(d: string) {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, dd)).toISOString().slice(0, 10);
}

export async function voucherLink(env: PayEnv, db: DB, serial: string) {
  return `${site(env)}?v=${encodeURIComponent(serial)}&k=${await mac(db, `voucher:${serial}`)}#vouchers`;
}

const mail = (v: Voucher): VoucherMail => ({
  serial: v.serial, amount: v.amount, to_name: v.to_name, from_name: v.from_name, message: v.message, expires_on: v.expires_on,
  send_on: v.send_on, recipient_email: v.recipient_email, buyer_email: v.buyer_email, deliver: v.deliver, source: v.source, paid_by: v.paid_by,
});

/** What the website may show about a voucher (to the buyer, or to whoever holds the signed link). */
function publicVoucher(v: Voucher) {
  const today = londonNow().date;
  return {
    serial: v.serial, amount: v.amount / 100, balance: v.balance / 100,
    status: v.status === "active" && v.expires_on && v.expires_on < today ? "expired" : v.status,
    to: v.to_name, from: v.from_name, message: v.message, expires_on: v.expires_on,
    deliver: v.deliver, recipient_email: v.recipient_email, buyer_email: v.buyer_email, send_on: v.send_on, sent: !!v.sent_at,
  };
}

const byId = (db: DB, id: number) => db.prepare("SELECT * FROM vouchers WHERE id = ?1").bind(id).first<Voucher>();

async function insertVoucher(db: DB, v: Partial<Voucher> & { amount: number; status: string }): Promise<Voucher> {
  const at = nowIso();
  for (let i = 0; i < 5; i++) {
    const serial = newSerial();
    try {
      const r = await db
        .prepare(
          `INSERT INTO vouchers (serial, amount, balance, status, source, paid_by, to_name, from_name, message, buyer_email, recipient_email, deliver, send_on, paid_at, expires_on, note, created_at, updated_at)
           VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
        )
        .bind(serial, v.amount, v.status, v.source ?? "online", v.paid_by ?? "", v.to_name ?? "", v.from_name ?? "", v.message ?? "", v.buyer_email ?? "",
          v.recipient_email ?? "", v.deliver ?? "buyer", v.send_on ?? "", v.paid_at ?? null, v.expires_on ?? "", v.note ?? "", at)
        .run();
      return (await byId(db, Number(r.meta.last_row_id)))!;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  throw new Error("serial");
}

function readVoucherInput(input: Row, forStaff: boolean) {
  const today = londonNow().date;
  const pounds = Number(input.amount);
  const to = str(input.to, 28), from = str(input.from, 28), message = str(input.message, 120);
  const deliver = input.deliver === "recipient" ? "recipient" : input.deliver === "none" && forStaff ? "none" : "buyer";
  const buyer = str(input.buyer_email, 120), recipient = str(input.recipient_email, 120);
  if (!Number.isInteger(pounds) || pounds < VOUCHER.min || pounds > VOUCHER.max)
    return { error: fail(400, "bad_amount", `Choose a whole amount between £${VOUCHER.min} and £${VOUCHER.max}.`) };
  if (!forStaff && (!to || !from)) return { error: fail(400, "bad_name", "Please say who the voucher is for and who it is from.") };
  if ((!forStaff || deliver === "buyer") && !EMAIL_RE.test(buyer)) return { error: fail(400, "bad_email", forStaff ? "Add the buyer's email, or choose Hand it over." : "Please check your email address.") };
  if (forStaff && buyer && !EMAIL_RE.test(buyer)) return { error: fail(400, "bad_email", "Check the buyer's email address.") };
  if (deliver === "recipient" && !EMAIL_RE.test(recipient)) return { error: fail(400, "bad_recipient", "Please check their email address.") };
  let send_on = today;
  if (deliver === "recipient" && isDate(input.send_on) && input.send_on > today && input.send_on <= addDays(today, 365)) send_on = input.send_on;
  return { v: { amount: pounds * 100, to_name: to, from_name: from, message, deliver, buyer_email: buyer, recipient_email: deliver === "recipient" ? recipient : "", send_on } };
}

/** Website: start a card payment for a voucher. Returns the Stripe page to send the buyer to. */
export async function voucherCheckout(env: PayEnv, db: DB, input: Row): Promise<Out> {
  if (!stripeOn(env)) return fail(503, "payments_off", `Card payments are not switched on yet. Please call us on ${PHONE} to buy a voucher.`);
  if (str(input._honey, 100)) return fail(400, "rejected", "Sorry, we could not start that payment.");
  const r = readVoucherInput(input, false);
  if (r.error) return r.error;
  const since = new Date(clock.now().getTime() - 10 * 60_000).toISOString();
  const busy = await db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'pending' AND created_at > ?1").bind(since).first<{ n: number }>();
  if ((busy?.n ?? 0) > 40) return fail(429, "busy", `Too many payments are being started just now. Please try again in a few minutes, or call us on ${PHONE}.`);
  const v = await insertVoucher(db, { ...r.v!, status: "pending", source: "online", paid_by: "card online" });
  const home = site(env);
  try {
    const s = await createCheckout(env, {
      pence: v.amount,
      name: "Terrarium Bistro gift voucher",
      description: `${money(v.amount)} for ${v.to_name}. Valid for 12 months.`,
      email: v.buyer_email,
      successUrl: `${home}?voucher={CHECKOUT_SESSION_ID}#vouchers`,
      cancelUrl: `${home}?voucher_cancelled=1#vouchers`,
      metadata: { kind: "voucher", voucher_id: String(v.id), serial: v.serial },
      paymentDescription: `Gift voucher ${v.serial}`,
      expiresInMin: 60,
      idempotencyKey: `voucher-${v.id}`,
    });
    await db.prepare("UPDATE vouchers SET stripe_session = ?2, updated_at = ?3 WHERE id = ?1").bind(v.id, s.id, nowIso()).run();
    return ok({ url: s.url, mode: stripeMode(env) });
  } catch (e) {
    console.error("voucher checkout", e);
    await db.prepare("UPDATE vouchers SET status = 'unpaid', updated_at = ?2 WHERE id = ?1").bind(v.id, nowIso()).run();
    return fail(502, "stripe", `We could not open the card payment just now. Please try again, or call us on ${PHONE}.`);
  }
}

/** Marks a voucher paid (once) and sends its emails. */
async function activate(env: PayEnv, db: DB, v: Voucher, payment: string | null, paidBy: string): Promise<boolean> {
  const today = londonNow().date;
  const r = await db
    .prepare("UPDATE vouchers SET status = 'active', paid_at = ?2, stripe_payment = ?3, paid_by = ?4, expires_on = ?5, updated_at = ?2 WHERE id = ?1 AND status = 'pending'")
    .bind(v.id, nowIso(), payment, paidBy, plusYear(today))
    .run();
  if ((r.meta.changes ?? 0) < 1) return false;
  const fresh = (await byId(db, v.id))!;
  await sendVoucherEmails(env, db, fresh, true).catch((e) => console.error("voucher email", e));
  return true;
}

/** Sends whatever is due for a voucher: the voucher itself (today, or on its chosen day) and, the first time, the receipt. */
async function sendVoucherEmails(env: PayEnv, db: DB, v: Voucher, first: boolean) {
  if (!env.RESEND_API_KEY) return;
  const today = londonNow().date;
  const view = await voucherLink(env, db, v.serial);
  const reply = env.RESTAURANT_EMAIL || undefined;
  const target = v.deliver === "recipient" ? v.recipient_email : v.deliver === "buyer" ? v.buyer_email : "";
  let sentNow = false;
  if (target && !v.sent_at && v.send_on <= today) {
    const claim = await db.prepare("UPDATE vouchers SET sent_at = ?2 WHERE id = ?1 AND sent_at IS NULL").bind(v.id, nowIso()).run();
    if ((claim.meta.changes ?? 0) > 0) {
      const m = voucherEmail(mail(v), view, site(env), v.deliver === "buyer");
      sentNow = await sendEmail(env, { to: [target], subject: m.subject, html: m.html, text: m.text, reply_to: reply, headers: { "X-Entity-Ref-ID": v.serial } });
      if (!sentNow) await db.prepare("UPDATE vouchers SET sent_at = NULL WHERE id = ?1").bind(v.id).run();
    }
  }
  if (!first) return;
  if (v.deliver === "recipient" && v.buyer_email) {
    const m = voucherReceiptEmail(mail(v), view, site(env), v.send_on <= today);
    await sendEmail(env, { to: [v.buyer_email], subject: m.subject, html: m.html, text: m.text, reply_to: reply, headers: { "X-Entity-Ref-ID": `${v.serial}-receipt` } });
  }
  if (v.source === "online" && env.RESTAURANT_EMAIL) {
    const m = restaurantVoucherEmail(mail(v), env.STAFF_URL);
    await sendEmail(env, { to: [env.RESTAURANT_EMAIL], subject: m.subject, html: m.html, text: m.text, reply_to: v.buyer_email || undefined });
  }
}

/** Asks Stripe about a voucher still waiting for payment, and settles it either way. */
async function settleVoucher(env: PayEnv, db: DB, v: Voucher, session?: Session): Promise<Voucher> {
  if (v.status !== "pending" || !v.stripe_session || !stripeOn(env)) return v;
  const s = session ?? (await getSession(env, v.stripe_session));
  if (isPaid(s, v.amount)) await activate(env, db, v, s.payment_intent, stripeMode(env) === "test" ? "TEST card, no real money" : "card online");
  else if (s.status === "expired") await db.prepare("UPDATE vouchers SET status = 'unpaid', updated_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(v.id, nowIso()).run();
  return (await byId(db, v.id))!;
}

/** Website: the buyer is back from Stripe (session id) or someone opened their voucher link (serial + signature). */
export async function voucherLookup(env: PayEnv, db: DB, q: URLSearchParams): Promise<Out> {
  const session = (q.get("session") ?? "").trim();
  if (session) {
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(session)) return fail(400, "bad_session", "That payment link is not complete.");
    let v = await db.prepare("SELECT * FROM vouchers WHERE stripe_session = ?1").bind(session).first<Voucher>();
    if (!v) return fail(404, "not_found", "We could not find that payment.");
    v = await settleVoucher(env, db, v).catch(() => v!);
    if (v.status === "pending") return fail(202, "pending", "Your payment is still going through. This page will update in a moment.");
    if (v.status === "unpaid") return fail(410, "unpaid", "That payment was not completed, so no voucher was issued.");
    return ok({ voucher: { ...publicVoucher(v), link: await voucherLink(env, db, v.serial) } });
  }
  const serial = (q.get("v") ?? "").toUpperCase().trim(), k = (q.get("k") ?? "").trim();
  if (!/^TB-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]$/.test(serial) || !/^[0-9a-f]{24}$/.test(k) || !sameText(k, await mac(db, `voucher:${serial}`)))
    return fail(404, "not_found", "This voucher link is not working. Please check it was copied in full.");
  const v = await db.prepare("SELECT * FROM vouchers WHERE serial = ?1").bind(serial).first<Voucher>();
  if (!v || v.status === "pending" || v.status === "unpaid") return fail(404, "not_found", "We could not find that voucher.");
  return ok({ voucher: { ...publicVoucher(v), link: await voucherLink(env, db, v.serial) } });
}

/* ---------------------------------------------------------------- staff side */

export async function staffVouchers(env: PayEnv, db: DB, q: URLSearchParams) {
  const term = (q.get("q") ?? "").trim().slice(0, 60);
  const today = londonNow().date;
  let rows: Voucher[];
  if (term.length >= 2) {
    const c = compact(term), like = `%${term.replace(/[%_]/g, "")}%`;
    rows = (await db
      .prepare(
        `SELECT * FROM vouchers WHERE status <> 'unpaid' AND (
           (?1 <> '' AND replace(serial, '-', '') LIKE ?2) OR to_name LIKE ?3 OR from_name LIKE ?3 OR buyer_email LIKE ?3 OR recipient_email LIKE ?3)
         ORDER BY id DESC LIMIT 60`,
      )
      .bind(c, `%${c}%`, like)
      .all<Voucher>()).results;
  } else {
    rows = (await db.prepare("SELECT * FROM vouchers WHERE status <> 'unpaid' ORDER BY id DESC LIMIT 60").all<Voucher>()).results;
  }
  const month = today.slice(0, 7);
  const t = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'active' AND expires_on >= ?1 THEN balance END), 0) AS outstanding,
         COUNT(CASE WHEN status = 'active' AND expires_on >= ?1 THEN 1 END) AS live,
         COALESCE(SUM(CASE WHEN status IN ('active','used') AND substr(paid_at, 1, 7) = ?2 THEN amount END), 0) AS soldMonth,
         COUNT(CASE WHEN status IN ('active','used') AND substr(paid_at, 1, 7) = ?2 THEN 1 END) AS soldMonthCount
       FROM vouchers`,
    )
    .bind(today, month)
    .first<Row>();
  return { ok: true, today, payments: stripeMode(env), vouchers: rows.map((v) => staffView(v, today)), totals: t };
}

const staffView = (v: Voucher, today: string) => ({ ...v, expired: v.status === "active" && !!v.expires_on && v.expires_on < today });

export async function staffVoucher(env: PayEnv, db: DB, id: number): Promise<Out> {
  let v = await byId(db, id);
  if (!v) return fail(404, "not_found", "That voucher no longer exists.");
  if (v.status === "pending") v = await settleVoucher(env, db, v).catch(() => v!);
  const uses = (await db.prepare("SELECT * FROM voucher_uses WHERE voucher_id = ?1 ORDER BY id DESC").bind(id).all<Row>()).results;
  return ok({ voucher: staffView(v!, londonNow().date), uses, link: await voucherLink(env, db, v!.serial) });
}

const pence = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[£,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export async function staffVoucherUse(db: DB, input: Row): Promise<Out> {
  const id = Number(input.id), p = pence(input.amount);
  const v = await byId(db, id);
  if (!v) return fail(404, "not_found", "That voucher no longer exists.");
  if (v.status !== "active") return fail(409, "not_active", v.status === "used" ? "This voucher has already been spent in full." : v.status === "void" ? "This voucher was cancelled." : "This voucher has not been paid for.");
  if (!(p > 0)) return fail(400, "bad_amount", "Enter the amount to take off.");
  if (p > v.balance) return fail(400, "too_much", `Only ${money(v.balance)} is left on this voucher.`);
  if (v.expires_on && v.expires_on < londonNow().date && !input.force)
    return fail(409, "expired", `This voucher ran out on ${longDate(v.expires_on)}.`, { expires_on: v.expires_on });
  const r = await db
    .prepare("UPDATE vouchers SET balance = balance - ?2, status = CASE WHEN balance - ?2 = 0 THEN 'used' ELSE status END, updated_at = ?3 WHERE id = ?1 AND status = 'active' AND balance >= ?2")
    .bind(id, p, nowIso())
    .run();
  if ((r.meta.changes ?? 0) < 1) return fail(409, "changed", "The balance changed on another tablet. Check it and try again.");
  await db.prepare("INSERT INTO voucher_uses (voucher_id, amount, note, created_at) VALUES (?1, ?2, ?3, ?4)").bind(id, p, str(input.note, 120), nowIso()).run();
  const after = (await byId(db, id))!;
  return ok({ balance: after.balance, status: after.status });
}

export async function staffVoucherUndo(db: DB, input: Row): Promise<Out> {
  const use = await db.prepare("SELECT * FROM voucher_uses WHERE id = ?1").bind(Number(input.use_id)).first<{ id: number; voucher_id: number; amount: number; undone: number }>();
  if (!use || use.undone) return fail(404, "not_found", "Nothing to undo.");
  const v = await byId(db, use.voucher_id);
  if (!v || !["active", "used"].includes(v.status)) return fail(409, "not_active", "This voucher can no longer be changed.");
  const mark = await db.prepare("UPDATE voucher_uses SET undone = 1 WHERE id = ?1 AND undone = 0").bind(use.id).run();
  if ((mark.meta.changes ?? 0) < 1) return fail(409, "changed", "That was already undone.");
  await db.prepare("UPDATE vouchers SET balance = MIN(amount, balance + ?2), status = 'active', updated_at = ?3 WHERE id = ?1").bind(v.id, use.amount, nowIso()).run();
  return ok({});
}

export async function staffVoucherVoid(db: DB, input: Row): Promise<Out> {
  const r = await db
    .prepare("UPDATE vouchers SET status = 'void', note = trim(note || ' ' || ?2), updated_at = ?3 WHERE id = ?1 AND status IN ('active','pending')")
    .bind(Number(input.id), `Cancelled on the tablet${str(input.note, 120) ? `: ${str(input.note, 120)}` : ""}.`, nowIso())
    .run();
  if ((r.meta.changes ?? 0) < 1) return fail(409, "not_active", "This voucher cannot be cancelled now.");
  return ok({});
}

/** Sold in person or by phone: live straight away, emailed if an address was given. */
export async function staffVoucherSell(env: PayEnv, db: DB, input: Row): Promise<Out> {
  const r = readVoucherInput(input, true);
  if (r.error) return r.error;
  const paidBy = input.paid_by === "cash" ? "cash" : "card";
  const source = input.source === "phone" ? "phone" : "bar";
  const v = await insertVoucher(db, { ...r.v!, status: "pending", source, paid_by: paidBy });
  await activate(env, db, v, null, paidBy);
  const fresh = (await byId(db, v.id))!;
  return ok({ voucher: staffView(fresh, londonNow().date), link: await voucherLink(env, db, fresh.serial), emailed: !!fresh.sent_at });
}

export async function staffVoucherResend(env: PayEnv, db: DB, input: Row): Promise<Out> {
  const v = await byId(db, Number(input.id));
  if (!v || !["active", "used"].includes(v.status)) return fail(404, "not_found", "That voucher cannot be sent.");
  if (!env.RESEND_API_KEY) return fail(503, "no_email", "Email is not set up yet.");
  const email = str(input.email, 120);
  if (email && !EMAIL_RE.test(email)) return fail(400, "bad_email", "Check the email address.");
  const deliver = email ? "recipient" : v.deliver;
  const to = email || (v.deliver === "recipient" ? v.recipient_email : v.buyer_email);
  if (!to) return fail(400, "no_address", "Add an email address to send it to.");
  await db
    .prepare("UPDATE vouchers SET sent_at = NULL, send_on = ?2, deliver = ?3, recipient_email = CASE WHEN ?4 <> '' THEN ?4 ELSE recipient_email END, updated_at = ?5 WHERE id = ?1")
    .bind(v.id, londonNow().date, deliver, email, nowIso())
    .run();
  await sendVoucherEmails(env, db, (await byId(db, v.id))!, false);
  const after = (await byId(db, v.id))!;
  return after.sent_at ? ok({ to }) : fail(502, "send_failed", "The email did not go. Try again in a minute.");
}

/* =================================================================== deposits */

type Deposit = {
  booking_id: number; ref: string; amount: number; status: string; hold_until: string | null;
  stripe_session: string | null; stripe_payment: string | null; paid_at: string | null; created_at: string; updated_at: string;
};
const depositOf = (db: DB, id: number) => db.prepare("SELECT * FROM deposits WHERE booking_id = ?1").bind(id).first<Deposit>();
const bookingOf = (db: DB, id: number) => db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE id = ?1`).bind(id).first<Booking>();

export async function depositLink(env: PayEnv, db: DB, ref: string) {
  return `${baseUrl(env)}/deposit?r=${encodeURIComponent(ref)}&t=${await mac(db, `deposit:${ref}`)}`;
}

/** A new online booking for a big group: hold the seats while the guest pays. */
export async function holdForDeposit(env: PayEnv, db: DB, booking: { id: number; ref: string }, amount: number) {
  const at = nowIso();
  await db
    .prepare("INSERT OR IGNORE INTO deposits (booking_id, ref, amount, status, hold_until, created_at, updated_at) VALUES (?1, ?2, ?3, 'due', ?4, ?5, ?5)")
    .bind(booking.id, booking.ref, amount, minsFromNow(HOLD_MINS + 5), at)
    .run();
  return { url: await depositLink(env, db, booking.ref), pence: amount, holdMins: HOLD_MINS };
}

/** Adds each booking's deposit, if it has one, for the tablet. */
export async function withDeposits<T extends { id: number }>(db: DB, bookings: T[]) {
  if (!bookings.length) return bookings;
  const ids = bookings.map((b) => b.id);
  const rows = (await db.prepare(`SELECT * FROM deposits WHERE booking_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Deposit>()).results;
  const m = new Map(rows.map((d) => [d.booking_id, d]));
  return bookings.map((b) => {
    const d = m.get(b.id);
    return d ? { ...b, deposit: { pence: d.amount, status: d.status, held: !!d.hold_until && d.status === "due", paid_at: d.paid_at } } : b;
  });
}

/** Records a paid deposit (once) and sends the right emails. */
async function confirmDeposit(env: PayEnv, db: DB, d: Deposit, s: Session): Promise<"paid" | "unpaid"> {
  if (!isPaid(s, d.amount)) return "unpaid";
  const online = !!d.hold_until;
  const r = await db
    .prepare("UPDATE deposits SET status = 'paid', paid_at = ?2, stripe_payment = ?3, hold_until = NULL, updated_at = ?2 WHERE booking_id = ?1 AND status IN ('due','lapsed')")
    .bind(d.booking_id, nowIso(), s.payment_intent)
    .run();
  if ((r.meta.changes ?? 0) < 1) return "paid";
  let b = await bookingOf(db, d.booking_id);
  if (!b) return "paid";
  const settings = await getSettings(db);
  let warning = "";
  if (stripeMode(env) === "test")
    await db.prepare("UPDATE bookings SET staff_note = trim(staff_note || ' ' || ?2) WHERE id = ?1").bind(b.id, "Deposit paid with a Stripe TEST card: no real money.").run();
  if (b.status === "cancelled") {
    // Paid after the hold ran out: put the table back if it still fits, otherwise tell the restaurant.
    const fits = await checkSlotFor(db, b.date, b.time, b.guests, b.id);
    if (fits && d.status === "lapsed") {
      await db.prepare("UPDATE bookings SET status = 'booked', updated_at = ?2 WHERE id = ?1").bind(b.id, nowIso()).run();
      b = (await bookingOf(db, b.id))!;
    } else {
      warning = `This deposit was paid after the booking was ${d.status === "lapsed" ? "released (the 30-minute hold ran out)" : "cancelled"}, and the time is no longer free. Please call the guest, and refund the deposit in Stripe if you cannot fit them in.`;
    }
  } else {
    await db.prepare("UPDATE bookings SET updated_at = ?2 WHERE id = ?1").bind(b.id, nowIso()).run();
  }
  if (!env.RESEND_API_KEY) return "paid";
  const note = { pence: d.amount, hours: settings.depositHours };
  if (online && !warning) {
    const link = await cancelUrl(env, db, b.ref, b.email).catch(() => "");
    await sendBookingEmails(env, { ...b, newsletter: !!b.newsletter }, b.ref, link, note).catch(() => false);
  } else {
    const g = asBooked(b);
    if (!warning && b.email) {
      const m = depositPaidEmail(g, d.amount, settings.depositHours, env.PUBLIC_SITE);
      await sendEmail(env, { to: [b.email], subject: m.subject, html: m.html, text: m.text, reply_to: env.RESTAURANT_EMAIL || undefined });
    }
    if (env.RESTAURANT_EMAIL) {
      const m = restaurantDepositEmail(g, d.amount, env.STAFF_URL, warning);
      await sendEmail(env, { to: [env.RESTAURANT_EMAIL], subject: m.subject, html: m.html, text: m.text, reply_to: b.email || undefined });
    }
  }
  return "paid";
}

/**
 * Releases online bookings whose deposit was not paid in time, after one last check with Stripe.
 * Cheap when there is nothing to do, so it runs before availability is worked out.
 */
export async function releaseLapsedHolds(env: PayEnv, db: DB) {
  const due = (await db
    .prepare("SELECT * FROM deposits WHERE status = 'due' AND hold_until IS NOT NULL AND hold_until < ?1 ORDER BY hold_until LIMIT 10")
    .bind(nowIso())
    .all<Deposit>()).results;
  let released = 0;
  for (const d of due) {
    if (d.stripe_session && stripeOn(env)) {
      try {
        const s = await getSession(env, d.stripe_session);
        if ((await confirmDeposit(env, db, d, s)) === "paid") continue;
        if (s.status === "open") continue; // Stripe still has the page open; the next pass decides
      } catch (e) {
        console.error("hold check", e);
        continue; // never release a table while Stripe cannot be asked
      }
    }
    const r = await db.prepare("UPDATE deposits SET status = 'lapsed', updated_at = ?2 WHERE booking_id = ?1 AND status = 'due'").bind(d.booking_id, nowIso()).run();
    if ((r.meta.changes ?? 0) < 1) continue;
    await db
      .prepare("UPDATE bookings SET status = 'cancelled', staff_note = trim(staff_note || ' ' || ?2), updated_at = ?3 WHERE id = ?1 AND status IN ('booked','late')")
      .bind(d.booking_id, "Released automatically: the deposit was not paid within 30 minutes.", nowIso())
      .run();
    released++;
  }
  return released;
}

/* ------------------------------------------------- the guest's deposit page */

const PAGE_TAIL = `<p style="margin-top:16px;font-size:.9rem">Payments are handled by Stripe. We never see your card details.</p>`;

async function verifiedBooking(db: DB, r: string, t: string) {
  const ref = r.trim().toUpperCase().slice(0, 20);
  if (!ref || !/^[0-9a-f]{24}$/.test(t) || !sameText(t, await mac(db, `deposit:${ref}`))) return null;
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE ref = ?1`).bind(ref).first<Booking>();
}

const holdLeft = (d: Deposit) => (d.hold_until ? Math.max(0, Math.round((new Date(d.hold_until).getTime() - clock.now().getTime()) / 60_000) - 5) : null);
const ukTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/** /deposit: GET shows the booking and a Pay button; POST opens Stripe. /deposit/done: where Stripe sends the guest back. */
export async function depositRoute(request: Request, env: PayEnv, db: DB): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") === "/deposit/done") return depositDone(env, db, url.searchParams.get("s") ?? "");
  let r = url.searchParams.get("r") ?? "", t = url.searchParams.get("t") ?? "";
  if (request.method === "POST") {
    const f = await request.formData().catch(() => null);
    r = String(f?.get("r") ?? r);
    t = String(f?.get("t") ?? t);
  } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const b = await verifiedBooking(db, r, t);
  if (!b)
    return page(env, { kicker: "Deposit", status: 404, title: "This link is not <i>working.</i>", body: `<p>We could not match this link to a booking. Please call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>` });
  await releaseLapsedHolds(env, db).catch(() => 0);
  const s = await getSettings(db);
  let d = await depositOf(db, b.id);
  if (!d) {
    const p = depositPence(s, b.guests) || b.guests * s.depositPerHead * 100;
    await db.prepare("INSERT OR IGNORE INTO deposits (booking_id, ref, amount, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'due', ?4, ?4)").bind(b.id, b.ref, p, nowIso()).run();
    d = (await depositOf(db, b.id))!;
  }
  const fresh = (await bookingOf(db, b.id))!;
  if (d.status === "paid")
    return page(env, { kicker: b.ref, title: "Deposit <i>received.</i>", body: `<p>Thank you, ${esc(b.first)}. Your ${esc(money(d.amount))} deposit is paid and your table is secured.</p>${details(fresh)}` });
  if (d.status === "waived" || d.status === "refunded")
    return page(env, { kicker: b.ref, title: "Nothing to <i>pay.</i>", body: `<p>There is no deposit to pay on this booking. Call us on <a href="tel:${PHONE_INTL}">${PHONE}</a> if you have any questions.</p>${details(fresh)}` });
  if (d.status === "lapsed" || fresh.status === "cancelled" || fresh.status === "noshow")
    return page(env, {
      kicker: b.ref, title: "This table was <i>released.</i>",
      body: `<p>${d.status === "lapsed" ? "The deposit was not paid within 30 minutes, so the table was offered to other guests." : "This booking was cancelled."} You have not been charged. Please book again or call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>${env.PUBLIC_SITE ? `<p style="margin-top:22px"><a class="btn" href="${esc(site(env))}#book">Book again</a></p>` : ""}`,
    });
  if (!stripeOn(env))
    return page(env, { kicker: b.ref, title: "Please give us a <i>call.</i>", body: `<p>Card payments are not available online just now. Call us on <a href="tel:${PHONE_INTL}">${PHONE}</a> to pay your deposit.</p>${details(fresh)}` });

  if (request.method === "GET") {
    const left = holdLeft(d);
    const hold = left !== null ? `<p style="margin-top:14px;color:var(--gold-hi)">We are holding your table until ${esc(ukTime(new Date(new Date(d.hold_until!).getTime() - 5 * 60_000).toISOString()))} (${left} minutes).</p>` : "";
    return page(env, {
      kicker: "Deposit · " + b.ref,
      title: `Secure your table for <i>${b.guests}.</i>`,
      body: `<p>For groups of ${s.depositFrom || b.guests} or more we ask for a deposit of £${s.depositPerHead} a person: <b style="color:var(--cream)">${esc(money(d.amount))}</b>. ${esc(depositRule(s.depositHours))}</p>${hold}${details(fresh)}
<form method="post" action="/deposit"><input type="hidden" name="r" value="${esc(b.ref)}"><input type="hidden" name="t" value="${esc(t)}">
<button type="submit" style="background:var(--gold);color:var(--ink);border-color:var(--gold)">Pay ${esc(money(d.amount))} by card</button></form>${PAGE_TAIL}`,
    });
  }

  // POST: reuse the guest's open Stripe page if there is one, otherwise open a new one.
  try {
    if (d.stripe_session) {
      const old = await getSession(env, d.stripe_session);
      if ((await confirmDeposit(env, db, d, old)) === "paid") return Response.redirect(`${baseUrl(env)}/deposit/done?s=${encodeURIComponent(old.id)}`, 303);
      if (old.status === "open" && old.url && (old.amount_total ?? 0) === d.amount) return Response.redirect(old.url, 303);
    }
    const left = holdLeft(d);
    const session = await createCheckout(env, {
      pence: d.amount,
      name: `Deposit: table for ${b.guests}`,
      description: `${longDate(b.date)} at ${b.time}. Reference ${b.ref}.`,
      email: b.email || undefined,
      successUrl: `${baseUrl(env)}/deposit/done?s={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl(env)}/deposit?r=${encodeURIComponent(b.ref)}&t=${t}`,
      metadata: { kind: "deposit", booking_id: String(b.id), ref: b.ref },
      paymentDescription: `Deposit ${b.ref}`,
      expiresInMin: left !== null ? Math.max(31, left) : 24 * 60,
      idempotencyKey: `deposit-${b.id}-${d.amount}-${Math.floor(clock.now().getTime() / 600_000)}`,
    });
    // An online hold lasts as long as the Stripe page can still be paid.
    const hold = d.hold_until ? new Date(Math.max(new Date(d.hold_until).getTime(), (session.expires_at + 120) * 1000)).toISOString() : null;
    await db.prepare("UPDATE deposits SET stripe_session = ?2, hold_until = ?3, updated_at = ?4 WHERE booking_id = ?1").bind(b.id, session.id, hold, nowIso()).run();
    return Response.redirect(session.url!, 303);
  } catch (e) {
    console.error("deposit checkout", e);
    return page(env, { kicker: b.ref, status: 502, title: "Payment page not <i>available.</i>", body: `<p>We could not open the card payment just now. Please try again in a minute, or call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>` });
  }
}

async function depositDone(env: PayEnv, db: DB, sid: string): Promise<Response> {
  const d = /^cs_[A-Za-z0-9_]{10,200}$/.test(sid) ? await db.prepare("SELECT * FROM deposits WHERE stripe_session = ?1").bind(sid).first<Deposit>() : null;
  const b = d ? await bookingOf(db, d.booking_id) : null;
  if (!d || !b) return page(env, { kicker: "Deposit", status: 404, title: "We could not find that <i>payment.</i>", body: `<p>If you have paid, your confirmation email is on its way. Otherwise call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>` });
  let state: "paid" | "unpaid" = d.status === "paid" ? "paid" : "unpaid";
  if (state !== "paid" && stripeOn(env)) {
    try {
      state = await confirmDeposit(env, db, d, await getSession(env, sid));
    } catch (e) {
      console.error("deposit done", e);
    }
  }
  const fresh = (await bookingOf(db, b.id))!;
  if (state !== "paid")
    return page(env, {
      kicker: b.ref, title: "Your payment is <i>going through.</i>",
      body: `<p>Stripe has not confirmed the payment yet. Refresh this page in a moment. If it does not change, call us on <a href="tel:${PHONE_INTL}">${PHONE}</a>.</p>${details(fresh)}`,
    });
  const after = (await depositOf(db, b.id))!;
  if (fresh.status === "cancelled")
    return page(env, {
      kicker: b.ref, title: "Payment received. <i>We will call you.</i>",
      body: `<p>Thank you, ${esc(b.first)}. Your deposit arrived after the table had been released, and that time is now taken. We will call you on ${esc(b.phone || "your number")} to find you a table or refund you in full.</p>${details(fresh)}`,
    });
  const cal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("Table at Terrarium Bistro")}&dates=${encodeURIComponent(calDates(b))}&ctz=Europe/London&location=${encodeURIComponent("Terrarium Bistro, 44 High St, Tarporley CW6 0DX")}`;
  return page(env, {
    kicker: b.ref,
    title: "Your table is <i>confirmed.</i>",
    body: `<p>Thank you, ${esc(b.first)}. We have your ${esc(money(after.amount))} deposit${b.email ? ` and have emailed the details to ${esc(b.email)}` : ""}.</p>${details(fresh)}
<p style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="${esc(cal)}" target="_blank" rel="noopener">Add to Google Calendar</a>${env.PUBLIC_SITE ? `<a class="btn" href="${esc(site(env))}">Back to the website</a>` : ""}</p>`,
  });
}

function calDates(b: Booking) {
  const d = b.date.replace(/-/g, ""), [h, m] = b.time.split(":").map(Number);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d}T${two(h)}${two(m)}00/${d}T${two(Math.min(23, h + 2))}${two(m)}00`;
}

/* ------------------------------------------------------- staff: deposits */

/** Makes (or refreshes) the deposit for a booking and returns its pay link; emails it to the guest if asked. */
export async function staffDepositLink(env: PayEnv, db: DB, input: Row): Promise<Out> {
  const b = await bookingOf(db, Number(input.id));
  if (!b) return fail(404, "not_found", "That booking no longer exists.");
  const s = await getSettings(db);
  const p = Math.max(100, depositPence(s, b.guests) || b.guests * s.depositPerHead * 100);
  const at = nowIso();
  await db
    .prepare(
      `INSERT INTO deposits (booking_id, ref, amount, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'due', ?4, ?4)
       ON CONFLICT(booking_id) DO UPDATE SET amount = CASE WHEN deposits.status = 'due' THEN excluded.amount ELSE deposits.amount END,
         stripe_session = CASE WHEN deposits.status = 'due' AND deposits.amount <> excluded.amount THEN NULL ELSE deposits.stripe_session END,
         updated_at = excluded.updated_at`,
    )
    .bind(b.id, b.ref, p, at)
    .run();
  const d = (await depositOf(db, b.id))!;
  if (d.status === "paid") return fail(409, "paid", "This deposit is already paid.");
  const url = await depositLink(env, db, b.ref);
  let emailed = false;
  if (input.send === "email") {
    if (!b.email) return fail(400, "no_email", "This booking has no email address. Text the link instead.");
    if (!env.RESEND_API_KEY) return fail(503, "no_email", "Email is not set up yet. Text the link instead.");
    const m = depositRequestEmail(asBooked(b), d.amount, url, s.depositHours, env.PUBLIC_SITE);
    emailed = await sendEmail(env, { to: [b.email], subject: m.subject, html: m.html, text: m.text, reply_to: env.RESTAURANT_EMAIL || undefined });
    if (!emailed) return fail(502, "send_failed", "The email did not go. Try again, or text the link.");
  }
  return ok({ url, pence: d.amount, emailed, payments: stripeMode(env) });
}

/** Staff mark a deposit by hand: paid on the card machine, waived, refunded in Stripe, or back to due. */
export async function staffDepositSet(db: DB, input: Row): Promise<Out> {
  const id = Number(input.id), status = String(input.status ?? "");
  if (!["paid", "waived", "refunded", "due"].includes(status)) return fail(400, "bad_status", "Unknown deposit status.");
  const b = await bookingOf(db, id);
  if (!b) return fail(404, "not_found", "That booking no longer exists.");
  const s = await getSettings(db);
  const at = nowIso();
  await db
    .prepare(
      `INSERT INTO deposits (booking_id, ref, amount, status, paid_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(booking_id) DO UPDATE SET status = excluded.status, hold_until = NULL,
         paid_at = CASE WHEN excluded.status = 'paid' THEN COALESCE(deposits.paid_at, excluded.paid_at) ELSE deposits.paid_at END, updated_at = excluded.updated_at`,
    )
    .bind(id, b.ref, Math.max(100, b.guests * s.depositPerHead * 100), status, status === "paid" ? at : null, at)
    .run();
  await db.prepare("UPDATE bookings SET updated_at = ?2 WHERE id = ?1").bind(id, at).run();
  return ok({});
}

/** A line for the restaurant's "cancelled online" email when the booking had a deposit. */
export async function depositCancelLine(db: DB, b: Booking): Promise<string> {
  const d = await depositOf(db, b.id);
  if (!d || d.status !== "paid") return "";
  const s = await getSettings(db);
  const hours = Math.floor((londonToUtc(b.date, b.time).getTime() - clock.now().getTime()) / 3600_000);
  return hours >= s.depositHours
    ? `A ${money(d.amount)} deposit was paid. The guest cancelled ${hours} hours before, inside your ${s.depositHours}-hour rule, so refund it in Stripe (Payments, find ${b.ref}, Refund).`
    : `A ${money(d.amount)} deposit was paid. The guest cancelled ${Math.max(0, hours)} hours before, later than your ${s.depositHours}-hour rule, so the deposit is kept.`;
}

/** What the guest sees on the cancel page about their deposit. */
export async function depositCancelNote(db: DB, b: Booking): Promise<string> {
  const d = await depositOf(db, b.id);
  if (!d || d.status !== "paid") return "";
  const s = await getSettings(db);
  const hours = Math.floor((londonToUtc(b.date, b.time).getTime() - clock.now().getTime()) / 3600_000);
  return hours >= s.depositHours
    ? `You are cancelling more than ${s.depositHours} hours before, so we will refund your ${money(d.amount)} deposit in full.`
    : `As this is less than ${s.depositHours} hours before your booking, your ${money(d.amount)} deposit is not refundable.`;
}

/* ---------------------------------------------------------- the hourly run */

/** Settles payments nobody came back to confirm, releases lapsed holds and sends vouchers due today. */
export async function paymentsHourly(env: PayEnv, db: DB) {
  const out = { vouchersPaid: 0, depositsPaid: 0, released: 0, vouchersSent: 0 };
  if (stripeOn(env)) {
    const since = new Date(clock.now().getTime() - 3 * 24 * 3600_000).toISOString();
    const vs = (await db.prepare("SELECT * FROM vouchers WHERE status = 'pending' AND stripe_session IS NOT NULL AND created_at > ?1 ORDER BY id LIMIT 25").bind(since).all<Voucher>()).results;
    for (const v of vs) {
      try {
        if ((await settleVoucher(env, db, v)).status === "active") out.vouchersPaid++;
      } catch (e) {
        console.error("settle voucher", e);
      }
    }
    // Lapsed ones too: a guest can finish paying in the last seconds before the hold runs out.
    const ds = (await db.prepare("SELECT * FROM deposits WHERE status IN ('due','lapsed') AND stripe_session IS NOT NULL AND updated_at > ?1 ORDER BY updated_at LIMIT 25").bind(since).all<Deposit>()).results;
    for (const d of ds) {
      try {
        if ((await confirmDeposit(env, db, d, await getSession(env, d.stripe_session!))) === "paid") out.depositsPaid++;
      } catch (e) {
        console.error("settle deposit", e);
      }
    }
  }
  // Payment pages that were never finished.
  await db.prepare("UPDATE vouchers SET status = 'unpaid', updated_at = ?2 WHERE status = 'pending' AND created_at < ?1")
    .bind(new Date(clock.now().getTime() - 3 * 24 * 3600_000).toISOString(), nowIso()).run();
  out.released = await releaseLapsedHolds(env, db);
  // Vouchers chosen to arrive on a later day go out from 8am on that day.
  const now = londonNow();
  if (env.RESEND_API_KEY && now.mins >= 8 * 60) {
    const due = (await db
      .prepare("SELECT * FROM vouchers WHERE status IN ('active','used') AND deliver = 'recipient' AND sent_at IS NULL AND send_on <= ?1 ORDER BY id LIMIT 50")
      .bind(now.date)
      .all<Voucher>()).results;
    for (const v of due) {
      await sendVoucherEmails(env, db, v, false).catch((e) => console.error("voucher send", e));
      if ((await byId(db, v.id))?.sent_at) out.vouchersSent++;
    }
  }
  return out;
}
