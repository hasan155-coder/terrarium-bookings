// Booking emails, sent by the booking server through Resend:
//  - a confirmation to the guest (from the restaurant's own domain, with a calendar invite)
//  - a copy to the restaurant inbox
//  - a reminder to the guest the day before, with a one-tap cancel link
//  - an alert to the restaurant when a guest cancels online
export type MailEnv = {
  RESEND_API_KEY?: string;
  RESEND_API_URL?: string;
  MAIL_FROM?: string;
  RESTAURANT_EMAIL?: string;
  PUBLIC_SITE?: string;
  STAFF_URL?: string;
};
export type Booked = {
  ref: string;
  date: string;
  time: string;
  guests: number;
  first: string;
  last: string;
  email: string;
  phone: string;
  occasion: string;
  notes: string;
  newsletter: boolean;
};

const PLACE = {
  name: "Terrarium Bistro",
  address: "44 High St, Tarporley CW6 0DX",
  phone: "01829 863469",
  phoneIntl: "+441829863469",
  maps: "https://www.google.com/maps/search/?api=1&query=Terrarium%20Bistro%2C%2044%20High%20St%2C%20Tarporley%20CW6%200DX",
};

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

export function longDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function shortDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** A UK wall-clock date and time as the real instant (handles GMT and BST). */
export function londonToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const shown = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (shown - guess));
}
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");

export function calendarFile(b: Booked, now = new Date()) {
  const start = londonToUtc(b.date, b.time), end = new Date(start.getTime() + 2 * 3600_000);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Terrarium Bistro//Bookings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${b.ref}@terrariumbistro.co.uk`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText("Table at Terrarium Bistro")}`,
    `LOCATION:${icsText(`${PLACE.name}, ${PLACE.address}`)}`,
    `DESCRIPTION:${icsText(`Table for ${b.guests}. Reference ${b.ref}. To change your booking call ${PLACE.phone}.`)}`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

function googleCalendarLink(b: Booked) {
  const d = b.date.replace(/-/g, ""), [h, m] = b.time.split(":").map(Number);
  const st = `${d}T${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}00`;
  const en = `${d}T${String(h + 2).padStart(2, "0")}${String(m).padStart(2, "0")}00`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("Table at Terrarium Bistro")}&dates=${st}/${en}&ctz=Europe/London&details=${encodeURIComponent(`Table for ${b.guests}. Reference ${b.ref}. To change your booking call ${PLACE.phone}.`)}&location=${encodeURIComponent(`${PLACE.name}, ${PLACE.address}`)}`;
}

const SERIF = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
const SANS = "Helvetica,Arial,sans-serif";

function row(label: string, value: string, gold = false) {
  return `<tr><td style="padding:10px 0;border-top:1px solid #35312a;font:600 11px/1.4 ${SANS};letter-spacing:2px;text-transform:uppercase;color:#8e8573;width:120px;vertical-align:top">${label}</td>
<td style="padding:10px 0;border-top:1px solid #35312a;font:${gold ? "600 17px" : "15px"}/1.5 ${SANS};color:${gold ? "#ecd49c" : "#efe6d4"};${gold ? "letter-spacing:2px;" : ""}">${value}</td></tr>`;
}

export type DepositNote = { pence: number; hours: number };
export const money = (pence: number) => `£${(pence / 100).toFixed(pence % 100 ? 2 : 0)}`;
export const depositRule = (hours: number) =>
  hours > 0
    ? `It comes off your bill on the night. If you cancel at least ${hours} hours before, we refund it in full; later cancellations and no-shows keep the deposit.`
    : `It comes off your bill on the night.`;

export function guestEmail(b: Booked, site = "", cancelUrl = "", deposit?: DepositNote) {
  const rows = [
    row("Date", esc(longDate(b.date))),
    row("Time", esc(b.time)),
    row("Guests", String(b.guests)),
    row("Name", esc(`${b.first} ${b.last}`)),
    b.occasion && b.occasion !== "None" ? row("Occasion", esc(b.occasion)) : "",
    b.notes ? row("Your notes", esc(b.notes)) : "",
    deposit ? row("Deposit paid", esc(money(deposit.pence))) : "",
    row("Reference", esc(b.ref), true),
  ].join("");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Your table is confirmed</title></head>
<body style="margin:0;padding:0;background:#181713">
<div style="display:none;max-height:0;overflow:hidden;color:#181713">${esc(`Table for ${b.guests} on ${longDate(b.date)} at ${b.time}. Reference ${b.ref}.`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#181713"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1d19;border:1px solid #4a3f2c;border-radius:6px">
<tr><td style="padding:36px 36px 8px">
<p style="margin:0 0 28px;font:600 11px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#c9a66b">Terrarium Bistro &middot; Tarporley</p>
<h1 style="margin:0;font:400 40px/1.08 ${SERIF};color:#efe6d4">Your table is <i style="color:#c9a66b">confirmed.</i></h1>
<p style="margin:18px 0 26px;font:15px/1.6 ${SANS};color:#c8bea9">Thank you, ${esc(b.first)}. We have your table ready and look forward to welcoming you.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
</td></tr>
<tr><td style="padding:22px 36px 6px">
<a href="${esc(googleCalendarLink(b))}" style="display:inline-block;margin:0 8px 10px 0;padding:14px 22px;background:#c9a66b;color:#181713;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">Add to Google Calendar</a>
<a href="${esc(PLACE.maps)}" style="display:inline-block;margin:0 0 10px;padding:13px 21px;border:1px solid #c9a66b;color:#ecd49c;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">Get directions</a>
<p style="margin:8px 0 0;font:13px/1.6 ${SANS};color:#8e8573">On an iPhone or Outlook, open the attached invite to add it to your calendar.</p>
</td></tr>
<tr><td style="padding:22px 36px 34px">
${deposit ? `<p style="margin:0 0 14px;font:14px/1.6 ${SANS};color:#c8bea9">Thank you for your ${esc(money(deposit.pence))} deposit. ${esc(depositRule(deposit.hours))}</p>` : ""}<p style="margin:0;padding-top:20px;border-top:1px solid #35312a;font:14px/1.6 ${SANS};color:#c8bea9">Need to change or cancel? Call us on <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a> or simply reply to this email.${cancelUrl ? ` Can't make it at all? <a href="${esc(cancelUrl)}" style="color:#ecd49c">Cancel your table online</a>.` : ""}</p>
</td></tr>
</table>
<p style="margin:22px 0 0;font:12px/1.7 ${SANS};color:#8e8573">${PLACE.name} &middot; ${PLACE.address} &middot; <a href="tel:${PLACE.phoneIntl}" style="color:#8e8573">${PLACE.phone}</a>${site ? ` &middot; <a href="${esc(site)}" style="color:#8e8573">Website</a>` : ""}</p>
</td></tr></table></body></html>`;
  const text = [
    `Your table at Terrarium Bistro is confirmed.`, ``,
    `Thank you, ${b.first}.`, ``,
    `Date: ${longDate(b.date)}`, `Time: ${b.time}`, `Guests: ${b.guests}`, `Name: ${b.first} ${b.last}`,
    ...(b.occasion && b.occasion !== "None" ? [`Occasion: ${b.occasion}`] : []),
    ...(b.notes ? [`Your notes: ${b.notes}`] : []),
    ...(deposit ? [`Deposit paid: ${money(deposit.pence)}. ${depositRule(deposit.hours)}`] : []),
    `Reference: ${b.ref}`, ``,
    `Add to Google Calendar: ${googleCalendarLink(b)}`,
    `Directions: ${PLACE.maps}`, ``,
    `Need to change or cancel? Call ${PLACE.phone} or reply to this email.`,
    ...(cancelUrl ? [`Can't make it? Cancel online: ${cancelUrl}`] : []),
    `${PLACE.name}, ${PLACE.address}`,
  ].join("\n");
  return { subject: `Your table is confirmed: ${shortDate(b.date)} at ${b.time}`, html, text };
}

export function reminderEmail(b: Booked, cancelUrl = "", site = "") {
  const rows = [
    row("Date", esc(longDate(b.date))),
    row("Time", esc(b.time)),
    row("Guests", String(b.guests)),
    row("Reference", esc(b.ref), true),
  ].join("");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>See you tomorrow</title></head>
<body style="margin:0;padding:0;background:#181713">
<div style="display:none;max-height:0;overflow:hidden;color:#181713">${esc(`Your table for ${b.guests} is tomorrow at ${b.time}. Reference ${b.ref}.`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#181713"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1d19;border:1px solid #4a3f2c;border-radius:6px">
<tr><td style="padding:36px 36px 8px">
<p style="margin:0 0 28px;font:600 11px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#c9a66b">Terrarium Bistro &middot; Tarporley</p>
<h1 style="margin:0;font:400 40px/1.08 ${SERIF};color:#efe6d4">See you <i style="color:#c9a66b">tomorrow.</i></h1>
<p style="margin:18px 0 26px;font:15px/1.6 ${SANS};color:#c8bea9">A quick reminder of your table, ${esc(b.first)}. We are looking forward to looking after you.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
</td></tr>
<tr><td style="padding:22px 36px 6px">
<a href="${esc(PLACE.maps)}" style="display:inline-block;margin:0 8px 10px 0;padding:14px 22px;background:#c9a66b;color:#181713;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">Get directions</a>
${cancelUrl ? `<a href="${esc(cancelUrl)}" style="display:inline-block;margin:0 0 10px;padding:13px 21px;border:1px solid #c9a66b;color:#ecd49c;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">Can't make it? Cancel</a>` : ""}
</td></tr>
<tr><td style="padding:22px 36px 34px">
<p style="margin:0;padding-top:20px;border-top:1px solid #35312a;font:14px/1.6 ${SANS};color:#c8bea9">Running late or need a different time? Call us on <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a> and we will do our best to help. Cancelling frees your table for another guest, so we are grateful when you let us know.</p>
</td></tr>
</table>
<p style="margin:22px 0 0;font:12px/1.7 ${SANS};color:#8e8573">${PLACE.name} &middot; ${PLACE.address} &middot; <a href="tel:${PLACE.phoneIntl}" style="color:#8e8573">${PLACE.phone}</a>${site ? ` &middot; <a href="${esc(site)}" style="color:#8e8573">Website</a>` : ""}</p>
</td></tr></table></body></html>`;
  const text = [
    `See you tomorrow at Terrarium Bistro.`, ``,
    `A quick reminder of your table, ${b.first}.`, ``,
    `Date: ${longDate(b.date)}`, `Time: ${b.time}`, `Guests: ${b.guests}`, `Reference: ${b.ref}`, ``,
    `Directions: ${PLACE.maps}`,
    ...(cancelUrl ? [`Can't make it? Cancel here: ${cancelUrl}`] : []),
    `Running late or need a different time? Call ${PLACE.phone}.`,
    `${PLACE.name}, ${PLACE.address}`,
  ].join("\n");
  return { subject: `See you tomorrow at ${b.time}: your table at Terrarium Bistro`, html, text };
}

export function restaurantCancelledEmail(b: Booked, staffUrl = "", depositLine = "") {
  const who = `${b.first} ${b.last}`.trim() || "A guest";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"></head><body style="margin:0;background:#181713">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#181713"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1d19;border:1px solid #4a3f2c;border-radius:6px"><tr><td style="padding:28px 30px">
<p style="margin:0 0 10px;font:600 11px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#e6a093">Cancelled online by the guest</p>
<h1 style="margin:0 0 18px;font:400 30px/1.15 ${SERIF};color:#efe6d4">${esc(who)}, ${b.guests} ${b.guests === 1 ? "guest" : "guests"}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row("When", esc(`${longDate(b.date)} at ${b.time}`))}${row("Phone", esc(b.phone || "None"))}${row("Reference", esc(b.ref), true)}</table>
${staffUrl ? `<p style="margin:22px 0 0"><a href="${esc(staffUrl)}" style="display:inline-block;padding:13px 20px;background:#c9a66b;color:#181713;border-radius:2px;font:600 13px/1 ${SANS};text-decoration:none">Open the bookings tablet</a></p>` : ""}
${depositLine ? `<p style="margin:18px 0 0;padding:12px 14px;border:1px solid #a0574a;border-radius:3px;font:14px/1.6 ${SANS};color:#fbe1db">${esc(depositLine)}</p>` : ""}
<p style="margin:18px 0 0;font:12px/1.6 ${SANS};color:#8e8573">The table is free again and the website is offering the time to other guests.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Cancelled online by the guest\n\n${who}, ${b.guests} guests\n${longDate(b.date)} at ${b.time}\nPhone: ${b.phone || "None"}\nReference: ${b.ref}\n${depositLine ? `\n${depositLine}\n` : ""}${staffUrl ? `\nTablet: ${staffUrl}\n` : ""}`;
  return { subject: `Cancelled online: ${who}, ${b.guests} ${b.guests === 1 ? "guest" : "guests"}, ${shortDate(b.date)} at ${b.time} (${b.ref})`, html, text };
}

export function restaurantEmail(b: Booked, staffUrl = "", deposit?: DepositNote) {
  const rows = [
    row("When", esc(`${longDate(b.date)} at ${b.time}`)),
    row("Guests", String(b.guests)),
    row("Name", esc(`${b.first} ${b.last}`)),
    row("Phone", `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ""))}" style="color:#ecd49c">${esc(b.phone)}</a>`),
    row("Email", `<a href="mailto:${esc(b.email)}" style="color:#ecd49c">${esc(b.email)}</a>`),
    row("Occasion", esc(b.occasion || "None")),
    row("Notes", esc(b.notes || "None")),
    row("Newsletter", b.newsletter ? "Yes, opted in" : "No"),
    deposit ? row("Deposit", esc(`${money(deposit.pence)} paid by card`)) : "",
    row("Reference", esc(b.ref), true),
  ].join("");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"></head><body style="margin:0;background:#181713">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#181713"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1d19;border:1px solid #4a3f2c;border-radius:6px"><tr><td style="padding:28px 30px">
<p style="margin:0 0 10px;font:600 11px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#c9a66b">New online booking &middot; confirmed</p>
<h1 style="margin:0 0 18px;font:400 30px/1.15 ${SERIF};color:#efe6d4">${esc(b.first)} ${esc(b.last)}, ${b.guests} ${b.guests === 1 ? "guest" : "guests"}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
${staffUrl ? `<p style="margin:22px 0 0"><a href="${esc(staffUrl)}" style="display:inline-block;padding:13px 20px;background:#c9a66b;color:#181713;border-radius:2px;font:600 13px/1 ${SANS};text-decoration:none">Open the bookings tablet</a></p>` : ""}
<p style="margin:18px 0 0;font:12px/1.6 ${SANS};color:#8e8573">Already in the staff book. Reply to this email to write to the guest.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `New online booking (confirmed)\n\n${longDate(b.date)} at ${b.time}\n${b.guests} guests\n${b.first} ${b.last}\nPhone: ${b.phone}\nEmail: ${b.email}\nOccasion: ${b.occasion || "None"}\nNotes: ${b.notes || "None"}\nNewsletter: ${b.newsletter ? "Yes" : "No"}\nReference: ${b.ref}\n${staffUrl ? `\nTablet: ${staffUrl}\n` : ""}`;
  return { subject: `New booking: ${b.first} ${b.last}, ${b.guests} ${b.guests === 1 ? "guest" : "guests"}, ${shortDate(b.date)} at ${b.time} (${b.ref})`, html, text };
}

const toBase64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
};

/** Sends one email through Resend. Resolves true when Resend accepted it. */
export async function sendEmail(env: MailEnv, payload: Record<string, unknown>): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const url = env.RESEND_API_URL || "https://api.resend.com/emails";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || "Terrarium Bistro <bookings@terrariumbistro.co.uk>", ...payload }),
      signal: ctl.signal,
    });
    if (!res.ok) console.error("email", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("email", e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the guest confirmation (and a restaurant copy). Resolves true when the guest email was accepted. */
export async function sendBookingEmails(env: MailEnv, raw: Record<string, unknown>, ref: string, cancelUrl = "", deposit?: DepositNote): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const b: Booked = {
    ref,
    date: clip(raw.date, 10),
    time: clip(raw.time, 5),
    guests: Number(raw.guests) || 0,
    first: clip(raw.first, 60),
    last: clip(raw.last, 60),
    email: clip(raw.email, 120),
    phone: clip(raw.phone, 30),
    occasion: clip(raw.occasion, 30),
    notes: clip(raw.notes, 600),
    newsletter: !!raw.newsletter,
  };
  const send = (payload: Record<string, unknown>) => sendEmail(env, payload);
  const g = guestEmail(b, env.PUBLIC_SITE, cancelUrl, deposit);
  const jobs: Promise<boolean>[] = [
    send({
      to: [b.email], subject: g.subject, html: g.html, text: g.text,
      reply_to: env.RESTAURANT_EMAIL || undefined,
      attachments: [{ filename: "terrarium-booking.ics", content: toBase64(calendarFile(b)), content_type: "text/calendar" }],
      headers: { "X-Entity-Ref-ID": b.ref },
    }),
  ];
  if (env.RESTAURANT_EMAIL) {
    const r = restaurantEmail(b, env.STAFF_URL, deposit);
    jobs.push(send({ to: [env.RESTAURANT_EMAIL], subject: r.subject, html: r.html, text: r.text, reply_to: b.email }));
  }
  const [guestOk] = await Promise.all(jobs);
  return guestOk;
}

/* ------------------------------------------------------- vouchers and deposits */

type Btn = { href: string; label: string; solid?: boolean };
function shell(o: { kicker: string; title: string; pre: string; intro: string; block?: string; rows?: string; buttons?: Btn[]; after?: string; site?: string }) {
  const btns = (o.buttons ?? [])
    .map((b) => b.solid
      ? `<a href="${esc(b.href)}" style="display:inline-block;margin:0 8px 10px 0;padding:14px 22px;background:#c9a66b;color:#181713;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">${esc(b.label)}</a>`
      : `<a href="${esc(b.href)}" style="display:inline-block;margin:0 8px 10px 0;padding:13px 21px;border:1px solid #c9a66b;color:#ecd49c;border-radius:2px;font:600 13px/1 ${SANS};letter-spacing:1px;text-decoration:none">${esc(b.label)}</a>`)
    .join("");
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(o.title.replace(/<[^>]+>/g, ""))}</title></head>
<body style="margin:0;padding:0;background:#181713">
<div style="display:none;max-height:0;overflow:hidden;color:#181713">${esc(o.pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#181713"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1d19;border:1px solid #4a3f2c;border-radius:6px">
<tr><td style="padding:36px 36px 8px">
<p style="margin:0 0 28px;font:600 11px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#c9a66b">${esc(o.kicker)}</p>
<h1 style="margin:0;font:400 38px/1.1 ${SERIF};color:#efe6d4">${o.title}</h1>
<p style="margin:18px 0 26px;font:15px/1.6 ${SANS};color:#c8bea9">${o.intro}</p>
${o.block ?? ""}
${o.rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${o.rows}</table>` : ""}
</td></tr>
${btns ? `<tr><td style="padding:22px 36px 6px">${btns}</td></tr>` : ""}
<tr><td style="padding:16px 36px 34px">${o.after ? `<p style="margin:0;padding-top:20px;border-top:1px solid #35312a;font:14px/1.6 ${SANS};color:#c8bea9">${o.after}</p>` : ""}</td></tr>
</table>
<p style="margin:22px 0 0;font:12px/1.7 ${SANS};color:#8e8573">${PLACE.name} &middot; ${PLACE.address} &middot; <a href="tel:${PLACE.phoneIntl}" style="color:#8e8573">${PLACE.phone}</a>${o.site ? ` &middot; <a href="${esc(o.site)}" style="color:#8e8573">Website</a>` : ""}</p>
</td></tr></table></body></html>`;
}

export type VoucherMail = {
  serial: string; amount: number; to_name: string; from_name: string; message: string;
  expires_on: string; send_on: string; recipient_email: string; buyer_email: string; deliver: string; source: string; paid_by: string;
};

/** The voucher itself, drawn in the email as a gold-edged card. */
function voucherBlock(v: VoucherMail) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;background:#14120f;border:1px solid #c9a66b;border-radius:8px"><tr><td style="padding:26px 26px 22px">
<p style="margin:0 0 6px;font:600 10px/1 ${SANS};letter-spacing:4px;text-transform:uppercase;color:#c9a66b">Gift voucher &middot; Terrarium Bistro</p>
<p style="margin:0 0 16px;font:italic 400 54px/1 ${SERIF};color:#ecd49c">${esc(money(v.amount))}</p>
<p style="margin:0;font:13px/1.6 ${SANS};color:#c8bea9">For <b style="color:#efe6d4;font-weight:600">${esc(v.to_name || "you")}</b>${v.from_name ? ` &middot; from <b style="color:#efe6d4;font-weight:600">${esc(v.from_name)}</b>` : ""}</p>
${v.message ? `<p style="margin:12px 0 0;font:italic 400 20px/1.35 ${SERIF};color:#efe6d4">&ldquo;${esc(v.message)}&rdquo;</p>` : ""}
<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #35312a;font:600 15px/1.4 ${SANS};letter-spacing:3px;color:#ecd49c">N&ordm; ${esc(v.serial)}</p>
<p style="margin:4px 0 0;font:600 10px/1.4 ${SANS};letter-spacing:2px;text-transform:uppercase;color:#8e8573">Valid until ${esc(longDate(v.expires_on))}</p>
</td></tr></table>`;
}

/** The voucher, sent to whoever it is for (the recipient, or the buyer to hand over themselves). */
export function voucherEmail(v: VoucherMail, viewUrl: string, site = "", toBuyer = false) {
  const book = site ? `${site.replace(/#.*$/, "")}#book` : "";
  const title = toBuyer ? `Your gift for <i style="color:#c9a66b">${esc(v.to_name)}.</i>` : `A gift for <i style="color:#c9a66b">you.</i>`;
  const intro = toBuyer
    ? `Here is the Terrarium Bistro voucher for ${esc(v.to_name)}. Print it, forward this email or open it on your phone to give it in person.`
    : `${esc(v.from_name || "Someone")} has sent you an evening at Terrarium Bistro in Tarporley. Quote the voucher number when you book or when you pay.`;
  const html = shell({
    kicker: "Terrarium Bistro · Gift voucher", title, intro, site,
    pre: `${money(v.amount)} Terrarium Bistro gift voucher, number ${v.serial}, valid until ${longDate(v.expires_on)}.`,
    block: voucherBlock(v),
    buttons: [{ href: viewUrl, label: "View and print the voucher", solid: true }, ...(book ? [{ href: book, label: "Book a table" }] : [])],
    after: `Use it against food and drink at Terrarium Bistro, in one visit or several, until ${esc(longDate(v.expires_on))}. It cannot be exchanged for cash. Questions? Call <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a>.`,
  });
  const text = [
    toBuyer ? `Your Terrarium Bistro gift voucher for ${v.to_name}` : `${v.from_name || "Someone"} has sent you a Terrarium Bistro gift voucher.`, ``,
    `Value: ${money(v.amount)}`, `For: ${v.to_name}`, ...(v.from_name ? [`From: ${v.from_name}`] : []),
    ...(v.message ? [`Message: "${v.message}"`] : []),
    `Voucher number: ${v.serial}`, `Valid until: ${longDate(v.expires_on)}`, ``,
    `View and print: ${viewUrl}`, ...(book ? [`Book a table: ${book}`] : []), ``,
    `Quote the voucher number when you book or pay. It cannot be exchanged for cash.`,
    `${PLACE.name}, ${PLACE.address}, ${PLACE.phone}`,
  ].join("\n");
  const subject = toBuyer ? `Your Terrarium Bistro gift voucher for ${v.to_name} (${money(v.amount)})` : `A gift from ${v.from_name || "a friend"}: an evening at Terrarium Bistro`;
  return { subject, html, text };
}

/** Receipt to the buyer when the voucher itself goes to someone else. */
export function voucherReceiptEmail(v: VoucherMail, viewUrl: string, site = "", sentNow = true) {
  const when = sentNow ? `We have emailed it to ${esc(v.recipient_email)}.` : `We will email it to ${esc(v.recipient_email)} on ${esc(longDate(v.send_on))}.`;
  const html = shell({
    kicker: "Terrarium Bistro · Receipt", site,
    title: `Thank you, <i style="color:#c9a66b">${esc(v.from_name)}.</i>`,
    intro: `Your ${esc(money(v.amount))} voucher for ${esc(v.to_name)} is paid. ${when}`,
    pre: `Receipt: ${money(v.amount)} gift voucher ${v.serial} for ${v.to_name}.`,
    rows: [
      row("Paid", esc(`${money(v.amount)} by card`)),
      row("For", esc(v.to_name)),
      row("Sent to", esc(v.recipient_email)),
      row("Arrives", esc(sentNow ? "Now" : longDate(v.send_on))),
      row("Valid until", esc(longDate(v.expires_on))),
      row("Voucher number", esc(v.serial), true),
    ].join(""),
    buttons: [{ href: viewUrl, label: "See the voucher", solid: true }],
    after: `Keep this email as your receipt. If the voucher does not arrive, or you need to change the email address, reply to this email or call <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a>.`,
  });
  const text = [
    `Thank you, ${v.from_name}. Your ${money(v.amount)} voucher for ${v.to_name} is paid.`,
    sentNow ? `We have emailed it to ${v.recipient_email}.` : `We will email it to ${v.recipient_email} on ${longDate(v.send_on)}.`, ``,
    `Voucher number: ${v.serial}`, `Valid until: ${longDate(v.expires_on)}`, `See the voucher: ${viewUrl}`, ``,
    `Keep this email as your receipt. ${PLACE.name}, ${PLACE.phone}`,
  ].join("\n");
  return { subject: `Receipt: your ${money(v.amount)} Terrarium Bistro voucher for ${v.to_name}`, html, text };
}

export function restaurantVoucherEmail(v: VoucherMail, staffUrl = "") {
  const how = v.source === "online" ? "online by card" : `${v.source === "phone" ? "by phone" : "at the bar"}${v.paid_by ? `, ${v.paid_by}` : ""}`;
  const html = shell({
    kicker: "Voucher sold", title: `${esc(money(v.amount))} for <i style="color:#c9a66b">${esc(v.to_name || "a guest")}</i>`,
    intro: `Sold ${esc(how)}. It is on the tablet under Vouchers, ready to check and spend.`,
    pre: `Voucher ${v.serial}, ${money(v.amount)}`,
    rows: [
      row("For", esc(v.to_name || "Not given")), row("From", esc(v.from_name || "Not given")),
      row("Buyer email", esc(v.buyer_email || "Not given")),
      row("Delivery", esc(v.deliver === "recipient" ? `Email to ${v.recipient_email}${v.send_on ? ` on ${longDate(v.send_on)}` : ""}` : v.deliver === "buyer" ? "Emailed to the buyer" : "Handed over in person")),
      row("Valid until", esc(longDate(v.expires_on))),
      row("Number", esc(v.serial), true),
    ].join(""),
    buttons: staffUrl ? [{ href: staffUrl, label: "Open the tablet", solid: true }] : [],
  });
  const text = `Voucher sold ${how}: ${money(v.amount)} for ${v.to_name}\nNumber: ${v.serial}\nValid until: ${longDate(v.expires_on)}\n${staffUrl ? `Tablet: ${staffUrl}\n` : ""}`;
  return { subject: `Voucher sold: ${money(v.amount)} for ${v.to_name || "a guest"} (${v.serial})`, html, text };
}

/** Phone bookings for big groups: the guest gets a link to pay the deposit. */
export function depositRequestEmail(b: Booked, pence: number, payUrl: string, hours: number, site = "") {
  const html = shell({
    kicker: "Terrarium Bistro · Deposit", site,
    title: `Secure your table for <i style="color:#c9a66b">${b.guests}.</i>`,
    intro: `Thank you, ${esc(b.first)}. For groups of your size we ask for a deposit of ${esc(money(pence))} to hold the table. ${esc(depositRule(hours))}`,
    pre: `Deposit of ${money(pence)} for your table for ${b.guests} on ${longDate(b.date)} at ${b.time}.`,
    rows: [row("Date", esc(longDate(b.date))), row("Time", esc(b.time)), row("Guests", String(b.guests)), row("Deposit", esc(money(pence))), row("Reference", esc(b.ref), true)].join(""),
    buttons: [{ href: payUrl, label: `Pay the ${money(pence)} deposit`, solid: true }],
    after: `The payment page is run by Stripe, so we never see your card details. Questions? Call <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a> or reply to this email.`,
  });
  const text = `Secure your table for ${b.guests} at Terrarium Bistro.\n\nThank you, ${b.first}. For groups of your size we ask for a deposit of ${money(pence)}. ${depositRule(hours)}\n\n${longDate(b.date)} at ${b.time}, ${b.guests} guests, reference ${b.ref}\n\nPay the deposit: ${payUrl}\n\n${PLACE.name}, ${PLACE.phone}`;
  return { subject: `Deposit for your table for ${b.guests} on ${shortDate(b.date)} (${b.ref})`, html, text };
}

/** Confirmation of a deposit paid on a booking the restaurant had already taken (phone bookings). */
export function depositPaidEmail(b: Booked, pence: number, hours: number, site = "") {
  const html = shell({
    kicker: "Terrarium Bistro · Deposit received", site,
    title: `Thank you, <i style="color:#c9a66b">${esc(b.first)}.</i>`,
    intro: `We have your ${esc(money(pence))} deposit and your table is secured. ${esc(depositRule(hours))}`,
    pre: `Deposit of ${money(pence)} received for ${longDate(b.date)} at ${b.time}.`,
    rows: [row("Date", esc(longDate(b.date))), row("Time", esc(b.time)), row("Guests", String(b.guests)), row("Deposit paid", esc(money(pence))), row("Reference", esc(b.ref), true)].join(""),
    after: `Need to change anything? Call <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a> or reply to this email.`,
  });
  const text = `Deposit received: ${money(pence)} for your table for ${b.guests} on ${longDate(b.date)} at ${b.time} (${b.ref}).\n${depositRule(hours)}\n\n${PLACE.name}, ${PLACE.phone}`;
  return { subject: `Deposit received: table for ${b.guests} on ${shortDate(b.date)} (${b.ref})`, html, text };
}

export function restaurantDepositEmail(b: Booked, pence: number, staffUrl = "", warning = "") {
  const html = shell({
    kicker: warning ? "Deposit paid · check this booking" : "Deposit paid",
    title: `${esc(money(pence))} from <i style="color:#c9a66b">${esc(`${b.first} ${b.last}`.trim())}</i>`,
    intro: warning ? esc(warning) : `The deposit for this booking has been paid by card.`,
    pre: `Deposit ${money(pence)} paid for ${b.ref}`,
    rows: [row("When", esc(`${longDate(b.date)} at ${b.time}`)), row("Guests", String(b.guests)), row("Phone", esc(b.phone || "None")), row("Reference", esc(b.ref), true)].join(""),
    buttons: staffUrl ? [{ href: staffUrl, label: "Open the tablet", solid: true }] : [],
  });
  const text = `Deposit ${money(pence)} paid by ${b.first} ${b.last} for ${longDate(b.date)} at ${b.time} (${b.ref}).${warning ? `\n\n${warning}` : ""}`;
  return { subject: `${warning ? "Check: " : ""}Deposit ${money(pence)} paid: ${b.first} ${b.last}, ${shortDate(b.date)} at ${b.time} (${b.ref})`, html, text };
}
