#!/usr/bin/env node
// ============================================================================
// SP-V1 — prove it in production.
//
//   node bin/verify-live.mjs https://your-site.netlify.app <customer-token> [--raw]
//
// Three questions, answered by the deployed site rather than by this repo:
//
//   /healthz         is this build alive, which mode is the default, and is the
//                    fallback hop (the hub) reachable?
//   /diag?t=         which document would this customer get, from where, how big,
//                    and did a fallback fire?
//   /admin/verify?t= THE claim: our own public response, fetched the way an app
//                    fetches it, diffed byte-by-byte against the supplier's own
//                    response for the same client. `identical: true` is the only
//                    answer that matters; anything else prints the offset and a
//                    window around it.
//
// `&v=<timestamp>` is appended to defeat the edge cache (function responses here
// are cached by path, so re-running the same URL can legitimately return a
// cached body).
// ============================================================================
const [HOST_ARG, TOK_ARG, ...FLAGS] = process.argv.slice(2);
const HOST = (HOST_ARG || "").replace(/\/+$/, "");
const TOK = TOK_ARG || "";
const KIND = FLAGS.includes("--raw") ? "raw" : "yaml";
const BRANCH_ONLY = FLAGS.includes("--no-fallback");

if (!/^https:\/\/[a-z0-9.-]+\.netlify\.app$/i.test(HOST) || !TOK) {
  console.error("usage: node bin/verify-live.mjs https://<site>.netlify.app <token> [--raw] [--no-fallback]");
  process.exit(2);
}
const bust = Date.now().toString(36);
let failed = 0;
const line = (ok, msg) => { console.log((ok ? "  ✅ " : "  ❌ ") + msg); if (!ok) failed++; };

const get = async (path) => {
  const res = await fetch(HOST + path, { headers: { "Cache-Control": "no-cache" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* an HTML/YAML body is fine here */ }
  return { status: res.status, headers: res.headers, text, json };
};

console.log(`\nSP-V1 live check → ${HOST}  (kind: ${KIND})\n`);

const h = await get("/healthz?force=1&v=" + bust);
line(h.status === 200, `/healthz answers (${h.status})`);
line(!!h.json, "/healthz is JSON — if this is HTML you are looking at a cached or mis-routed response");
if (h.json) {
  line(h.json.version === "v1.0", `version ${h.json.version}${h.json.version === "v1.0" ? "" : " — this is NOT the v1.0 build"}`);
  line(h.json.mode_default === "exact", `default mode: ${h.json.mode_default}`);
  line(!!h.json.checks?.store?.ok, "token store reachable");
  line(!!h.json.checks?.supplier?.ok, `supplier fetch ok (mode ${h.json.checks?.supplier?.mode}, ${h.json.checks?.supplier?.bytes} bytes, ${h.json.checks?.supplier?.ms}ms)`);
  const hub = h.json.checks?.hub;
  if (hub && hub.ok === false) {
    console.log("  ⚠️  the hub fallback hop is unreachable — ?profile=safe cannot rescue anything until HUB_BASE_URL is right");
  } else {
    line(!!hub?.ok, "fallback hop (the hub) reachable");
  }
  if (h.json.cache?.stale_served) {
    console.log(`  ℹ️  ${h.json.cache.stale_served} request(s) so far were served from a stale cache while an upstream failed`);
  }
}

const d = await get(`/diag?t=${encodeURIComponent(TOK)}&kind=${KIND}&v=${bust}`);
line(d.status === 200 || d.status === 502, `/diag answers (${d.status})`);
if (d.json && d.json.served) {
  line(d.json.served.mode === "exact" || BRANCH_ONLY === false, `served mode: ${d.json.served.mode}${d.json.served.fallback ? " ← fallback: " + d.json.served.fallback : ""}`);
  console.log(`      ${d.json.served.bytes} bytes · ${d.json.served.nodes} names · ${d.json.served.rules} rules · content-type ${d.json.served.content_type}`);
  console.log(`      first line of what an app receives: ${JSON.stringify(d.json.served.head?.[0])}`);
  line(d.json.loopback === false, "the row points at a panel, not at a converter");
  line(d.json.supplier?.token === "[scrubbed]", "the panel token is not echoed by diagnostics");
} else if (d.json) {
  line(false, `diag reported a problem: ${d.json.error}`);
}

const v = await get(`/admin/verify?t=${encodeURIComponent(TOK)}&kind=${KIND}&v=${bust}`);
line(v.status === 200, `/admin/verify answers (${v.status})`);
if (v.json) {
  console.log("");
  line(v.json.identical === true, v.json.verdict);
  console.log(`      served ${v.json.bytes?.served}B (sha ${String(v.json.sha256?.served).slice(0, 12)}) vs supplier ${v.json.bytes?.supplier}B (sha ${String(v.json.sha256?.supplier).slice(0, 12)})`);
  if (!v.json.identical && v.json.first_diff_offset >= 0) {
    console.log(`      first difference at byte ${v.json.first_diff_offset}:`);
    console.log(`        ours:     ${JSON.stringify(v.json.around_first_diff?.served)}`);
    console.log(`        supplier: ${JSON.stringify(v.json.around_first_diff?.supplier)}`);
    console.log(`      served_mode was ${JSON.stringify(v.json.served_mode)} — a safe-mode fallback is a rebuilt profile and WILL differ.`);
  }
}

console.log(failed ? `\n💥 ${failed} check(s) failed — this deployment is not serving the supplier's bytes.\n`
  : `\n🎉 byte-exact in production: ${HOST} serves the supplier's own file.\n`);
process.exit(failed ? 1 : 0);
