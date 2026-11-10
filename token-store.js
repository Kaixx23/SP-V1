// ============================================================================
// TOKEN STORE — the supplier-leak fix + the customer registry.
//
// BEFORE: a customer's token was base64url(their supplier URL). Anyone holding
//         the one-link could `atob()` it and read the supplier URL in plain
//         text. Verified against the original worker: round-trip is exact.
//
// AFTER:  the token is 24 cryptographically-random bytes (48 hex chars) that
//         encode NOTHING. The supplier URL lives only in this store, which is
//         never exposed on any public route.
//
// Legacy base64 tokens keep resolving forever, so no existing student's VPN
// breaks during migration. See README.md → "Migration".
//
// The table also carries the customer/billing fields the dashboard needs, so
// the leak fix and the dashboard are the same database.
// ============================================================================

const TOKEN_BYTES = 24; // 24 bytes -> 48 hex chars

// Columns added after the first release. Migrations are additive only: a
// pre-existing `links` table gets these added, and every one is nullable or
// defaulted so existing rows stay valid.
export const ADDED_COLUMNS = [
  ["customer", "TEXT"],
  ["customer_type", "TEXT NOT NULL DEFAULT 'individual'"],
  ["supplier_account", "TEXT"],
  ["plan", "TEXT"],
  ["price", "REAL"],
  ["currency", "TEXT"],
  ["billing_cycle", "TEXT"],
  ["paid_until", "TEXT"],
  ["notes", "TEXT"],
  ["supplier_expires", "TEXT"],
  ["total_gb", "REAL"],
  ["used_gb", "REAL"],
  ["checked_at", "TEXT"],
  ["account_email", "TEXT"],
  ["account_password", "TEXT"],
  // Usage-change tracking (see renewal.js). Both nullable, both added by the
  // additive migration below — existing Turso rows keep every value they have
  // and simply start with NULL here, which reads as "no previous check to
  // compare against yet".
  //   prev_used_gb    used_gb as of the immediately previous SUCCESSFUL check
  //   usage_delta_gb  used_gb - prev_used_gb  (>0 used more, <0 supplier reset)
  ["prev_used_gb", "REAL"],
  ["usage_delta_gb", "REAL"],
];

export const LINKS_DDL = `CREATE TABLE IF NOT EXISTS links (
  token            TEXT PRIMARY KEY,
  supplier_url     TEXT NOT NULL,
  label            TEXT,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  customer         TEXT,
  customer_type    TEXT NOT NULL DEFAULT 'individual',
  supplier_account TEXT,
  plan             TEXT,
  price            REAL,
  currency         TEXT,
  billing_cycle    TEXT,
  paid_until       TEXT,
  notes            TEXT,
  supplier_expires TEXT,
  total_gb         REAL,
  used_gb          REAL,
  checked_at       TEXT,
  account_email    TEXT,
  account_password TEXT,
  prev_used_gb     REAL,
  usage_delta_gb   REAL
)`;

export const COLUMNS = [
  "token", "supplier_url", "label", "revoked", "created_at",
  "customer", "customer_type", "supplier_account", "plan", "price", "currency", "billing_cycle", "paid_until",
  "notes", "supplier_expires", "total_gb", "used_gb", "checked_at",
  "account_email", "account_password", "prev_used_gb", "usage_delta_gb",
];
const SELECT = `SELECT ${COLUMNS.join(", ")} FROM links`;

// Reminder de-duplication state. One row per (token, kind, day) — this is what
// lets an hourly cron run without re-sending the same "7 days left" message.
export const REMINDERS_DDL = `CREATE TABLE IF NOT EXISTS reminders (
  token    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  date     TEXT NOT NULL,
  sent_at  TEXT NOT NULL,
  text     TEXT,
  PRIMARY KEY (token, kind, date)
)`;

/** Add any missing columns. Safe to run on every boot. */
async function migrate(db, kind) {
  let existing = new Set();
  try {
    if (kind === "libsql") {
      const r = await db.execute("PRAGMA table_info(links)");
      existing = new Set(r.rows.map((x) => x.name));
    } else {
      const r = await db.prepare("PRAGMA table_info(links)").all();
      existing = new Set((r.results || []).map((x) => x.name));
    }
  } catch (e) {
    existing = new Set(); // unknown dialect: try anyway, ignore dupes below
  }
  for (const [name, type] of ADDED_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      if (kind === "libsql") await db.execute(`ALTER TABLE links ADD COLUMN ${name} ${type}`);
      else await db.prepare(`ALTER TABLE links ADD COLUMN ${name} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    }
  }
}

const norm = (r) => (r ? { ...r, customer_type: r.customer_type || "individual", revoked: !!r.revoked } : null);

// ---------------------------------------------------------------- cache ----
// Sits in front of the backend so a database blip degrades to "serve slightly
// stale data" instead of "every student's VPN stops working". This is the
// single most important resilience property in the file: the DB is a NEW
// failure point that the original stateless design did not have, and this is
// what keeps it from being a customer-facing one.
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

export function invalidate(token) {
  _cache.delete(token);
}
export function clearCache() {
  _cache.clear();
}

// ------------------------------------------------------------- backends ----
// Every backend implements: init(), get(token), put(row), list(), update(), del()

/** In-memory. Tests and local poking. Data is lost on restart. */
export class MemoryBackend {
  constructor() {
    this.map = new Map();
    this.reminders = new Set();
    this.reminderRows = [];
    this.name = "memory";
  }
  async init() {}
  async hasBeenSent(token, kind, date) {
    return this.reminders.has(`${token}|${kind}|${date}`);
  }
  async markSent(token, kind, date, text = null) {
    this.reminders.add(`${token}|${kind}|${date}`);
    this.reminderRows.push({ token, kind, date, sent_at: new Date().toISOString(), text });
  }
  async listReminders(limit = 100) {
    return this.reminderRows.slice().reverse().slice(0, limit);
  }
  async get(token) {
    return norm(this.map.get(token));
  }
  async put(row) {
    this.map.set(row.token, { ...row });
  }
  async list() {
    return [...this.map.values()].map(norm).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async update(token, patch) {
    const r = this.map.get(token);
    if (!r) return null;
    Object.assign(r, patch);
    return norm(r);
  }
  async del(token) {
    return this.map.delete(token);
  }
}

/**
 * SQLite via @libsql/client.
 *   - local file  (TOKEN_STORE_URL=file:tokens.db)  -> dev / single box
 *   - Turso       (TOKEN_STORE_URL=libsql://x.turso.io + TOKEN_STORE_AUTH_TOKEN)
 *                                                   -> Vercel / Netlify / anywhere
 */
export class LibsqlBackend {
  constructor({ url, authToken }) {
    this.url = url;
    this.authToken = authToken;
    this.name = url.startsWith("file:") ? "sqlite-file" : "turso";
  }
  async init() {
    const { createClient } = await import("@libsql/client");
    this.db = createClient({ url: this.url, authToken: this.authToken });
    await this.db.execute(LINKS_DDL);
    await migrate(this.db, "libsql");
    await this.db.execute(REMINDERS_DDL);
  }
  async hasBeenSent(token, kind, date) {
    const r = await this.db.execute({
      sql: "SELECT 1 AS x FROM reminders WHERE token=? AND kind=? AND date=?",
      args: [token, kind, date],
    });
    return r.rows.length > 0;
  }
  async markSent(token, kind, date, text = null) {
    await this.db.execute({
      sql: "INSERT OR IGNORE INTO reminders (token, kind, date, sent_at, text) VALUES (?,?,?,?,?)",
      args: [token, kind, date, new Date().toISOString(), text],
    });
  }
  async listReminders(limit = 100) {
    const r = await this.db.execute({
      sql: "SELECT token, kind, date, sent_at, text FROM reminders ORDER BY sent_at DESC LIMIT ?",
      args: [Number(limit) || 100],
    });
    return r.rows;
  }
  async get(token) {
    const r = await this.db.execute({ sql: `${SELECT} WHERE token = ?`, args: [token] });
    return r.rows.length ? norm(r.rows[0]) : null;
  }
  async put(row) {
    await this.db.execute({
      sql: `INSERT INTO links (${COLUMNS.join(", ")})
            VALUES (${COLUMNS.map(() => "?").join(", ")})
            ON CONFLICT(token) DO UPDATE SET supplier_url=excluded.supplier_url`,
      args: COLUMNS.map((c) => (c === "customer_type" ? row[c] || "individual" : row[c] ?? null)),
    });
  }
  async list() {
    const r = await this.db.execute(`${SELECT} ORDER BY created_at DESC`);
    return r.rows.map(norm);
  }
  async update(token, patch) {
    // Update only the requested fields. A quota refresh must not overwrite a
    // payment (or a customer edit) that was saved while the refresh was running.
    const cols = COLUMNS.filter((c) => c !== "token" && Object.hasOwn(patch, c));
    if (cols.length) await this.db.execute({
      sql: `UPDATE links SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE token=?`,
      args: [...cols.map((c) => patch[c] ?? null), token],
    });
    return this.get(token);
  }
  async del(token) {
    const r = await this.db.execute({ sql: "DELETE FROM links WHERE token = ?", args: [token] });
    return Number(r.rowsAffected) > 0;
  }
}

/**
 * Cloudflare D1. Pass the D1 binding in: `new D1Backend(env.DB)`.
 * Only reachable from a Worker — `env` is empty on Vercel/Netlify.
 */
export class D1Backend {
  constructor(binding) {
    this.db = binding;
    this.name = "d1";
  }
  async init() {
    await this.db.prepare(LINKS_DDL).run();
    await migrate(this.db, "d1");
    await this.db.prepare(REMINDERS_DDL).run();
  }
  async hasBeenSent(token, kind, date) {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM reminders WHERE token=? AND kind=? AND date=?")
      .bind(token, kind, date).first();
    return !!row;
  }
  async markSent(token, kind, date, text = null) {
    await this.db
      .prepare("INSERT OR IGNORE INTO reminders (token, kind, date, sent_at, text) VALUES (?,?,?,?,?)")
      .bind(token, kind, date, new Date().toISOString(), text).run();
  }
  async listReminders(limit = 100) {
    const { results } = await this.db
      .prepare("SELECT token, kind, date, sent_at, text FROM reminders ORDER BY sent_at DESC LIMIT ?")
      .bind(Number(limit) || 100).all();
    return results || [];
  }
  async get(token) {
    return norm(await this.db.prepare(`${SELECT} WHERE token = ?`).bind(token).first());
  }
  async put(row) {
    await this.db
      .prepare(`INSERT INTO links (${COLUMNS.join(", ")})
                VALUES (${COLUMNS.map(() => "?").join(", ")})
                ON CONFLICT(token) DO UPDATE SET supplier_url=excluded.supplier_url`)
      .bind(...COLUMNS.map((c) => (c === "customer_type" ? row[c] || "individual" : row[c] ?? null)))
      .run();
  }
  async list() {
    const { results } = await this.db.prepare(`${SELECT} ORDER BY created_at DESC`).all();
    return (results || []).map(norm);
  }
  async update(token, patch) {
    const cols = COLUMNS.filter((c) => c !== "token" && Object.hasOwn(patch, c));
    if (cols.length) await this.db
      .prepare(`UPDATE links SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE token=?`)
      .bind(...cols.map((c) => patch[c] ?? null), token)
      .run();
    return this.get(token);
  }
  async del(token) {
    const r = await this.db.prepare("DELETE FROM links WHERE token = ?").bind(token).run();
    return Number(r.meta?.changes || 0) > 0;
  }
}

/**
 * Pick a backend.
 * Explicit override: setBackend(). Otherwise: D1 binding if present, else
 * TOKEN_STORE_URL, else in-memory (safe default — never silently writes to a
 * half-configured database).
 */
let _backend = null;
let _initPromise = null;

export function setBackend(b) {
  // No-op when already initialised: the Worker fetch handler calls this on
  // every request, and re-creating the client each time would mean a new
  // connection (and a fresh migration) per request.
  if (b === null && _backend) return;
  _backend = b;
  _initPromise = null;
}

export function pickBackend(env = {}) {
  if (env.DB && typeof env.DB.prepare === "function") return new D1Backend(env.DB);
  const url = env.TOKEN_STORE_URL;
  if (url) return new LibsqlBackend({ url, authToken: env.TOKEN_STORE_AUTH_TOKEN });
  return new MemoryBackend();
}

export function backend(runtimeEnv = {}) {
  if (!_backend) {
    // D1 bindings arrive on the Worker request, not process.env. Node runtimes
    // still use process.env; an explicit test/local backend remains untouched.
    let env = {};
    try { env = (typeof process !== "undefined" && process.env) || {}; } catch (e) { env = {}; }
    _backend = pickBackend({ ...env, ...runtimeEnv });
  }
  return _backend;
}

export async function ensureInit(runtimeEnv) {
  if (!_initPromise) _initPromise = backend(runtimeEnv).init();
  return _initPromise;
}

/** Opaque token: 24 random bytes, hex. Encodes nothing about the supplier. */
export function newToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isOpaque(token) {
  return /^[0-9a-f]{48}$/.test(String(token || ""));
}

// ------------------------------------------------------- public interface --

/**
 * Store a supplier URL, return its opaque token.
 * `fields` may carry any of the customer/billing columns (customer, plan,
 * price, paid_until, …).
 */
export async function mint(supplierUrl, label = null, fields = {}) {
  await ensureInit();
  const token = newToken();
  const row = {
    token,
    supplier_url: supplierUrl,
    label,
    revoked: false,
    created_at: new Date().toISOString(),
    ...fields,
  };
  await backend().put(row);
  _cache.set(token, { t: Date.now(), v: row });
  return token;
}

/**
 * Resolve any token — opaque or legacy base64 — to its supplier URL.
 * Returns null when the token is unknown or revoked.
 *
 * The legacy branch is why migration is safe: base64 tokens minted before this
 * change carry their own URL and keep working forever.
 */
export async function resolve(token) {
  await ensureInit();

  let row = null;
  try {
    if (isOpaque(token)) {
      // Deliberately NOT served from the local cache: revocation has to take
      // effect immediately, and a cached pre-revocation row would keep the
      // link alive for up to the whole TTL. The worker memoises the expensive
      // supplier fetch separately, so this stays a cheap key lookup.
      row = await backend().get(token);
      if (row && row.revoked) row = null;
    } else {
      row = legacyResolve(token);
    }
  } catch (e) {
    // Backend is down. Fall back to whatever the cache still holds even if it
    // expired — a stale subscription is far better than a dead one.
    const stale = _cache.get(token);
    if (stale?.v) return stale.v.supplier_url;
    throw e;
  }
  if (row) _cache.set(token, { t: Date.now(), v: row });
  return row ? row.supplier_url : null;
}

/**
 * Legacy base64url decode, kept byte-identical to the original worker's b64d
 * so existing links resolve exactly as before.
 */
function legacyResolve(token) {
  try {
    const s = String(token).replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (String(token).length % 4)) % 4);
    const decoded = decodeURIComponent(escape(atob(s)));
    if (!decoded) return null;
    return { token, supplier_url: decoded, label: "legacy", revoked: false, created_at: null };
  } catch (e) {
    return null;
  }
}

export async function listAll() {
  await ensureInit();
  return backend().list();
}
export async function updateRow(token, patch) {
  await ensureInit();
  const r = await backend().update(token, patch);
  if (r) _cache.set(token, { t: Date.now(), v: r });
  return r;
}
/** Has this (token, kind) already been sent today? Powers cron idempotency. */
export async function hasBeenSent(token, kind, date) {
  await ensureInit();
  return backend().hasBeenSent(token, kind, date);
}
export async function markSent(token, kind, date, text = null) {
  await ensureInit();
  return backend().markSent(token, kind, date, text);
}
export async function listReminders(limit = 100) {
  await ensureInit();
  return backend().listReminders(limit);
}

export async function removeRow(token) {
  await ensureInit();
  invalidate(token);
  return backend().del(token);
}
