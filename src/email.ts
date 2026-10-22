// Booking emails, sent by the booking server through Resend:
//  - a confirmation to the guest (from the restaurant's own domain, with a calendar invite)
//  - a copy to the restaurant inbox
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

export function guestEmail(b: Booked, site = "") {
  const rows = [
    row("Date", esc(longDate(b.date))),
    row("Time", esc(b.time)),
    row("Guests", String(b.guests)),
    row("Name", esc(`${b.first} ${b.last}`)),
    b.occasion && b.occasion !== "None" ? row("Occasion", esc(b.occasion)) : "",
    b.notes ? row("Your notes", esc(b.notes)) : "",
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
<p style="margin:0;padding-top:20px;border-top:1px solid #35312a;font:14px/1.6 ${SANS};color:#c8bea9">Need to change or cancel? Call us on <a href="tel:${PLACE.phoneIntl}" style="color:#ecd49c;text-decoration:none">${PLACE.phone}</a> or simply reply to this email.</p>
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
    `Reference: ${b.ref}`, ``,
    `Add to Google Calendar: ${googleCalendarLink(b)}`,
    `Directions: ${PLACE.maps}`, ``,
    `Need to change or cancel? Call ${PLACE.phone} or reply to this email.`,
    `${PLACE.name}, ${PLACE.address}`,
  ].join("\n");
  return { subject: `Your table is confirmed: ${shortDate(b.date)} at ${b.time}`, html, text };
}

export function restaurantEmail(b: Booked, staffUrl = "") {
  const rows = [
    row("When", esc(`${longDate(b.date)} at ${b.time}`)),
    row("Guests", String(b.guests)),
    row("Name", esc(`${b.first} ${b.last}`)),
    row("Phone", `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ""))}" style="color:#ecd49c">${esc(b.phone)}</a>`),
    row("Email", `<a href="mailto:${esc(b.email)}" style="color:#ecd49c">${esc(b.email)}</a>`),
    row("Occasion", esc(b.occasion || "None")),
    row("Notes", esc(b.notes || "None")),
    row("Newsletter", b.newsletter ? "Yes, opted in" : "No"),
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

/** Sends the guest confirmation (and a restaurant copy). Resolves true when the guest email was accepted. */
export async function sendBookingEmails(env: MailEnv, raw: Record<string, unknown>, ref: string): Promise<boolean> {
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
  const url = env.RESEND_API_URL || "https://api.resend.com/emails";
  const from = env.MAIL_FROM || "Terrarium Bistro <bookings@terrariumbistro.co.uk>";
  const send = async (payload: Record<string, unknown>) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
  };
  const g = guestEmail(b, env.PUBLIC_SITE);
  const jobs: Promise<boolean>[] = [
    send({
      from, to: [b.email], subject: g.subject, html: g.html, text: g.text,
      reply_to: env.RESTAURANT_EMAIL || undefined,
      attachments: [{ filename: "terrarium-booking.ics", content: toBase64(calendarFile(b)), content_type: "text/calendar" }],
      headers: { "X-Entity-Ref-ID": b.ref },
    }),
  ];
  if (env.RESTAURANT_EMAIL) {
    const r = restaurantEmail(b, env.STAFF_URL);
    jobs.push(send({ from, to: [env.RESTAURANT_EMAIL], subject: r.subject, html: r.html, text: r.text, reply_to: b.email }));
  }
  const [guestOk] = await Promise.all(jobs);
  return guestOk;
}
