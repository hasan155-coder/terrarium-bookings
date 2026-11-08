// Waiting list, guest history and notes, and reports for the staff dashboard.
import {
  type Booking, type DB, type Row,
  PUBLIC_COLS,
  addDays, clock, fail, isDate, londonNow, stamp, str, toMins, weekday, staffCreate,
} from "./core.server.ts";

/* ------------------------------------------------------------ guest keys */

/** UK phone as plain digits starting 0 (07700 900123, +44 7700 900123 and 447700900123 all match). */
export function normPhone(v: unknown): string {
  let d = String(v ?? "").replace(/[^\d+]/g, "");
  if (d.startsWith("+44")) d = "0" + d.slice(3);
  else if (d.startsWith("0044")) d = "0" + d.slice(4);
  else if (d.startsWith("44") && d.length === 12) d = "0" + d.slice(2);
  d = d.replace(/\D/g, "");
  return d.length >= 7 ? d : "";
}
const PHONE_SQL = "replace(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+44', '0'), '.', '')";
const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const keysOf = (b: { email?: string; phone?: string }) =>
  [b.email && normEmail(b.email) ? "e:" + normEmail(b.email) : "", normPhone(b.phone) ? "p:" + normPhone(b.phone) : ""].filter(Boolean);

/* --------------------------------------------------------- guest history */

export type History = { visits: number; noshows: number; cancels: number; last: string; note: string };
type HRow = { id: number; date: string; time: string; guests: number; status: string; e: string; p: string };

async function matchingRows(db: DB, people: { email?: string; phone?: string }[]): Promise<HRow[]> {
  const emails = [...new Set(people.map((p) => normEmail(p.email)).filter(Boolean))];
  const phones = [...new Set(people.map((p) => normPhone(p.phone)).filter(Boolean))];
  if (!emails.length && !phones.length) return [];
  const r = await db
    .prepare(
      `SELECT id, date, time, guests, status, lower(email) AS e, ${PHONE_SQL} AS p FROM bookings
       WHERE (email <> '' AND lower(email) IN (SELECT value FROM json_each(?1)))
          OR (phone <> '' AND ${PHONE_SQL} IN (SELECT value FROM json_each(?2)))
       ORDER BY date DESC, time DESC LIMIT 2000`,
    )
    .bind(JSON.stringify(emails), JSON.stringify(phones))
    .all<HRow>();
  return r.results;
}

async function notesFor(db: DB, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const r = await db.prepare("SELECT key, note FROM guests WHERE key IN (SELECT value FROM json_each(?1)) AND note <> ''").bind(JSON.stringify(keys)).all<{ key: string; note: string }>();
  return new Map(r.results.map((x) => [x.key, x.note]));
}

const same = (b: { email?: string; phone?: string }, r: HRow) => {
  const e = normEmail(b.email), p = normPhone(b.phone);
  return (!!e && r.e === e) || (!!p && r.p === p);
};

/** Adds `guest` (past visits, no-shows, cancellations and the saved guest note) to each booking. */
export async function withHistory(db: DB, bookings: Booking[]): Promise<(Booking & { guest?: History })[]> {
  const rows = await matchingRows(db, bookings);
  const notes = await notesFor(db, [...new Set(bookings.flatMap(keysOf))]);
  const today = londonNow().date;
  return bookings.map((b) => {
    const mine = rows.filter((r) => r.id !== b.id && same(b, r));
    const visits = mine.filter((r) => (r.status === "finished" || r.status === "seated") && r.date <= today);
    const note = keysOf(b).map((k) => notes.get(k)).find(Boolean) ?? "";
    if (!mine.length && !note) return b;
    return {
      ...b,
      guest: {
        visits: visits.length,
        noshows: mine.filter((r) => r.status === "noshow").length,
        cancels: mine.filter((r) => r.status === "cancelled").length,
        last: visits[0]?.date ?? "",
        note,
      },
    };
  });
}

/** Every booking for the guest behind booking `id`, newest first, plus their saved note. */
export async function staffGuest(db: DB, id: number) {
  const b = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE id = ?1`).bind(id).first<Booking>();
  if (!b) return fail(404, "not_found", "That booking no longer exists.");
  const rows = (await matchingRows(db, [b])).slice(0, 60);
  const notes = await notesFor(db, keysOf(b));
  return {
    status: 200,
    body: { ok: true, note: keysOf(b).map((k) => notes.get(k)).find(Boolean) ?? "", canNote: keysOf(b).length > 0, bookings: rows },
  };
}

/** Saves a guest note against the guest's email and phone, so it shows on every future booking. */
export async function staffGuestNote(db: DB, input: Row) {
  const b = await db.prepare(`SELECT ${PUBLIC_COLS} FROM bookings WHERE id = ?1`).bind(Number(input.id)).first<Booking>();
  if (!b) return fail(404, "not_found", "That booking no longer exists.");
  const keys = keysOf(b);
  if (!keys.length) return fail(400, "no_contact", "Add an email or phone number to this booking first, so the note can follow the guest.");
  const note = str(input.note, 400);
  for (const k of keys)
    await db
      .prepare("INSERT INTO guests (key, note, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at")
      .bind(k, note, stamp())
      .run();
  await db.prepare("UPDATE bookings SET updated_at = ?2 WHERE id = ?1").bind(b.id, stamp()).run();
  return { status: 200, body: { ok: true, note } };
}

/* -------------------------------------------------------------- waitlist */

export type Wait = {
  id: number; date: string; name: string; phone: string; guests: number; quote: number; notes: string;
  status: string; booking_id: number | null; created_at: string; updated_at: string;
};
const WAIT_COLS = "id, date, name, phone, guests, quote, notes, status, booking_id, created_at, updated_at";

export async function dayWaitlist(db: DB, date: string): Promise<Wait[]> {
  const r = await db.prepare(`SELECT ${WAIT_COLS} FROM waitlist WHERE date = ?1 ORDER BY id`).bind(date).all<Wait>();
  return r.results;
}

export async function staffWaitAdd(db: DB, input: Row) {
  const guests = Number(input.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > 50) return fail(400, "bad_guests", "Guests must be between 1 and 50.");
  const name = str(input.name, 60);
  if (!name) return fail(400, "bad_name", "Add a name to call out.");
  const quote = Math.max(0, Math.min(240, Math.round(Number(input.quote) || 0)));
  const at = stamp();
  const r = await db
    .prepare(`INSERT INTO waitlist (date, name, phone, guests, quote, notes, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'waiting', ?7, ?7)`)
    .bind(londonNow().date, name, str(input.phone, 30), guests, quote, str(input.notes, 300), at)
    .run();
  return { status: 200, body: { ok: true, id: r.meta.last_row_id } };
}

/** Seat a waiting party (as a walk-in booking, with a table when one is free) or mark them as gone. */
export async function staffWaitUpdate(db: DB, input: Row) {
  const w = await db.prepare(`SELECT ${WAIT_COLS} FROM waitlist WHERE id = ?1`).bind(Number(input.id)).first<Wait>();
  if (!w) return fail(404, "not_found", "That party is no longer on the list.");
  const status = String(input.status ?? "");
  if (status === "seated") {
    if (w.status === "seated") return { status: 200, body: { ok: true, booking_id: w.booking_id } };
    const now = londonNow();
    const time = `${String(Math.floor(now.mins / 60)).padStart(2, "0")}:${String(now.mins % 60).padStart(2, "0")}`;
    const [first, ...rest] = w.name.split(" ");
    const made = await staffCreate(db, {
      date: now.date, time, guests: w.guests, first, last: rest.join(" "), phone: w.phone, notes: w.notes,
      source: "walkin", table_no: typeof input.table_no === "string" && input.table_no ? input.table_no : "auto",
      staff_note: `From the waiting list (waited ${Math.max(0, Math.round((clock.now().getTime() - new Date(w.created_at).getTime()) / 60000))} min)`,
    });
    if (!(made.body as Row).ok) return made;
    const bid = Number((made.body as Row).id);
    await db.prepare("UPDATE waitlist SET status = 'seated', booking_id = ?2, updated_at = ?3 WHERE id = ?1").bind(w.id, bid, stamp()).run();
    return { status: 200, body: { ok: true, booking_id: bid, table: (made.body as Row).table ?? "" } };
  }
  if (status === "left" || status === "waiting") {
    await db.prepare("UPDATE waitlist SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(w.id, status, stamp()).run();
    return { status: 200, body: { ok: true } };
  }
  if (input.quote !== undefined) {
    const q = Math.max(0, Math.min(240, Math.round(Number(input.quote) || 0)));
    await db.prepare("UPDATE waitlist SET quote = ?2, updated_at = ?3 WHERE id = ?1").bind(w.id, q, stamp()).run();
    return { status: 200, body: { ok: true } };
  }
  return fail(400, "bad_status", "Choose seat or remove.");
}

/* --------------------------------------------------------------- reports */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Figures for a date range: covers, sources, no-shows, busiest days and times, party sizes, waiting list. */
export async function staffReport(db: DB, fromIn: unknown, toIn: unknown) {
  const today = londonNow().date;
  const from = isDate(fromIn) ? fromIn : addDays(today, -29);
  let to = isDate(toIn) ? toIn : today;
  if (to < from) to = from;
  if (addDays(from, 366) < to) to = addDays(from, 366);
  const [days, sources, times, sizes, waits] = await Promise.all([
    db
      .prepare(
        `SELECT date,
           SUM(CASE WHEN status IN ('booked','late','seated','finished') THEN 1 ELSE 0 END) AS bookings,
           SUM(CASE WHEN status IN ('booked','late','seated','finished') THEN guests ELSE 0 END) AS covers,
           SUM(CASE WHEN status IN ('seated','finished') THEN guests ELSE 0 END) AS served,
           SUM(CASE WHEN status = 'noshow' THEN 1 ELSE 0 END) AS noshows,
           SUM(CASE WHEN status = 'noshow' THEN guests ELSE 0 END) AS noshowCovers,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancels,
           SUM(CASE WHEN status IN ('seated','finished') THEN 1 ELSE 0 END) AS arrived
         FROM bookings WHERE date BETWEEN ?1 AND ?2 GROUP BY date ORDER BY date`,
      )
      .bind(from, to)
      .all<Row>(),
    db
      .prepare(`SELECT source, COUNT(*) AS bookings, SUM(guests) AS covers FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status IN ('booked','late','seated','finished') GROUP BY source`)
      .bind(from, to)
      .all<Row>(),
    db
      .prepare(`SELECT time, SUM(guests) AS covers, COUNT(*) AS bookings FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status IN ('booked','late','seated','finished') GROUP BY time ORDER BY time`)
      .bind(from, to)
      .all<Row>(),
    db
      .prepare(`SELECT guests, COUNT(*) AS bookings FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status IN ('booked','late','seated','finished') GROUP BY guests ORDER BY guests`)
      .bind(from, to)
      .all<Row>(),
    db.prepare("SELECT status, COUNT(*) AS n FROM waitlist WHERE date BETWEEN ?1 AND ?2 GROUP BY status").bind(from, to).all<Row>(),
  ]);
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const daily: { date: string; covers: number; bookings: number }[] = [];
  const byDate = new Map(days.results.map((r) => [String(r.date), r]));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDate.get(d);
    daily.push({ date: d, covers: num(r?.covers), bookings: num(r?.bookings) });
  }
  const weekdays = DOW.map((name, i) => {
    const ds = daily.filter((d) => weekday(d.date) === i);
    const open = ds.filter((d) => d.covers > 0);
    return { name, covers: ds.reduce((n, d) => n + d.covers, 0), average: open.length ? Math.round(open.reduce((n, d) => n + d.covers, 0) / open.length) : 0 };
  });
  const sum = (k: string) => days.results.reduce((n, r) => n + num(r[k]), 0);
  // No-shows only count from days that have happened.
  const past = days.results.filter((r) => String(r.date) <= today);
  const pastSum = (k: string) => past.reduce((n, r) => n + num(r[k]), 0);
  const expected = pastSum("arrived") + pastSum("noshows");
  const bookings = sum("bookings"), covers = sum("covers");
  const hours = new Map<number, number>();
  for (const t of times.results) {
    const h = Math.floor(toMins(String(t.time)) / 60);
    hours.set(h, (hours.get(h) ?? 0) + num(t.covers));
  }
  const waitBy = new Map(waits.results.map((r) => [String(r.status), num(r.n)]));
  return {
    ok: true,
    from,
    to,
    totals: {
      bookings,
      covers,
      served: sum("served"),
      average: bookings ? Math.round((covers / bookings) * 10) / 10 : 0,
      noshows: pastSum("noshows"),
      noshowCovers: pastSum("noshowCovers"),
      noshowRate: expected ? Math.round((pastSum("noshows") / expected) * 1000) / 10 : 0,
      cancels: sum("cancels"),
    },
    daily,
    weekdays,
    hours: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, covers]) => ({ hour, covers })),
    sources: ["online", "phone", "walkin"].map((k) => {
      const r = sources.results.find((x) => x.source === k);
      return { source: k, bookings: num(r?.bookings), covers: num(r?.covers) };
    }),
    sizes: sizes.results.map((r) => ({ guests: num(r.guests), bookings: num(r.bookings) })),
    waitlist: { added: [...waitBy.values()].reduce((a, b) => a + b, 0), seated: waitBy.get("seated") ?? 0, left: waitBy.get("left") ?? 0 },
  };
}

