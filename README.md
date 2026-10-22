# Terrarium Bistro bookings

The booking system behind the table form on the Terrarium Bistro website.

- **Guests** book on the website. Each booking is checked against live availability and confirmed instantly.
- **Staff** open `/staff` on the tablet to see, seat, move and cancel bookings, add phone bookings and walk-ins, and change limits.
- Runs on Cloudflare Workers with a D1 database. Cloudflare redeploys it automatically whenever this repository changes.

Settings such as covers per time slot, seats, table time and closed days are changed from the staff dashboard, not here.
