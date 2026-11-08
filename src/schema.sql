-- Terrarium Bistro: table bookings, staff access and booking rules.
-- Additive only (CREATE ... IF NOT EXISTS / INSERT OR IGNORE).

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,              -- YYYY-MM-DD (Europe/London)
  time TEXT NOT NULL,              -- HH:MM
  mins INTEGER NOT NULL,           -- minutes after midnight, for overlap maths
  duration INTEGER NOT NULL,       -- minutes the table is held
  guests INTEGER NOT NULL,
  first TEXT NOT NULL DEFAULT '',
  last TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  occasion TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  staff_note TEXT NOT NULL DEFAULT '',
  table_no TEXT NOT NULL DEFAULT '',
  newsletter INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'online',   -- online | phone | walkin
  status TEXT NOT NULL DEFAULT 'booked',   -- booked | seated | finished | cancelled | noshow
  ip TEXT NOT NULL DEFAULT '',             -- salted hash, used only for spam limits
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings (date, status);
CREATE INDEX IF NOT EXISTS bookings_updated_idx ON bookings (updated_at);
CREATE INDEX IF NOT EXISTS bookings_ip_idx ON bookings (ip, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-day override: closed = 1 stops online bookings that day, 0 opens a normally closed day.
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  closed INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

-- Per-slot cover limit for one date (0 = blocked online).
CREATE TABLE IF NOT EXISTS slot_limits (
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  covers INTEGER NOT NULL,
  PRIMARY KEY (date, time)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,             -- SHA-256 of the cookie token
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_ip_idx ON attempts (ip, at);

-- One-time code for creating the staff passcode on first use (only the hash is stored).
INSERT OR IGNORE INTO settings (key, value)
VALUES ('setup_code_sha256', '8314b1c0dc68fab1a155b28e22e3c2fc3ffab4f362096ae1cfb49c1d4ace4b2d');

-- Day-before reminder emails: one row per reminded booking, so nobody gets two.
CREATE TABLE IF NOT EXISTS reminders (
  ref TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

-- Private key for signing guests' one-tap cancel links (made once, never shown).
INSERT OR IGNORE INTO settings (key, value)
VALUES ('link_secret', lower(hex(randomblob(32))));

-- Walk-in waiting list: parties waiting at the door for a table.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                      -- YYYY-MM-DD (Europe/London)
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  guests INTEGER NOT NULL,
  quote INTEGER NOT NULL DEFAULT 0,        -- minutes of wait the guest was told
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | seated | left
  booking_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_date_idx ON waitlist (date, status);

-- Notes that follow a guest from visit to visit (allergies, favourite table). Keyed by email or phone.
CREATE TABLE IF NOT EXISTS guests (
  key TEXT PRIMARY KEY,                    -- 'e:' + lower-case email, or 'p:' + phone digits
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- Gift vouchers: bought online by card (Stripe) or sold at the bar, then checked and spent on the tablet.
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,              -- TB-XXXX-XXXX-X, printed on the voucher
  amount INTEGER NOT NULL,                  -- value in pence
  balance INTEGER NOT NULL,                 -- pence still to spend
  status TEXT NOT NULL DEFAULT 'pending',   -- pending (paying) | active | used | void | unpaid
  source TEXT NOT NULL DEFAULT 'online',    -- online | bar | phone
  paid_by TEXT NOT NULL DEFAULT '',         -- card online | card | cash
  to_name TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL DEFAULT '',
  deliver TEXT NOT NULL DEFAULT 'buyer',    -- recipient | buyer | none
  send_on TEXT NOT NULL DEFAULT '',         -- YYYY-MM-DD the voucher email goes out
  sent_at TEXT,
  stripe_session TEXT,
  stripe_payment TEXT,
  paid_at TEXT,
  expires_on TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD, 12 months after purchase
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vouchers_session_idx ON vouchers (stripe_session);
CREATE INDEX IF NOT EXISTS vouchers_status_idx ON vouchers (status, created_at);

-- Every time part of a voucher is spent (a negative amount puts money back after a mistake).
CREATE TABLE IF NOT EXISTS voucher_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS voucher_uses_idx ON voucher_uses (voucher_id);

-- Deposits for large groups, one per booking.
CREATE TABLE IF NOT EXISTS deposits (
  booking_id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL,
  amount INTEGER NOT NULL,                  -- pence
  status TEXT NOT NULL DEFAULT 'due',       -- due | paid | waived | refunded | lapsed
  hold_until TEXT,                          -- online bookings: seats are held until then while the guest pays
  stripe_session TEXT,
  stripe_payment TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits (status, hold_until);
CREATE INDEX IF NOT EXISTS deposits_session_idx ON deposits (stripe_session);
