// Terrarium Bistro booking engine.
// Framework-free on purpose: it takes a D1-style database so the same code runs
// on Cloudflare (D1) and in local tests (SQLite).

export type Row = Record<string, unknown>;
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}
export interface DB {
  prepare(sql: string): Stmt;
}

export type Service = { name: string; times: string[] };
export type Settings = {
  online: boolean; // accept online bookings at all
  slotCovers: number; // most guests who can start in one time slot
  capacity: number; // seats in the restaurant
  duration: number; // minutes a table is held
  maxOnline: number; // largest party bookable online
  daysAhead: number; // how far ahead guests can book
  minNotice: number; // minutes of notice needed for a same-day booking
  closedWeekdays: number[]; // 0 = Sunday ... 6 = Saturday
  services: Service[];
};

const range = (fromH: number, toH: number) => {
  const out: string[] = [];
  for (let m = fromH * 60; m <= toH * 60; m += 30) out.push(fromMins(m));
  return out;
};

export const DEFAULTS: Settings = {
  online: true,
  slotCovers: 12,
  capacity: 40,
  duration: 90,
  maxOnline: 8,
  daysAhead: 120,
  minNotice: 60,
  closedWeekdays: [2],
  services: [
    { name: "Breakfast", times: range(10, 11.5) },
    { name: "Lunch", times: range(12, 16.5) },
    { name: "Dinner", times: range(17, 21) },
  ],
};

export const STATUSES = ["booked", "seated", "finished", "cancelled", "noshow"] as const;
const COUNTS_COVERS = new Set(["booked", "seated", "finished"]);
const HOLDS_SEATS = new Set(["booked", "seated"]);

/* ------------------------------------------------------------------ time */

export const clock = { now: () => new Date() };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function fromMins(m: number): string {
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
export const toMins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const isTime = (t: unknown): t is string => typeof t === "string" && TIME_RE.test(t);

export function isDate(d: unknown): d is string {
  if (typeof d !== "string" || !DATE_RE.test(d)) return false;
  const [y, m, dd] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === dd;
}
export function weekday(d: string): number {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}
export function addDays(d: string, n: number): string {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}
/** Today's date and minutes past midnight in the UK. */
export function londonNow(): { date: string; mins: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(clock.now());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, mins: Number(get("hour")) * 60 + Number(get("minute")) };
}
const stamp = () => clock.now().toISOString();

/* -------------------------------------------------------------- settings */

const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function cleanSettings(input: unknown): Settings {
  const s = (input && typeof input === "object" ? input : {}) as Partial<Settings>;
  const services: Service[] = [];
  if (Array.isArray(s.services)) {
    for (const sv of s.services.slice(0, 6)) {
      if (!sv || typeof sv !== "object") continue;
      const name = String((sv as Service).name ?? "").trim().slice(0, 24);
      const times = Array.isArray((sv as Service).times)
        ? [...new Set((sv as Service).times.filter(isTime))].sort().slice(0, 48)
        : [];
      if (name && times.length) services.push({ name, times });
    }
  }
  return {
    online: s.online === undefined ? DEFAULTS.online : !!s.online,
    slotCovers: int(s.slotCovers, 0, 500, DEFAULTS.slotCovers),
    capacity: int(s.capacity, 1, 1000, DEFAULTS.capacity),
    duration: int(s.duration, 15, 360, DEFAULTS.duration),
    maxOnline: int(s.maxOnline, 1, 50, DEFAULTS.maxOnline),
    daysAhead: int(s.daysAhead, 1, 730, DEFAULTS.daysAhead),
    minNotice: int(s.minNotice, 0, 2880, DEFAULTS.minNotice),
    closedWeekdays: Array.isArray(s.closedWeekdays)
      ? [...new Set(s.closedWeekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
      : [...DEFAULTS.closedWeekdays],
    services: services.length ? services : DEFAULTS.services.map((x) => ({ ...x, times: [...x.times] })),
  };
}

export async function getSettings(db: DB): Promise<Settings> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'booking'").first<{ value: string }>();
  if (!row) return cleanSettings(DEFAULTS);
  try {
    return cleanSettings({ ...DEFAULTS, ...JSON.parse(row.value) });
  } catch {
    return cleanSettings(DEFAULTS);
  }
}

export async function saveSettings(db: DB, input: unknown): Promise<Settings> {
  const s = cleanSettings(input);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('booking', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(s))
    .run();
  return s;
}

const allTimes = (s: Settings) => s.services.flatMap((x) => x.times);

/* ------------------------------------------------------------ day data */

export type Booking = {
  id: number;
  ref: string;
  date: string;
  time: string;
  mins: number;
  duration: number;
  guests: number;
  first: string;
  last: string;
  email: string;
  phone: string;
  occasion: string;
  notes: string;
  staff_note: string;
  table_no: string;
  newsletter: number;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
};
const PUBLIC_COLS =
  "id, ref, date, time, mins, duration, guests, first, last, email, phone, occasion, notes, staff_note, table_no, newsletter, source, status, created_at, updated_at";

type DayRules = { closed: boolean; override: number | null; note: string; limits: Map<string, number> };

async function dayRules(db: DB, s: Settings, date: string): Promise<DayRules> {
  const d = await db.prepare("SELECT closed, note FROM days WHERE date = ?1").bind(date).first<{ closed: number | null; note: string }>();
  const lim = await db.prepare("SELECT time, covers FROM slot_limits WHERE date = ?1").bind(date).all<{ time: string; covers: number }>();
  const override = d && d.closed !== null && d.closed !== undefined ? Number(d.closed) : null;
  return {
    override,
    closed: override !== null ? override === 1 : s.closedWeekdays.includes(weekday(date)),
    note: d?.note ?? "",
    limits: new Map(lim.results.map((r) => [r.time, Number(r.covers)])),
  };
}

async function dayBookings(db: DB, date: string): Promise<Booking[]> {
  const r = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE date = ?1 ORDER BY mins, id`).bind(date).all<Booking>();
  return r.results;
}

/** Seats held at minute p (bookings still expected or sitting). */
function heldAt(bookings: Booking[], p: number, exclude?: number) {
  let n = 0;
  for (const b of bookings) if (b.id !== exclude && HOLDS_SEATS.has(b.status) && b.mins <= p && b.mins + b.duration > p) n += b.guests;
  return n;
}

export type Check = { ok: boolean; reason?: "slot" | "seats"; covers: number; limit: number; peak: number; capacity: number };

/** Can `guests` more people start at `time`? Uses both the per-slot limit and the seat count. */
export function checkSlot(s: Settings, bookings: Booking[], limits: Map<string, number>, time: string, guests: number, exclude?: number): Check {
  const T = toMins(time);
  let covers = 0;
  for (const b of bookings) if (b.id !== exclude && b.time === time && COUNTS_COVERS.has(b.status)) covers += b.guests;
  const limit = limits.get(time) ?? s.slotCovers;
  const points = [T];
  for (const b of bookings) if (b.id !== exclude && HOLDS_SEATS.has(b.status) && b.mins > T && b.mins < T + s.duration) points.push(b.mins);
  let peak = 0;
  for (const p of points) peak = Math.max(peak, heldAt(bookings, p, exclude));
  const out: Check = { ok: true, covers, limit, peak, capacity: s.capacity };
  if (covers + guests > limit) Object.assign(out, { ok: false, reason: "slot" });
  else if (peak + guests > s.capacity) Object.assign(out, { ok: false, reason: "seats" });
  return out;
}

/* ------------------------------------------------------ public: availability */

export type Fail = { status: number; body: Row };
const fail = (status: number, code: string, message: string, extra: Row = {}): Fail => ({ status, body: { ok: false, code, message, ...extra } });

function windowFor(s: Settings) {
  const now = londonNow();
  return { now, last: addDays(now.date, s.daysAhead) };
}

function timesFor(s: Settings, date: string, guests: number, rules: DayRules, bookings: Booking[]) {
  const { now } = windowFor(s);
  const cutoff = date === now.date ? now.mins + s.minNotice : -1;
  return s.services.map((sv) => ({
    name: sv.name,
    times: sv.times.map((t) => ({ time: t, ok: toMins(t) >= cutoff && checkSlot(s, bookings, rules.limits, t, guests).ok })),
  }));
}

export async function publicSlots(db: DB, date: unknown, guestsIn: unknown) {
  const s = await getSettings(db);
  const guests = Number(guestsIn);
  if (!isDate(date)) return fail(400, "bad_date", "Please choose a date.");
  if (!Number.isInteger(guests) || guests < 1) return fail(400, "bad_guests", "Please choose how many guests.");
  if (guests > s.maxOnline) return fail(400, "party_size", `For more than ${s.maxOnline} guests, please call us.`);
  const base = { ok: true, date, guests, services: [] as ReturnType<typeof timesFor> };
  if (!s.online) return { status: 200, body: { ...base, open: false, reason: "paused" } };
  const { now, last } = windowFor(s);
  if (date < now.date || date > last) return { status: 200, body: { ...base, open: false, reason: "out_of_range" } };
  const rules = await dayRules(db, s, date);
  if (rules.closed) return { status: 200, body: { ...base, open: false, reason: "closed" } };
  const services = timesFor(s, date, guests, rules, await dayBookings(db, date));
  const any = services.some((x) => x.times.some((t) => t.ok));
  return { status: 200, body: { ...base, open: true, full: !any, services } };
}

/** Booking rules plus every date in the booking window that is closed or full for this party size. */
export async function publicCalendar(db: DB, guestsIn: unknown) {
  const s = await getSettings(db);
  let guests = Number(guestsIn);
  if (!Number.isInteger(guests) || guests < 1) guests = 1;
  guests = Math.min(guests, s.maxOnline);
  const { now, last } = windowFor(s);
  const body = {
    ok: true,
    today: now.date,
    last,
    online: s.online,
    maxOnline: s.maxOnline,
    daysAhead: s.daysAhead,
    minNotice: s.minNotice,
    closedWeekdays: s.closedWeekdays,
    services: s.services,
    days: {} as Record<string, "closed" | "full">,
  };
  if (!s.online) return { status: 200, body };
  const [overrides, limits, bookings] = await Promise.all([
    db.prepare("SELECT date, closed FROM days WHERE date BETWEEN ?1 AND ?2").bind(now.date, last).all<{ date: string; closed: number | null }>(),
    db.prepare("SELECT date, time, covers FROM slot_limits WHERE date BETWEEN ?1 AND ?2").bind(now.date, last).all<{ date: string; time: string; covers: number }>(),
    db
      .prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status IN ('booked','seated','finished')`)
      .bind(now.date, last)
      .all<Booking>(),
  ]);
  const ov = new Map(overrides.results.filter((r) => r.closed !== null).map((r) => [r.date, Number(r.closed)]));
  const lim = new Map<string, Map<string, number>>();
  for (const r of limits.results) {
    if (!lim.has(r.date)) lim.set(r.date, new Map());
    lim.get(r.date)!.set(r.time, Number(r.covers));
  }
  const byDate = new Map<string, Booking[]>();
  for (const b of bookings.results) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date)!.push(b);
  }
  for (let d = now.date; d <= last; d = addDays(d, 1)) {
    const o = ov.get(d);
    const closed = o !== undefined ? o === 1 : s.closedWeekdays.includes(weekday(d));
    if (closed) {
      body.days[d] = "closed";
      continue;
    }
    const rules: DayRules = { closed: false, override: null, note: "", limits: lim.get(d) ?? new Map() };
    const svc = timesFor(s, d, guests, rules, byDate.get(d) ?? []);
    if (!svc.some((x) => x.times.some((t) => t.ok))) body.days[d] = "full";
  }
  return { status: 200, body };
}

/* ------------------------------------------------------ public: create booking */

const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newRef(): string {
  const r = crypto.getRandomValues(new Uint8Array(6));
  let out = "TB-";
  for (const x of r) out += REF_CHARS[x % REF_CHARS.length];
  return out;
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function createOnline(db: DB, input: Row, ipHash: string) {
  const s = await getSettings(db);
  if (str(input.company, 200) || str(input._honey, 200)) return fail(400, "rejected", "Sorry, we could not take that booking.");
  const date = input.date, time = input.time, guests = Number(input.guests);
  const first = str(input.first, 60), last = str(input.last, 60), email = str(input.email, 120), phone = str(input.phone, 30);
  const occasion = str(input.occasion, 30), notes = str(input.notes, 600);
  if (!isDate(date)) return fail(400, "bad_date", "Please choose a date.");
  if (!isTime(time) || !allTimes(s).includes(time)) return fail(400, "bad_time", "Please choose a time.");
  if (!Number.isInteger(guests) || guests < 1) return fail(400, "bad_guests", "Please choose how many guests.");
  if (guests > s.maxOnline) return fail(400, "party_size", `For more than ${s.maxOnline} guests, please call us.`);
  if (!first || !last) return fail(400, "bad_name", "Please add your first and last name.");
  if (!EMAIL_RE.test(email)) return fail(400, "bad_email", "Please check your email address.");
  if (phone.replace(/\D/g, "").length < 10) return fail(400, "bad_phone", "Please add a UK mobile number.");
  if (!s.online) return fail(409, "paused", "Online booking is paused just now. Please call us.");

  const { now, last: lastDay } = windowFor(s);
  if (date < now.date || date > lastDay) return fail(409, "out_of_range", "That date is not open for online booking.");
  const rules = await dayRules(db, s, date);
  if (rules.closed) return fail(409, "closed", "We are not taking online bookings on that day.");
  if (date === now.date && toMins(time) < now.mins + s.minNotice) return fail(409, "too_soon", "That time is too soon to book online. Please call us.");

  // Same guest, same slot, already booked: hand back the existing booking (double taps, retries).
  const dup = await db
    .prepare("SELECT ref, date, time, guests, first FROM bookings WHERE date = ?1 AND time = ?2 AND lower(email) = lower(?3) AND status IN ('booked','seated')")
    .bind(date, time, email)
    .first<Row>();
  if (dup) return { status: 200, body: { ok: true, duplicate: true, booking: dup } };

  if (ipHash) {
    const since = new Date(clock.now().getTime() - 3600_000).toISOString();
    const n = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE ip = ?1 AND created_at > ?2").bind(ipHash, since).first<{ n: number }>();
    if ((n?.n ?? 0) >= 6) return fail(429, "too_many", "Too many bookings from this connection. Please call us.");
  }

  const limit = rules.limits.get(time) ?? s.slotCovers;
  const T = toMins(time), at = stamp();
  // One statement, so the limit check and the insert cannot be split by another booking.
  const sql = `
    INSERT INTO bookings (ref, date, time, mins, duration, guests, first, last, email, phone, occasion, notes, newsletter, source, status, ip, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'online', 'booked', ?14, ?15, ?15
    WHERE (SELECT COALESCE(SUM(guests), 0) FROM bookings WHERE date = ?2 AND time = ?3 AND status IN ('booked','seated','finished')) + ?6 <= ?16
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT ?4 AS p
          UNION SELECT mins FROM bookings WHERE date = ?2 AND status IN ('booked','seated') AND mins > ?4 AND mins < ?4 + ?5
        ) AS pts
        WHERE (SELECT COALESCE(SUM(b.guests), 0) FROM bookings AS b
               WHERE b.date = ?2 AND b.status IN ('booked','seated') AND b.mins <= pts.p AND b.mins + b.duration > pts.p) + ?6 > ?17
      )`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = newRef();
    try {
      const r = await db
        .prepare(sql)
        .bind(ref, date, time, T, s.duration, guests, first, last, email, phone, occasion, notes, input.newsletter ? 1 : 0, ipHash, at, limit, s.capacity)
        .run();
      if ((r.meta.changes ?? 0) < 1) {
        const fresh = timesFor(s, date, guests, rules, await dayBookings(db, date));
        return fail(409, "full", "Sorry, that time has just been taken. Please pick another.", { services: fresh });
      }
      return { status: 200, body: { ok: true, booking: { ref, date, time, guests, first } } };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  return fail(500, "ref", "We could not save that booking. Please try again.");
}

export async function cancelOnline(db: DB, input: Row) {
  const ref = str(input.ref, 20).toUpperCase(), email = str(input.email, 120);
  if (!ref || !email) return fail(400, "bad_input", "Please give your booking reference and email.");
  const r = await db
    .prepare("UPDATE bookings SET status = 'cancelled', updated_at = ?3 WHERE ref = ?1 AND lower(email) = lower(?2) AND status = 'booked' AND date >= ?4")
    .bind(ref, email, stamp(), londonNow().date)
    .run();
  if ((r.meta.changes ?? 0) < 1) return fail(404, "not_found", "We could not find an upcoming booking with those details.");
  return { status: 200, body: { ok: true, ref } };
}

/* --------------------------------------------------------------- staff */

export async function staffDay(db: DB, date: string) {
  const s = await getSettings(db);
  const [rules, bookings] = await Promise.all([dayRules(db, s, date), dayBookings(db, date)]);
  const times = [...new Set([...allTimes(s), ...bookings.map((b) => b.time)])].sort();
  const serviceOf = (t: string) => s.services.find((x) => x.times.includes(t))?.name ?? "Other";
  const slots = times.map((t) => {
    const c = checkSlot(s, bookings, rules.limits, t, 0);
    const T = toMins(t);
    return {
      time: t,
      service: serviceOf(t),
      covers: c.covers,
      limit: c.limit,
      custom: rules.limits.has(t),
      held: heldAt(bookings, T),
      bookings: bookings.filter((b) => b.time === t && COUNTS_COVERS.has(b.status)).length,
    };
  });
  const live = bookings.filter((b) => COUNTS_COVERS.has(b.status));
  const sum = (arr: Booking[]) => arr.reduce((n, b) => n + b.guests, 0);
  return {
    ok: true,
    date,
    today: londonNow().date,
    closed: rules.closed,
    override: rules.override,
    weekdayClosed: s.closedWeekdays.includes(weekday(date)),
    note: rules.note,
    settings: s,
    slots,
    bookings,
    totals: {
      covers: sum(live),
      bookings: live.length,
      waiting: sum(bookings.filter((b) => b.status === "booked")),
      seated: sum(bookings.filter((b) => b.status === "seated")),
      finished: sum(bookings.filter((b) => b.status === "finished")),
      cancelled: bookings.filter((b) => b.status === "cancelled").length,
      noshow: bookings.filter((b) => b.status === "noshow").length,
      online: live.filter((b) => b.source === "online").length,
      peak: Math.max(0, ...slots.map((x) => x.held)),
      capacity: s.capacity,
    },
  };
}

export async function staffRange(db: DB, from: string, days: number) {
  const s = await getSettings(db);
  const to = addDays(from, days - 1);
  const [counts, overrides] = await Promise.all([
    db
      .prepare("SELECT date, COUNT(*) AS n, SUM(guests) AS covers FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status IN ('booked','seated','finished') GROUP BY date")
      .bind(from, to)
      .all<{ date: string; n: number; covers: number }>(),
    db.prepare("SELECT date, closed FROM days WHERE date BETWEEN ?1 AND ?2").bind(from, to).all<{ date: string; closed: number | null }>(),
  ]);
  const c = new Map(counts.results.map((r) => [r.date, r]));
  const o = new Map(overrides.results.filter((r) => r.closed !== null).map((r) => [r.date, Number(r.closed)]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const ov = o.get(d);
    out.push({
      date: d,
      bookings: Number(c.get(d)?.n ?? 0),
      covers: Number(c.get(d)?.covers ?? 0),
      closed: ov !== undefined ? ov === 1 : s.closedWeekdays.includes(weekday(d)),
    });
  }
  return { ok: true, days: out };
}

export async function staffPulse(db: DB, since: number) {
  const top = await db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId, COALESCE(MAX(updated_at), '') AS stamp FROM bookings").first<{ maxId: number; stamp: string }>();
  const fresh = since > 0
    ? (await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE id > ?1 AND source = 'online' ORDER BY id LIMIT 20`).bind(since).all<Booking>()).results
    : [];
  return { ok: true, maxId: Number(top?.maxId ?? 0), stamp: String(top?.stamp ?? ""), fresh };
}

export async function staffRecent(db: DB) {
  const r = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE source = 'online' ORDER BY id DESC LIMIT 30`).all<Booking>();
  return { ok: true, bookings: r.results };
}

export async function staffSearch(db: DB, q: string) {
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return { ok: true, bookings: [] };
  const like = `%${term.replace(/[%_]/g, "")}%`;
  // only treat the search as a phone number when it has no letters in it
  const digits = /[a-z]/i.test(term) ? "" : term.replace(/\D/g, "").length >= 3 ? term.replace(/\D/g, "") : "";
  const r = await db
    .prepare(
      `SELECT ${PUBLIC_COLS} FROM bookings
       WHERE first || ' ' || last LIKE ?1 OR email LIKE ?1 OR ref LIKE ?1 OR (?2 <> '' AND replace(replace(phone, ' ', ''), '+44', '0') LIKE ?3)
       ORDER BY date DESC, mins DESC LIMIT 40`,
    )
    .bind(like, digits, `%${digits.replace(/^44/, "0")}%`)
    .all<Booking>();
  return { ok: true, bookings: r.results };
}

function overMessage(c: Check) {
  return c.reason === "slot"
    ? `That slot already has ${c.covers} of ${c.limit} covers.`
    : `The restaurant would be over its ${c.capacity} seats at that time.`;
}

export async function staffCreate(db: DB, input: Row) {
  const s = await getSettings(db);
  const date = input.date, time = input.time, guests = Number(input.guests);
  const source = input.source === "walkin" ? "walkin" : "phone";
  if (!isDate(date)) return fail(400, "bad_date", "Pick a date.");
  if (!isTime(time)) return fail(400, "bad_time", "Pick a time.");
  if (!Number.isInteger(guests) || guests < 1 || guests > 200) return fail(400, "bad_guests", "Guests must be between 1 and 200.");
  const first = str(input.first, 60) || (source === "walkin" ? "Walk-in" : "");
  if (!first && !str(input.last, 60)) return fail(400, "bad_name", "Add a name.");
  // Walk-ins are already standing at the door, so staff judge the room themselves.
  if (!input.force && source !== "walkin") {
    const rules = await dayRules(db, s, date);
    const c = checkSlot(s, await dayBookings(db, date), rules.limits, time, guests);
    if (!c.ok) return fail(409, "over", overMessage(c), { check: c });
  }
  const at = stamp();
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = newRef();
    try {
      const r = await db
        .prepare(
          `INSERT INTO bookings (ref, date, time, mins, duration, guests, first, last, email, phone, occasion, notes, staff_note, table_no, newsletter, source, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?16, ?17, ?17)`,
        )
        .bind(
          ref, date, time, toMins(time), s.duration, guests, first, str(input.last, 60), str(input.email, 120), str(input.phone, 30),
          str(input.occasion, 30), str(input.notes, 600), str(input.staff_note, 600), str(input.table_no, 20), source,
          source === "walkin" ? "seated" : "booked", at,
        )
        .run();
      return { status: 200, body: { ok: true, id: r.meta.last_row_id, ref } };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  return fail(500, "ref", "Could not save. Try again.");
}

const EDITABLE = ["first", "last", "email", "phone", "occasion", "notes", "staff_note", "table_no"] as const;
const LIMITS: Record<string, number> = { first: 60, last: 60, email: 120, phone: 30, occasion: 30, notes: 600, staff_note: 600, table_no: 20 };

export async function staffUpdate(db: DB, input: Row) {
  const id = Number(input.id);
  const cur = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE id = ?1`).bind(id).first<Booking>();
  if (!cur) return fail(404, "not_found", "That booking no longer exists.");
  const next: Booking = { ...cur };
  for (const k of EDITABLE) if (typeof input[k] === "string") (next as Record<string, unknown>)[k] = str(input[k], LIMITS[k]);
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status as (typeof STATUSES)[number])) return fail(400, "bad_status", "Unknown status.");
    next.status = String(input.status);
  }
  if (input.date !== undefined) {
    if (!isDate(input.date)) return fail(400, "bad_date", "Pick a date.");
    next.date = input.date;
  }
  if (input.time !== undefined) {
    if (!isTime(input.time)) return fail(400, "bad_time", "Pick a time.");
    next.time = input.time;
    next.mins = toMins(input.time);
  }
  if (input.guests !== undefined) {
    const g = Number(input.guests);
    if (!Number.isInteger(g) || g < 1 || g > 200) return fail(400, "bad_guests", "Guests must be between 1 and 200.");
    next.guests = g;
  }
  const moved = next.date !== cur.date || next.time !== cur.time || next.guests > cur.guests;
  const revived = !COUNTS_COVERS.has(cur.status) && COUNTS_COVERS.has(next.status);
  if ((moved || revived) && HOLDS_SEATS.has(next.status) && !input.force) {
    const s = await getSettings(db);
    const rules = await dayRules(db, s, next.date);
    const c = checkSlot(s, await dayBookings(db, next.date), rules.limits, next.time, next.guests, id);
    if (!c.ok) return fail(409, "over", overMessage(c), { check: c });
  }
  await db
    .prepare(
      `UPDATE bookings SET date = ?2, time = ?3, mins = ?4, guests = ?5, first = ?6, last = ?7, email = ?8, phone = ?9, occasion = ?10,
       notes = ?11, staff_note = ?12, table_no = ?13, status = ?14, updated_at = ?15 WHERE id = ?1`,
    )
    .bind(id, next.date, next.time, next.mins, next.guests, next.first, next.last, next.email, next.phone, next.occasion, next.notes, next.staff_note, next.table_no, next.status, stamp())
    .run();
  return { status: 200, body: { ok: true } };
}

export async function staffSetDay(db: DB, input: Row) {
  if (!isDate(input.date)) return fail(400, "bad_date", "Pick a date.");
  const cur = await db.prepare("SELECT closed, note FROM days WHERE date = ?1").bind(input.date).first<{ closed: number | null; note: string }>();
  // closed: true = no online bookings, false = open even on a usual closed day, null = follow the weekly pattern
  const closed = !("closed" in input) ? cur?.closed ?? null : input.closed === null ? null : input.closed ? 1 : 0;
  const note = typeof input.note === "string" ? str(input.note, 300) : cur?.note ?? "";
  await db
    .prepare("INSERT INTO days (date, closed, note) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET closed = excluded.closed, note = excluded.note")
    .bind(input.date, closed, note)
    .run();
  return { status: 200, body: { ok: true } };
}

export async function staffSetSlot(db: DB, input: Row) {
  if (!isDate(input.date) || !isTime(input.time)) return fail(400, "bad_slot", "Pick a slot.");
  if (input.covers === null || input.covers === undefined || input.covers === "") {
    await db.prepare("DELETE FROM slot_limits WHERE date = ?1 AND time = ?2").bind(input.date, input.time).run();
  } else {
    const n = int(input.covers, 0, 500, 0);
    await db
      .prepare("INSERT INTO slot_limits (date, time, covers) VALUES (?1, ?2, ?3) ON CONFLICT(date, time) DO UPDATE SET covers = excluded.covers")
      .bind(input.date, input.time, n)
      .run();
  }
  return { status: 200, body: { ok: true } };
}
