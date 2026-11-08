# Terrarium Bistro bookings

The booking system behind the table form on the Terrarium Bistro website.

- **Guests** book on the website. Each booking is checked against live availability, confirmed instantly and given a table automatically.
- **Emails** (through Resend): a confirmation with a calendar invite, a reminder at 10am the day before, and a one-tap cancel link in both. The restaurant gets a copy of every booking and an alert when a guest cancels.
- **Staff** open `/staff` on the tablet:
  - the day's bookings by time, with seat, finish, running late, no-show and cancel;
  - a colour-coded table view (free, reserved, running late, seated) for now or any time slot;
  - a table picker that pushes tables together for big groups, plus "Give tables" for a whole day;
  - a waiting list for walk-ins, with call and text buttons, that seats parties straight onto a table;
  - guest history (visits, no-shows) and guest notes that follow each guest from visit to visit;
  - reports: covers, no-show rate, sources, busiest days and times, party sizes;
  - settings for covers per slot, seats, table time, booking times, closed days, reminders, deposits and the table list;
  - **gift vouchers**: look up any voucher number, take off what was spent (all or part, with undo), cancel one, or sell one at the bar or by phone.
- **Card payments** (Stripe hosted Checkout, so card details never touch this server):
  - gift vouchers bought on the website are issued once Stripe confirms payment, emailed on the day the buyer chose, with a receipt to the buyer and an alert to the restaurant;
  - groups at or above the deposit size (9 by default, £10 a head) pay a deposit: online bookings are held for 30 minutes while the guest pays, then confirmed or released; phone bookings get a pay link by text or email from the tablet;
  - payments are confirmed when the guest returns from Stripe and again by the hourly run, so closing the page after paying is safe.
- Runs on Cloudflare Workers with a D1 database, plus an hourly scheduled run for reminders, payment checks and scheduled vouchers. Cloudflare redeploys it automatically whenever this repository changes.

Settings such as covers per time slot, seats, table time, tables and closed days are changed from the staff dashboard, not here. New database tables are created automatically on the first request after an update.

## Secrets (never stored in this repository)

Either add them in the Cloudflare dashboard, or paste them on the tablet under Settings, then Payment and email keys (needs the staff passcode; info@ is emailed on every change). A key set in Cloudflare always wins.

- `RESEND_API_KEY`: sends the emails.
- `STRIPE_SECRET_KEY`: switches card payments on. A test key (`sk_test_...`) keeps the website's payment buttons hidden from guests: open the site with `?testpay=1` to try it with Stripe's test card. Swap in the live key (`sk_live_...`) to take real payments.
