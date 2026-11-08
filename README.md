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
  - settings for covers per slot, seats, table time, booking times, closed days, reminders and the table list.
- Runs on Cloudflare Workers with a D1 database, plus an hourly scheduled run for reminders. Cloudflare redeploys it automatically whenever this repository changes.

Settings such as covers per time slot, seats, table time, tables and closed days are changed from the staff dashboard, not here. New database tables are created automatically on the first request after an update.
