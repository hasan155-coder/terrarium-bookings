// A small Stripe client for the two things the booking server sells: gift vouchers and group deposits.
// It only uses hosted Checkout, so card details never touch this server.
// STRIPE_SECRET_KEY is a Cloudflare secret (added in the dashboard, never stored in the code).
export type StripeEnv = { STRIPE_SECRET_KEY?: string; STRIPE_API_URL?: string };

export type Session = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired" | string;
  payment_status: "paid" | "unpaid" | "no_payment_required" | string;
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  expires_at: number;
  metadata: Record<string, string>;
  customer_details?: { email?: string | null; name?: string | null } | null;
};

export const stripeOn = (env: StripeEnv) => !!env.STRIPE_SECRET_KEY;
/** The most recent error Stripe returned (keys masked), shown to staff on the tablet so problems can be fixed. */
export let lastStripeError: { at: string; status: number; message: string } | null = null;
/** "test" while the key is a test key, so staff can see that no real money moves. */
export const stripeMode = (env: StripeEnv) => (!env.STRIPE_SECRET_KEY ? "off" : /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY) ? "test" : "live");

/** Stripe wants form encoding with bracketed keys: line_items[0][price_data][currency]=gbp */
function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call<T>(env: StripeEnv, method: "GET" | "POST", path: string, body?: Record<string, unknown>, idem?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("stripe_off");
  const base = (env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
        ...(idem ? { "Idempotency-Key": idem } : {}),
      },
      body: body ? form(body).toString() : undefined,
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const msg = String(data?.error?.message ?? "").replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9*]+/g, "[key]");
      console.error("stripe", res.status, msg);
      lastStripeError = { at: new Date().toISOString(), status: res.status, message: msg.slice(0, 400) };
      throw new Error(`stripe_${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export type CheckoutInput = {
  pence: number;
  name: string;
  description?: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  paymentDescription: string;
  expiresInMin?: number; // 30 to 1440 (Stripe's limits)
  idempotencyKey: string;
};

export function createCheckout(env: StripeEnv, c: CheckoutInput): Promise<Session> {
  const mins = Math.min(1440, Math.max(31, Math.round(c.expiresInMin ?? 60)));
  return call<Session>(env, "POST", "/v1/checkout/sessions", {
    mode: "payment",
    // Cards (Apple Pay and Google Pay come with them), so the page opens without extra Stripe settings.
    payment_method_types: ["card"],
    locale: "en-GB",
    submit_type: "pay",
    customer_email: c.email || undefined,
    success_url: c.successUrl,
    cancel_url: c.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + mins * 60,
    line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: c.pence, product_data: { name: c.name, description: c.description } } }],
    metadata: c.metadata,
    payment_intent_data: { description: c.paymentDescription, metadata: c.metadata },
  }, c.idempotencyKey);
}

export const getSession = (env: StripeEnv, id: string) =>
  call<Session>(env, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);

export const isPaid = (s: Session, pence: number) =>
  s.payment_status === "paid" && s.status === "complete" && (s.amount_total ?? 0) === pence && (s.currency ?? "gbp") === "gbp";
