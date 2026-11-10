// ============================================================================
// SP-V1 — the converter that converts nothing.  v1.0
//
// WHY THIS REPO EXISTS
// The hub (sp-vpn-hub) *rebuilds* the supplier's subscription into its own mihomo
// profile: rebranded node names, geo-free DNS, its own groups, rules and probe
// policy. That is a product. It is also a set of differences, and every
// difference is a possible ticket: "the panel's link pings fine, yours doesn't".
//
// This host removes the category. It downloads the supplier's own response and
// hands the app those bytes:
//
//   exact  (default) — verbatim passthrough of the supplier's bytes. A
//                      Clash-family client gets the panel's mihomo YAML (that is
//                      what `&type=clash&flag=meta` is for on their side); any
//                      other client gets the panel's base64 link list. Copied,
//                      never parsed: no trim, no BOM strip, no re-encode, no
//                      added comment, no renamed node.
//   safe             — the hub's rebuilt profile, fetched from the hub at request
//                      time (HUB_BASE_URL). Deliberately NOT a copy of that code:
//                      a copy drifts, a proxy cannot.
//
// GUARANTEED: the nodes, pings, ports, keys, groups, DNS servers, rules and quota
// lines a customer sees here are exactly the ones they see from the supplier's
// link, because it is the same file, byte for byte.
// NOT GUARANTEED: anything else. If the supplier's own profile is wrong for an
// app, this is wrong the same way — that is what "identical" costs, and it is why
// both modes ship. `/admin/verify?t=` proves the identity in production, and
// `?profile=safe` is the way out.
// ============================================================================

import * as store from "./token-store.js";

export const VERSION = "v1.0";
export const MODES = ["exact", "safe"];

// A fetched profile is kept this long, so ten app refreshes in a minute are one
// supplier hit. Same as the hub, on purpose.
const TTL = 300000;
// …but it is served for up to this long when the upstream is unreachable: a
// stale subscription beats every customer's VPN dying during a CDN hiccup.
const STALE_MAX_MS = 24 * 3600 * 1000;
// The platform cuts a function off at 10s. Both hops have to fit inside what is
// left, so each gets an explicit slice instead of its own fresh timeout:
// 6500 (supplier) + 2600 (hub fallback) < 10000.
const FETCH_BUDGET_MS = 6500;
const HUB_BUDGET_MS = 2600;
const HEALTH_TTL_MS = 120000;

// Headers worth copying from the upstream response. `subscription-userinfo` is
// the quota line apps render; synthesising our own would be a new difference.
const PASS_HEADERS = ["subscription-userinfo", "profile-update-interval", "content-disposition"];

// The hub's own defaults, so a customer link only has to change host, not path.
const DEFAULT_HUB = "https://sp-vpn.netlify.app";

// ---------------------------------------------------------------------------
// Format negotiation — copied from the hub on purpose. Two sites that negotiate
// differently would be exactly the kind of difference this repo exists to remove.
// Keep in sync with sp-vpn-hub/sp-vpn-worker.js.
// ---------------------------------------------------------------------------
export const CLASH_UA_KEYS = [
  "clash", "clashmi", "clash-mi", "clashx", "clashmeta", "mihomo", "meta",
  "verge", "nyanpasu", "fugu", "flclash", "stash", "streisand", "sparkle",
  "party", "zash", "reqwest", "tauri",
  // Karing runs the mihomo core but announces itself as "Karing/x.y.z"; with no
  // match here it was handed a bare base64 list and had to rebuild a config
  // itself, losing the auto-speed group and the quota header.
  "karing",
];

export function wantsClashYaml({ fmt = "", ua = "", accept = "", ext = "" }) {
  const f = String(fmt).toLowerCase();
  const e = String(ext).toLowerCase();
  if (["yaml", "yml", "clash", "mihomo", "meta"].includes(f)) return true;
  if (["sr", "b64", "base64", "v2ray", "share", "txt"].includes(f)) return false;
  if (e === "yaml" || e === "yml") return true;
  if (e === "txt" || e === "sr") return false;
  const u = String(ua).toLowerCase();
  const a = String(accept).toLowerCase();
  if (CLASH_UA_KEYS.some((k) => u.includes(k))) return true;
  return a.includes("yaml") || a.includes("yml");
}

export function splitExt(seg) {
  const m = String(seg).match(/^(.*)\.(yaml|yml|txt|sr)$/i);
  return m ? { name: m[1], ext: m[2].toLowerCase() } : { name: seg, ext: "" };
}
export const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };

// ---------------------------------------------------------------------------
// The one piece of interpretation in exact mode: WHICH of the panel's endpoints
// to ask. A subscription panel answers a base64 link list by default and mihomo
// YAML when asked with type=clash&flag=meta — that is the panel's own switch, so
// this is not a rewrite of their config, it is requesting the same document the
// app would request from them. `&raw=1` skips even this and fetches the stored
// URL exactly as stored, for panels that already answer YAML.
// ---------------------------------------------------------------------------
export function clashYamlUrl(supplierUrl) {
  let u;
  try { u = new URL(String(supplierUrl)); } catch (e) { return String(supplierUrl); }
  if (!u.searchParams.has("type")) u.searchParams.set("type", "clash");
  if (!u.searchParams.has("flag")) u.searchParams.set("flag", "meta");
  return u.toString();
}

/**
 * A bot challenge / rate limit IS a response, and it is not the supplier being
 * down. Same signatures the hub learned on 2026-11-10, because the two sites
 * must classify a failure the same way or their dashboards disagree about it.
 */
export function isThrottleResponse(status, body) {
  if (status === 429 || status === 403) return true;
  const t = String(body || "");
  if (!t.length || t.length > 4000) return false;
  return /just a moment|attention required|verify you are a human|cf-chl|challenge-platform|rate limit/i.test(t);
}

/** Is this a mihomo profile — or a challenge page, an error, an empty file? */
export function isUsableProfile(text) {
  const t = String(text || "");
  if (t.length < 120) return false;
  if (/^\s*(<(!doctype|html)|\{)/i.test(t)) return false;
  if (!/(^|\n)\s*-?\s*(proxies|proxy-providers)\s*:/.test(t)) return false;
  if (!/(^|\n)\s*(proxy-groups|groups)\s*:/.test(t)) return false;
  return true;
}

/** Is this a node list — base64-encoded or plain? */
export function isUsableList(text) {
  const t = String(text || "").trim();
  if (t.length < 40) return false;
  if (/^\s*<(!doctype|html)/i.test(t)) return false;
  if (/^[a-z0-9+.-]+:\/\//im.test(t)) return true;
  return /(?:vless|vmess|trojan|hysteria2|tuic|ss):\/\//i.test(tryDecodeB64(t));
}

function tryDecodeB64(s) {
  try {
    const t = String(s).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(t)) return "";
    return Buffer.from(t, "base64").toString("utf8");
  } catch (e) { return ""; }
}

/**
 * Never echo a supplier URL and never echo a token: fetch errors and upstream
 * bodies both end up in /diag and in customer-facing failure messages. The
 * supplier URL is the customer's paid access; the hub scrubbed it out of its
 * dashboard for the same reason.
 */
export function scrub(supplierUrl, s) {
  let out = String(s || "");
  try { out = out.split(String(supplierUrl)).join(new URL(String(supplierUrl)).host); } catch (e) { /* not a URL */ }
  out = out.replace(/([?&](?:token|t)=)[^&\s"'`]+/gi, "$1[scrubbed]");
  return out.slice(0, 400);
}

// --------------------------------------------------------------------- fetch --
// Byte-exactness is a property of HOW the body is read, not of what is written at
// the end. arrayBuffer() and pass the buffer through: reading as text would drop
// nothing but re-encoding a Response(string) can rewrite CRLF and a BOM, and a
// `.trim()` — the kind of helpful normalisation that made a difference nobody
// asked for.
async function grab(url, budgetMs, request) {
  const t0 = Date.now();
  if (!(budgetMs > 0)) return { ok: false, status: 0, error: "no time left in the function budget", ms: 0 };
  const headers = {};
  // Forward the CLIENT's User-Agent and Accept, and only those. A subscription
  // panel sniffs them to decide between YAML and a link list, so forwarding them
  // is what makes this a passthrough rather than a rewrite; forwarding
  // Cookie/Authorization from a stranger's request would be a different bug.
  const ua = request && request.headers && request.headers.get("user-agent");
  if (ua) headers["User-Agent"] = ua;
  const accept = request && request.headers && request.headers.get("accept");
  if (accept) headers["Accept"] = accept;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(300, budgetMs)) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      bytes,
      text: new TextDecoder("utf-8").decode(bytes),
      headers: res.headers,
      ms: Date.now() - t0,
    };
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const secs = budgetMs % 1000 === 0 ? String(budgetMs / 1000) : (budgetMs / 1000).toFixed(1);
    return {
      ok: false,
      status: 0,
      error: timedOut ? `upstream did not answer within ${secs}s` : `upstream fetch failed: ${(e && e.message) || e}`,
      ms: Date.now() - t0,
    };
  }
}

async function sha256(bytes) {
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return ""; }
}

const countNames = (t) => (String(t).match(/(^|\n)\s*-?\s*\{?\s*name\s*[:=]/g) || []).length;
const countRules = (t) => (String(t).match(/(^|\n)\s*-?\s*'?[A-Z][A-Z0-9-]+,/g) || []).length;

// -------------------------------------------------------------------- cache ----
const _cache = new Map();   // "<token>|<kind>|<mode>|<raw>" -> { t, d }
const _flight = new Map();  // single-flight: a stampede of app refreshes is one fetch
let _staleServed = 0;

/** Tests and /healthz diagnostics only: forget every memoised document. */
export function resetCaches() {
  _cache.clear();
  _flight.clear();
  _staleServed = 0;
  _health = { t: 0, report: null };
  return true;
}
export const cacheState = () => ({ entries: _cache.size, stale_served: _staleServed, ttl_s: TTL / 1000, stale_max_h: STALE_MAX_MS / 3600000 });

function once(key, fn) {
  const inflight = _flight.get(key);
  if (inflight) return inflight;
  const p = Promise.resolve().then(fn).finally(() => _flight.delete(key));
  _flight.set(key, p);
  return p;
}

// ------------------------------------------------------------------ helpers ----
const sameHost = (a, b) => String(a || "").toLowerCase().replace(/:\d+$/, "") === String(b || "").toLowerCase().replace(/:\d+$/, "");

// Routes that belong to a *converter* rather than a panel. Shape-based, because a
// branded domain legitimately serves both the panel and customer links — the hub
// learned on 2026-11-10 that the host alone proves nothing. A loop-back needs
// host AND route to match.
const CONV_ROUTES = /^\/(all|sub|share|e|sr)(\/|$)/i;

export function isLoopback(supplierUrl, hosts) {
  let u;
  try { u = new URL(String(supplierUrl)); } catch (e) { return false; }
  if (!CONV_ROUTES.test(u.pathname)) return false;
  // Callers hand over a mix of bare hosts and full base URLs (HUB_BASE_URL is a
  // URL), so normalise both sides — comparing "hub.test" against
  // "https://hub.test" would miss the loop and turn a customer's own link into a
  // request storm against us.
  const hostOf = (h) => {
    const s = String(h || "");
    if (!s) return "";
    try { return new URL(s.includes("//") ? s : "https://" + s).host; } catch (e) { return s; }
  };
  return (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean).some((h) => sameHost(u.host, hostOf(h)));
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-SPVPN-Version": VERSION },
});
const plain = (s, status = 200, extra = {}) => new Response(String(s), {
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-SPVPN-Version": VERSION, ...extra },
});

function pickHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((v, k) => { if (PASS_HEADERS.includes(k.toLowerCase())) out[k.toLowerCase()] = v; });
  return out;
}

/**
 * Map this site's path onto the hub's, so `?profile=safe` hands the SAME customer
 * token to the other converter. `/e/<token>` (token in the path) has no hub
 * equivalent, so it becomes the hub's `/all/<brand>?t=` form.
 */
export function hubRequestUrl(hubBase, url, kind, tok) {
  const u = new URL(String(hubBase));
  const onOurPath = /^\/e\/[^/]+$/.test(url.pathname);
  const q = new URLSearchParams(url.search);
  if (onOurPath) {
    u.pathname = "/all/SP VPN";
    q.set("t", tok);
  } else {
    u.pathname = url.pathname;
  }
  // A YAML client must be handed YAML by the hub whatever its User-Agent says:
  // the hub negotiates, and an unrecognised UA there means a base64 list.
  if (kind === "yaml" && !q.has("fmt")) q.set("fmt", "yaml");
  const s = q.toString();
  u.search = s ? "?" + s : "";
  return u.toString();
}

// ============================================================================
// The decision.
//
//   exact  →  the supplier's bytes for this client      (default)
//   safe   →  the hub's rebuilt profile                   (fallback, or forced)
//
// A failure of `exact` is not an error, it is a fallback, and the response says
// which happened — `X-SPVPN-Fallback` for curl, `tried[]` for the tools. A
// failure of BOTH is the only real error, and it names the cause of each hop
// instead of blaming "the supplier" for a rate limit.
// ============================================================================
async function resolveBytes({ tok, kind, url, request, env }) {
  const wantMode = String(url.searchParams.get("profile") || "").toLowerCase();
  const strict = url.searchParams.get("fallback") === "0" || wantMode === "exact";
  const forceSafe = wantMode === "safe";
  const hubBase = env.HUB_BASE_URL || DEFAULT_HUB;
  // Every knob that changes what the upstream is asked for belongs in the key:
  // ?raw=1 and ?profile=safe are different documents, and sharing one cache entry
  // would serve the wrong bytes to the wrong app.
  const key = [tok, kind, forceSafe ? "safe" : "exact", url.searchParams.get("raw") === "1" ? "raw" : "auto"].join("|");
  const hit = _cache.get(key);

  // Token state is read on EVERY request, before the cache is consulted, because a
  // revoked customer must stop within one refresh — not within five minutes. Only
  // the expensive upstream fetch is memoised (see the hub's getDecoded, same rule).
  let supplierUrl = null;
  let storeErr = "";
  try { supplierUrl = await store.resolve(tok); } catch (e) { storeErr = scrub(null, (e && e.message) || String(e)); }
  if (!supplierUrl) {
    // Two different noes, and the customer-facing wording must not conflate them:
    // the store being unreachable is our problem (serve what we have), an unknown
    // or revoked token is the customer's (stop).
    if (storeErr && hit && Date.now() - hit.t < STALE_MAX_MS) {
      _staleServed++;
      return { ...hit.d, fromCache: true, staleAge: Math.round((Date.now() - hit.t) / 1000), note: "token-store-unreachable" };
    }
    const err = new Error(storeErr
      ? "link store unreachable (" + storeErr + ") — no cached profile for this link yet"
      : "unknown or revoked link");
    err.status = storeErr ? 503 : 410;
    throw err;
  }
  if (hit && Date.now() - hit.t < TTL) return { ...hit.d, fromCache: true };

  return once(key, async () => {
    if (isLoopback(supplierUrl, [url.host, hubBase])) {
      const err = new Error("this link's upstream is itself a converter (" + new URL(supplierUrl).host +
        ") — that is a loop, not a supplier. Point this row at the supplier panel URL in the hub dashboard.");
      err.status = 422;
      err.self_referential = true;
      throw err;
    }

    const tried = [];

    // ---- 1. exact ----------------------------------------------------------
    if (!forceSafe) {
      const target = url.searchParams.get("raw") === "1"
        ? String(supplierUrl)
        : (kind === "yaml" ? clashYamlUrl(supplierUrl) : String(supplierUrl));
      const r = await grab(target, FETCH_BUDGET_MS, request);
      const usable = r.ok && (kind === "yaml" ? isUsableProfile(r.text) : isUsableList(r.text));
      if (usable) {
        const d = {
          mode: "exact",
          bytes: r.bytes,
          sha: await sha256(r.bytes),
          contentType: (r.headers && r.headers.get("content-type"))
            || (kind === "yaml" ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8"),
          passthrough: pickHeaders(r.headers),
          nodes: countNames(r.text),
          ms: r.ms,
          tried,
        };
        _cache.set(key, { t: Date.now(), d });
        return d;
      }
      tried.push({
        mode: "exact",
        status: r.status || 0,
        ms: r.ms || 0,
        throttled: isThrottleResponse(r.status, r.text || r.error || ""),
        reason: r.ok
          ? "not a usable " + (kind === "yaml" ? "mihomo profile" : "node list")
          : (r.error || ("upstream answered HTTP " + r.status)),
      });
    }

    // ---- 2. safe: the hub's rebuilt profile --------------------------------
    if (strict) {
      const err = new Error(tried.length ? scrub(supplierUrl, tried[0].reason) : "exact mode only, and no cached profile to serve");
      err.status = 502;
      err.tried = tried;
      throw err;
    }
    const hubUrl = hubRequestUrl(hubBase, url, kind, tok);
    const hr = await grab(hubUrl, HUB_BUDGET_MS, request);
    const hUsable = hr.ok && (kind === "yaml" ? isUsableProfile(hr.text) : isUsableList(hr.text));
    if (hUsable) {
      const d = {
        mode: "safe",
        bytes: hr.bytes,
        sha: await sha256(hr.bytes),
        contentType: (hr.headers && hr.headers.get("content-type"))
          || (kind === "yaml" ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8"),
        passthrough: pickHeaders(hr.headers),
        nodes: countNames(hr.text),
        ms: hr.ms,
        // What went wrong upstream is the interesting half of a fallback: it is
        // how a support reply says "the panel was throttling us" instead of
        // "your link is broken".
        note: tried.length ? (tried[0].throttled ? "exact-throttled" : "exact-unusable") : "forced-by-profile-param",
        tried,
      };
      _cache.set(key, { t: Date.now(), d });
      return d;
    }

    // ---- 3. both hops failed: serve what we have, or say exactly why --------
    if (hit) {
      _staleServed++;
      return { ...hit.d, staleAge: Math.round((Date.now() - hit.t) / 1000), note: "stale-cache-both-hops-failed", tried };
    }
    const err = new Error("supplier: " + scrub(supplierUrl, (tried[0] && tried[0].reason) || "not attempted") +
      "; hub: " + scrub(hubBase, hr.ok ? "answered something this client cannot use (HTTP " + hr.status + ")" : (hr.error || "HTTP " + hr.status)));
    err.status = 503;
    err.throttled = !!(tried[0] && tried[0].throttled);
    err.tried = tried;
    throw err;
  });
}

function bytesResponse(d) {
  const h = new Headers({
    "Content-Type": d.contentType,
    // no-store on everything: function responses here are cached by PATH with the
    // query stripped, so `/all/SP VPN` is ONE entry for every customer. Serving
    // customer B customer A's file is the worst failure mode a subscription
    // converter can have — the token is in the query on the hub-compatible routes.
    "Cache-Control": "no-store",
    "X-SPVPN-Mode": d.mode,
    "X-SPVPN-Version": VERSION,
    "X-SPVPN-Profile": d.mode === "exact" ? "supplier-bytes" : "hub-profile",
  });
  for (const k of PASS_HEADERS) if (d.passthrough && d.passthrough[k]) h.set(k, d.passthrough[k]);
  if (d.note) h.set("X-SPVPN-Fallback", String(d.note).slice(0, 120));
  // `typeof`, not truthiness: an entry can be seconds old, and "we served a
  // cached file because the store was down" is exactly the fact you want to see
  // in the response when it happens — including when the age rounds to 0.
  if (typeof d.staleAge === "number") h.set("X-SPVPN-Stale", String(d.staleAge) + "s");
  if (d.sha) h.set("X-SPVPN-Content-Sha256", String(d.sha).slice(0, 16));
  return new Response(d.bytes, { status: 200, headers: h });
}

const LANDING = (host, hubBase) => `<!doctype html>
<meta charset="utf-8">
<title>SP VPN · exact passthrough ${VERSION}</title>
<style>
 body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e8eaed;margin:0;padding:32px 20px}
 .w{max-width:46rem;margin:0 auto}
 code{background:#171a1f;padding:2px 6px;border-radius:5px;font-size:.9em;word-break:break-all}
 .c{background:#12151a;border:1px solid #23272e;border-radius:10px;padding:14px 16px;margin:14px 0}
 a{color:#79b8ff}
 .m{color:#9aa0a6;font-size:.9rem}
</style>
<div class="w">
  <h1>SP-V1 · exact</h1>
  <p>Version <code>${VERSION}</code>. This host converts nothing: it downloads your
  supplier's own subscription and hands your app those bytes, so nodes, pings,
  groups, DNS and rules are identical to the supplier's link.</p>

  <div class="c">
    <b>Link to give a customer</b><br>
    <code>https://${host}/e/&lt;token&gt;</code><br>
    <span class="m">Format is chosen from the app's User-Agent, exactly as the hub does
    it. Force one with <code>.yaml</code>, <code>?fmt=yaml</code> or <code>?fmt=sr</code>.
    Hub-shaped links keep working: <code>/all/SP VPN?t=&lt;token&gt;</code>,
    <code>/sub/&lt;token&gt;</code>, <code>/share/&lt;token&gt;</code>.</span>
  </div>

  <div class="c">
    <b>Two modes</b><br>
    <code>exact</code> (default) — the supplier's bytes, verbatim. Falls back to
    <code>safe</code> if the panel refuses or returns something unusable.<br>
    <code>?profile=safe</code> — the rebuilt profile from
    <code>${hubBase.replace(/^https?:\/\//, "")}</code>, for apps that need geo-free DNS
    and no geodata download.<br>
    <code>?fallback=0</code> — never fall back; the way to prove which mode answered.
  </div>

  <p class="m"><a href="/healthz">/healthz</a> · <a href="/diag?t=&lt;token&gt;">/diag?t=…</a>
  · <a href="/admin/verify?t=&lt;token&gt;">/admin/verify?t=…</a> — byte-diff of what we
  serve against what the supplier serves</p>
</div>`;

// ============================================================================
export default {
  async fetch(request, env = {}) {
    let url;
    try { url = new URL(request.url); } catch (e) { return plain("bad request", 400); }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try { store.backend(env); } catch (e) { /* the store falls back to process.env */ }
    const hubBase = env.HUB_BASE_URL || DEFAULT_HUB;

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(LANDING(url.host, hubBase), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-SPVPN-Version": VERSION },
        });
      }
      if (path === "/healthz" || path === "/health") return await healthz(url, request, env, hubBase);

      if (path === "/diag") {
        const tok = url.searchParams.get("t") || "";
        if (!tok) return plain("usage: /diag?t=<token>[&kind=raw]", 400);
        return await diag(request, env, hubBase, tok, url);
      }
      if (path === "/admin/verify" || path === "/verify") {
        const tok = url.searchParams.get("t") || "";
        if (!tok) return plain("usage: /admin/verify?t=<token>[&kind=raw][&v=<bust>]", 400);
        return await verify(request, env, hubBase, tok, url);
      }

      // ------------------------------------------------------ customer routes --
      let tok = "";
      let kind = "raw";
      let m;
      const neg = (seg, forced) => (forced || wantsClashYaml({
        fmt: url.searchParams.get("fmt") || "",
        ua: request.headers.get("user-agent") || "",
        accept: request.headers.get("accept") || "",
        ext: seg,
      })) ? "yaml" : "raw";

      if ((m = path.match(/^\/e\/([^/]+)$/))) {
        const seg = splitExt(safeDecode(m[1]));
        tok = seg.name;
        kind = neg(seg.ext);
      } else if ((m = path.match(/^\/all\/([^/?]*)$/))) { // * not +: an empty brand must fall back, not 404
        tok = url.searchParams.get("t") || "";
        const seg = splitExt(safeDecode(m[1]));
        kind = neg(seg.ext);
      } else if ((m = path.match(/^\/sub\/([^/]+)$/))) {
        // /sub is an auto-update URL: always YAML. A pasted `.yaml` suffix must be
        // stripped before the store lookup or the token would be "<tok>.yaml".
        tok = splitExt(safeDecode(m[1])).name;
        kind = "yaml";
      } else if ((m = path.match(/^\/share\/([^/]+)$/))) {
        tok = splitExt(safeDecode(m[1])).name; // a shared link is always the node list
        kind = "raw";
      } else if ((m = path.match(/^\/q\/([^/]+)$/))) {
        const r = await resolveBytes({ tok: safeDecode(m[1]), kind: "raw", url, request, env });
        const text = new TextDecoder("utf-8").decode(r.bytes);
        const find = (s) => s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("STATUS="));
        const line = find(text) || find(tryDecodeB64(text)) || "(the supplier sent no status line)";
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>quota</title>` +
          `<body style="font:16px/1.7 ui-monospace,monospace;background:#0b0d10;color:#e8eaed;padding:28px">` +
          `<div>${line.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</div>` +
          `<div style="color:#9aa0a6;margin-top:14px">mode ${r.mode} · ${r.bytes.byteLength} bytes · ${VERSION}` +
          (r.staleAge ? ` · cached ${r.staleAge}s` : (r.fromCache ? " · from cache" : "")) +
          `</div></body>`,
          { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      } else {
        return plain("not found — see / for the link format", 404);
      }
      if (!tok) return plain("missing token", 400);
      return bytesResponse(await resolveBytes({ tok, kind, url, request, env }));
    } catch (e) {
      const status = e && e.status ? e.status : 502;
      const body = { ok: false, error: scrub(null, (e && e.message) || String(e)), version: VERSION };
      if (e && e.self_referential) body.self_referential = true;
      if (e && e.throttled) body.throttled = true;
      if (e && e.tried) body.tried = e.tried.map((t) => ({ ...t, reason: scrub(null, t.reason) }));
      // An app shows "update failed" whatever we return; the JSON body is for the
      // dashboard and whoever has the network tab open, and it names the hop.
      return json(body, status);
    }
  },
};

// ------------------------------------------------------------------ /healthz ----
let _health = { t: 0, report: null };
async function healthz(url, request, env, hubBase) {
  if (url.searchParams.get("force") !== "1" && _health.report && Date.now() - _health.t < HEALTH_TTL_MS) {
    return json({ ..._health.report, cached_ms: Date.now() - _health.t });
  }
  const report = {
    ok: false,
    version: VERSION,
    mode_default: "exact",
    note: "exact = the supplier's own bytes, verbatim; ?profile=safe = the hub's rebuilt profile",
    checks: { store: null, supplier: null, hub: null },
  };
  let tok = url.searchParams.get("t") || "";
  try {
    if (!tok) {
      const rows = (await store.listAll()).filter((r) => !r.revoked);
      rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      tok = rows.length ? rows[0].token : "";
    }
    report.checks.store = { ok: true, note: tok ? "reachable" : "reachable, no links minted yet" };
  } catch (e) {
    report.checks.store = { ok: false, error: scrub(null, (e && e.message) || String(e)) };
  }
  if (tok) {
    try {
      const d = await resolveBytes({
        tok, kind: "yaml",
        url: new URL("https://" + url.host + "/e/x?fmt=yaml"),
        request, env,
      });
      report.checks.supplier = {
        ok: true, mode: d.mode, bytes: d.bytes.byteLength, nodes: d.nodes, ms: d.ms,
        from_cache: !!d.fromCache, stale_age_s: d.staleAge || 0,
        ...(d.note ? { fallback: d.note } : {}),
      };
    } catch (e) {
      report.checks.supplier = { ok: false, error: scrub(null, (e && e.message) || String(e)), throttled: !!e.throttled };
    }
    // Is the fallback hop alive? If it is not, `?profile=safe` cannot rescue
    // anything — and that has to be visible before a customer needs it.
    try {
      const h = await grab(hubBase + "/healthz", HUB_BUDGET_MS, request);
      report.checks.hub = { ok: h.ok, status: h.status, ms: h.ms, host: String(hubBase).replace(/^https?:\/\//, "") };
    } catch (e) {
      report.checks.hub = { ok: false, error: scrub(null, (e && e.message) || String(e)) };
    }
  } else {
    report.checks.supplier = { ok: false, skipped: "no active customer links yet" };
    report.checks.hub = { ok: true, skipped: "no active customer links yet" };
  }
  report.cache = cacheState();
  const c = report.checks;
  report.ok = !!(c.store && c.store.ok && c.supplier && c.supplier.ok);
  report.level = !(c.supplier && c.supplier.ok) ? "down" : !(c.hub && c.hub.ok) ? "degraded" : "ok";
  report.note = "supplier.ok proves this host can reach the panel and get a profile a client can import. VPN traffic never flows through here — the file is downloaded once, so this server cannot slow a node down.";
  _health = { t: Date.now(), report };
  return json(report);
}

// --------------------------------------------------------------------- /diag ----
async function diag(request, env, hubBase, tok, url) {
  const out = { version: VERSION, mode_requested: String(url.searchParams.get("profile") || "exact (default)") };
  const kind = url.searchParams.get("kind") === "raw" ? "raw" : "yaml";
  try {
    const d = await resolveBytes({ tok, kind, url, request, env });
    const text = new TextDecoder("utf-8").decode(d.bytes);
    out.ok = true;
    out.served = {
      mode: d.mode, bytes: d.bytes.byteLength, sha256: d.sha, nodes: d.nodes,
      lines: text.split(/\r?\n/).length, ms: d.ms, from_cache: !!d.fromCache,
      stale_age_s: d.staleAge || 0, fallback: d.note || null,
      rules: kind === "yaml" ? countRules(text) : 0,
      content_type: d.contentType,
      passthrough_headers: Object.keys(d.passthrough || {}),
      // First lines only: enough to see WHICH config the app is getting (its own
      // group names, its own dns block) without putting node credentials into a
      // diagnostic endpoint.
      head: kind === "yaml" ? text.split(/\r?\n/).slice(0, 12) : [text.slice(0, 60) + "…"],
    };
    if (d.tried && d.tried.length) out.exact_attempt = d.tried.map((t) => ({ ...t, reason: scrub(null, t.reason) }));
  } catch (e) {
    out.ok = false;
    out.error = scrub(null, (e && e.message) || String(e));
    if (e.self_referential) out.self_referential = true;
    if (e.throttled) out.throttled = true;
    if (e.tried) out.tried = e.tried.map((t) => ({ ...t, reason: scrub(null, t.reason) }));
  }
  try {
    const sup = await store.resolve(tok);
    if (sup) {
      out.supplier = {
        host: new URL(sup).host,
        yaml_url_params: [...new URL(clashYamlUrl(sup)).searchParams.keys()].sort(),
        token: "[scrubbed]",
      };
      out.loopback = isLoopback(sup, [url.host, hubBase]);
    }
  } catch (e) { out.supplier = { error: scrub(null, (e && e.message) || String(e)) }; }
  // Report the path the RESCUE hop would use for this customer, not /diag itself:
  // what an owner wants to see here is "safe mode = this token, on the hub".
  out.hub_fallback_path = hubRequestUrl(hubBase, new URL("https://" + url.host + "/e/" + tok), kind, tok)
    .replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  out.cache = cacheState();
  return json(out, out.ok ? 200 : 502);
}

// -------------------------------------------------------------- /admin/verify --
// The question this repo exists to answer, answerable against production: are the
// bytes an app gets from here byte-identical to the bytes the supplier sends that
// same app? Two independent fetches, compared — not a self-report.
async function verify(request, env, hubBase, tok, url) {
  const kind = url.searchParams.get("kind") === "raw" ? "raw" : "yaml";
  const supplierUrl = await store.resolve(tok).catch(() => null);
  if (!supplierUrl) return json({ ok: false, error: "unknown or revoked link" }, 410);
  const target = kind === "yaml" ? clashYamlUrl(supplierUrl) : String(supplierUrl);
  // What the app would receive: fetched through our own PUBLIC url, so the edge,
  // the headers and the mode negotiation are all in the loop. `&v=` is the owner's
  // cache-buster, because function responses here are cached by path.
  const bust = url.searchParams.get("v") ? "&v=" + encodeURIComponent(url.searchParams.get("v")) : "";
  const selfUrl = kind === "yaml"
    ? `https://${url.host}/all/SP%20VPN?fmt=yaml&t=${encodeURIComponent(tok)}${bust}`
    : `https://${url.host}/share/${encodeURIComponent(tok)}${bust ? bust.replace("&", "?") : ""}`;
  const [ours, theirs] = await Promise.all([
    grab(selfUrl, FETCH_BUDGET_MS, request),
    grab(target, FETCH_BUDGET_MS, request),
  ]);
  const a = ours.bytes || new Uint8Array(0);
  const b = theirs.bytes || new Uint8Array(0);
  let firstDiff = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { firstDiff = i; break; } }
  const identical = ours.ok && theirs.ok && a.length === b.length && firstDiff === -1 && a.length > 0;
  const out = {
    identical,
    kind,
    version: VERSION,
    bytes: { served: a.length, supplier: b.length, delta: a.length - b.length },
    sha256: { served: await sha256(a), supplier: await sha256(b) },
    first_diff_offset: firstDiff,
    fetched: {
      served: { ok: ours.ok, status: ours.status, ms: ours.ms },
      supplier: { ok: theirs.ok, status: theirs.status, ms: theirs.ms },
    },
    nodes: { served: countNames(new TextDecoder().decode(a)), supplier: countNames(new TextDecoder().decode(b)) },
    served_mode: (ours.headers && ours.headers.get("x-spvpn-mode")) || null,
    supplier_host: new URL(supplierUrl).host,
    verdict: identical
      ? "✅ byte-identical to the supplier's own response for this client — same file, so the same nodes, the same pings, the same rules"
      : (theirs.ok
        ? "⚠️ served bytes differ from the supplier's. Check served_mode: a safe-mode fallback is a rebuilt profile and WILL differ — that is what the fallback is for."
        : "⚠️ the supplier fetch failed, so nothing could be compared"),
    note: "Two independent fetches of the same subscription, compared byte by byte. VPN traffic never passes through either converter; this only proves the file is not altered.",
  };
  if (!identical && firstDiff >= 0) {
    const from = (buf) => new TextDecoder().decode(buf.slice(Math.max(0, firstDiff - 60), firstDiff + 60));
    out.around_first_diff = { served: from(a), supplier: from(b) };
  }
  return json(out, 200);
}
