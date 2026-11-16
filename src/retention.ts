// Automatic clean-up of personal data, so the booking system keeps details only as long as the privacy policy says
// (www.terrariumbistro.co.uk/privacy.html, section 08). Runs once a day from the hourly cron.
//
//   Bookings ........ names, contact details, requests and notes cleared 2 years after the booking date
//                     (date, time, party size and status stay, so the numbers still add up)
//   Guest notes ..... deleted once the guest has had no booking for 2 years
//   Waiting list .... deleted after 30 days
//   Scrambled IP .... cleared from bookings after 30 days
//   Reminder log .... deleted after 2 years
//   Vouchers ........ names, emails, messages and staff notes cleared 6 years after purchase (tax records keep the amounts)
//
// Staff sign-ins and failed sign-in attempts are already pruned by auth.server.ts.
import { clock, type DB } from "./booking/core.server.ts";
import { keysOf } from "./booking/extras.server.ts";

export const KEEP = { bookingDays: 730, waitlistDays: 30, ipDays: 30, voucherYears: 6 } as const;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => new Date(now.getTime() - n * 86400000);

export type Tidy = { bookings: number; ips: number; guests: number; waitlist: number; reminders: number; vouchers: number; voucherUses: number };

export async function tidyPersonalData(db: DB, now: Date = clock.now()): Promise<Tidy> {
  const bookingCut = ymd(daysAgo(now, KEEP.bookingDays));          // YYYY-MM-DD, compared with the booking date
  const bookingCutIso = daysAgo(now, KEEP.bookingDays).toISOString();
  const ipCutIso = daysAgo(now, KEEP.ipDays).toISOString();
  const waitCut = ymd(daysAgo(now, KEEP.waitlistDays));
  const vCut = new Date(now); vCut.setUTCFullYear(vCut.getUTCFullYear() - KEEP.voucherYears);
  const voucherCutIso = vCut.toISOString();

  const changed = (r: { meta?: { changes?: number } }) => r.meta?.changes ?? 0;

  const bookings = changed(await db
    .prepare(`UPDATE bookings SET first = 'Guest', last = '', email = '', phone = '', notes = '', staff_note = '', newsletter = 0, ip = '', updated_at = ?2
              WHERE date < ?1 AND (first <> 'Guest' OR last <> '' OR email <> '' OR phone <> '' OR notes <> '' OR staff_note <> '' OR ip <> '')`)
    .bind(bookingCut, now.toISOString()).run());

  const ips = changed(await db
    .prepare("UPDATE bookings SET ip = '' WHERE ip <> '' AND created_at < ?1")
    .bind(ipCutIso).run());

  // Guest notes follow a guest by email or phone: keep them while the guest has booked within the last 2 years.
  const stale = await db
    .prepare("SELECT key FROM guests WHERE updated_at < ?1")
    .bind(bookingCutIso).all<{ key: string }>();
  let guests = 0;
  if (stale.results?.length) {
    const recent = await db
      .prepare("SELECT email, phone FROM bookings WHERE date >= ?1 AND (email <> '' OR phone <> '')")
      .bind(bookingCut).all<{ email: string; phone: string }>();
    const live = new Set((recent.results ?? []).flatMap((b) => keysOf(b)));
    for (const g of stale.results) {
      if (live.has(g.key)) continue;
      guests += changed(await db.prepare("DELETE FROM guests WHERE key = ?1 AND updated_at < ?2").bind(g.key, bookingCutIso).run());
    }
  }

  const waitlist = changed(await db.prepare("DELETE FROM waitlist WHERE date < ?1").bind(waitCut).run());
  const reminders = changed(await db.prepare("DELETE FROM reminders WHERE sent_at < ?1").bind(bookingCutIso).run());

  const vouchers = changed(await db
    .prepare(`UPDATE vouchers SET to_name = '', from_name = '', message = '', buyer_email = '', recipient_email = '', note = '', updated_at = ?2
              WHERE created_at < ?1 AND (to_name <> '' OR from_name <> '' OR message <> '' OR buyer_email <> '' OR recipient_email <> '' OR note <> '')`)
    .bind(voucherCutIso, now.toISOString()).run());
  const voucherUses = changed(await db
    .prepare("UPDATE voucher_uses SET note = '' WHERE note <> '' AND created_at < ?1")
    .bind(voucherCutIso).run());

  return { bookings, ips, guests, waitlist, reminders, vouchers, voucherUses };
}

/** True once a day (03:00 UTC), so the hourly cron runs the clean-up daily. */
export const tidyDue = (now: Date = clock.now()) => now.getUTCHours() === 3;
