// ============================================================================
// LIVE-HTTP SUITE — the other half of the proof.
//
// test/exact.test.mjs drives worker.fetch() with a stubbed global fetch, which is
// the right tool for asserting byte-identity and every failure classification.
// What it CANNOT catch is anything in the layer around the worker: the Request
// built from a real socket, header case, an actual HTTP client parsing our
// response, and a panel that is a real server rather than a stub.
//
// So this file starts three servers on loopback — a panel, a hub, and the app
// itself — and makes a customer's request over real HTTP. The panel answers with a
// document deliberately hostile to a helpful proxy: UTF-8 BOM at byte 0, CRLF
// endings, flow-style YAML, a Chinese group name, a full-width colon inside a node
// name, `flow: ''` and `skip-cert-verify: false`. The assertion is that the bytes
// come back identical, and that everything we are allowed to add is a header.
//
// Run: node test/live-http.test.mjs
// ============================================================================
import http from "node:http";
import crypto from "node:crypto";
import worker, { VERSION, resetCaches, ageCaches } from "../exact-worker.js";
import * as store from "../token-store.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};
const sect = (t) => console.log("\n[" + t + "]");
const eq = (a, b, msg) => ok(a === b, `${msg} (${JSON.stringify(a)}${a === b ? "" : " ≠ " + JSON.stringify(b)})`);

// --------------------------------------------------------------- the panel ----
const YAML = "\uFEFF" + [
  "mixed-port: 7890",
  "allow-lan: false",
  "mode: rule",
  "log-level: info",
  "ipv6: true",
  "external-controller: 127.0.0.1:9090",
  "unified-delay: true",
  "tcp-concurrent: true",
  "dns: { enable: true, ipv6: true, enhanced-mode: fake-ip, fake-ip-range: 198.18.0.1/16, use-hosts: true, respect-rules: true, default-nameserver: [223.5.5.5, 119.29.29.29], nameserver: [223.5.5.5], proxy-server-nameserver: [223.5.5.5], fallback: [1.1.1.1, 8.8.8.8], fallback-filter: { geoip: true, geoip-code: CN, geosite: [gfw], ipcidr: [240.0.0.0/4] } }",
  "proxies:",
  "- { name: 剩余流量：511.78 GB, type: vless, server: chuixuevl1.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: xtls-rprx-vision, servername: updates.cdn-apple.com, client-fingerprint: safari, reality-opts: { public-key: 70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4, short-id: 3191b53b }, network: tcp }",
  "- { name: 🇯🇵日本•移联01, type: vless, server: chuixuevl1.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: xtls-rprx-vision, servername: updates.cdn-apple.com, client-fingerprint: safari, reality-opts: { public-key: 70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4, short-id: 3191b53b }, network: tcp }",
  "- { name: 🇯🇵日本•电信01, type: vless, server: chuixuecf.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: '', client-fingerprint: ios, servername: vipjp1.panel.top, network: ws, ws-opts: { path: /chuixue/jp1, headers: { Host: vipjp1.panel.top } } }",
  "proxy-groups:",
  "- { name: 吹雪云, type: select, proxies: [自动选择, 故障转移, 剩余流量：511.78 GB, 🇯🇵日本•移联01, 🇯🇵日本•电信01] }",
  "- { name: 自动选择, type: url-test, proxies: [剩余流量：511.78 GB, 🇯🇵日本•移联01, 🇯🇵日本•电信01], url: 'http://www.gstatic.com/generate_204', interval: 86400 }",
  "- { name: 故障转移, type: fallback, proxies: [🇯🇵日本•移联01, 🇯🇵日本•电信01], url: 'http://www.gstatic.com/generate_204', interval: 7200 }",
  "rules:",
  "- 'IP-CIDR,1.1.1.1/32,吹雪云,no-resolve'",
  "- 'DOMAIN-SUFFIX,cn,DIRECT'",
  "- 'DOMAIN-KEYWORD,-cn,DIRECT'",
  "- 'GEOIP,CN,DIRECT'",
  "- 'MATCH,吹雪云'",
].join("\r\n") + "\r\n";
const YAML_BYTES = Buffer.from(YAML, "utf8");
const LIST = "STATUS=🚀↑:0.11GB,↓:0.12GB,TOT:512GB💡Expires:2026-12-10\r\n" + [
  "vless://b06658de-1b44-4fad-8a2c-c1c7ca29f112@chuixuevl1.panel.test:443?encryption=none&security=reality&type=tcp#n1",
  "vless://b06658de-1b44-4fad-8a2c-c1c7ca29f112@chuixuecf.panel.test:443?encryption=none&security=tls&type=ws#n2",
].join("\r\n") + "\r\n";
const LIST_B64 = Buffer.from(LIST, "utf8").toString("base64");

const state = { panel: "yaml", hub: "up" };
const log = { panel: [], hub: [] };

const serve = (name, port, handler) => {
  const s = http.createServer(handler);
  s.keepAliveTimeout = 0;   // otherwise the process lingers 5s after the test ends
  return new Promise((resolve) => s.listen(port, "127.0.0.1", () => resolve(s)));
};

const panelRes = (res, body, extra = {}) => {
  res.writeHead(200, { "Content-Type": "application/yaml", "subscription-userinfo": "upload=11&download=22&total=33&expire=44", ...extra });
  res.end(body);
};
const panelSrv = await serve("panel", 8799, (req, res) => {
  log.panel.push({ url: req.url, ua: req.headers["user-agent"] || "" });
  if (state.panel === "challenge") {
    res.writeHead(503, { "Content-Type": "text/html" });
    return res.end("<html><head><title>Attention Required!</title></head><body>Just a moment...</body></html>");
  }
  if (state.panel === "list") return panelRes(res, LIST_B64, { "Content-Type": "text/plain; charset=utf-8" });
  panelRes(res, YAML_BYTES);
});
// A stand-in for the hub: whatever it returns must arrive untouched too, because
// `safe` is a proxy, not a rewrite either.
const HUB_DOC = "# SP VPN — generated for your account\nmixed-port: 7890\nproxies:\n- name: \"🇯🇵Japan•Mobile01\"\nproxy-groups:\n- name: \"🚀 SP VPN\"\nrules:\n- MATCH,🚀 SP VPN\n";
const hubSrv = await serve("hub", 8798, (req, res) => {
  log.hub.push({ url: req.url, ua: req.headers["user-agent"] || "" });
  if (state.hub === "down") { res.writeHead(500); return res.end("nope"); }
  res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8", "X-SPVPN-Mode": "safe" });
  res.end(HUB_DOC);
});
// The app itself, behind a real HTTP server — the same shape as
// netlify/functions/index.js, on the same fetch(request, env, ctx) contract.
const appSrv = await serve("app", 8800, async (req, res) => {
  const request = new Request(`http://127.0.0.1:8800${req.url}`, { method: req.method, headers: new Headers(req.headers) });
  const r = await worker.fetch(request, { HUB_BASE_URL: "http://127.0.0.1:8798" }, {});
  const body = Buffer.from(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(body);
});

store.setBackend(new store.MemoryBackend());
await store.ensureInit();
const PANEL_SECRET = "panelsecret-do-not-leak-123";
const TOK = await store.mint(`http://127.0.0.1:8799/api/v1/chuixue?token=${PANEL_SECRET}`, "live");
const APP = "http://127.0.0.1:8800";
const get = async (path, headers = {}) => {
  const r = await fetch(APP + path, { headers });
  return { r, bytes: Buffer.from(await r.arrayBuffer()) };
};

// ============================================================================
sect("1. exact mode over a real socket, against a real panel");
{
  resetCaches();
  const { r, bytes } = await get(`/e/${TOK}`, { "User-Agent": "clash-verge/v1.7.7" });
  eq(r.status, 200, "200 through the whole stack (function wrapper, Request, fetch, panel)");
  eq(Buffer.compare(bytes, YAML_BYTES), 0, "served bytes === panel bytes, sha-for-sha (" + bytes.length + "B)");
  eq(crypto.createHash("sha256").update(bytes).digest("hex"), crypto.createHash("sha256").update(YAML_BYTES).digest("hex"), "…and the sha256 agrees, which is what /admin/verify reports");
  eq(bytes[0], 0xef, "byte 0 is the BOM's first octet (EF) — nobody 'cleaned' the file");
  eq(bytes[1], 0xbb, "byte 1 BB");
  eq(bytes[2], 0xbf, "byte 2 BF");
  ok(bytes.slice(-2).toString("hex") === "0d0a", "the trailing CRLF survived (a .trim() would have eaten it)");
  const txt = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  ok(txt.includes("剩余流量：511.78 GB"), "the supplier's own quota pseudo-node, full-width colon and all");
  ok(txt.includes("🇯🇵日本•移联01"), "their node names, unrebranded");
  ok(txt.includes("name: 吹雪云"), "their group name, untranslated");
  ok(txt.includes("223.5.5.5"), "their CN resolvers, because that is what their customers get");
  ok(txt.includes("external-controller: 127.0.0.1:9090"), "their local control API, kept");
  ok(txt.includes("GEOIP,CN,DIRECT") && txt.includes("MATCH,吹雪云"), "their rules, ending in their group");
  ok(txt.includes("skip-cert-verify: false") && txt.includes("flow: ''"), "the two fields a rebuilder 'forgets'");
  ok(!txt.includes("# SP VPN"), "not one byte of our own text was inserted");
  eq(r.headers.get("x-spvpn-mode"), "exact", "X-SPVPN-Mode: exact");
  eq(r.headers.get("x-spvpn-version"), VERSION, "X-SPVPN-Version: " + VERSION);
  eq(r.headers.get("x-spvpn-profile"), "supplier-bytes", "X-SPVPN-Profile: supplier-bytes");
  eq(r.headers.get("cache-control"), "no-store", "no-store, on every response");
  eq(r.headers.get("subscription-userinfo"), "upload=11&download=22&total=33&expire=44", "their quota header forwarded, verbatim");
  eq(r.headers.get("content-type"), "application/yaml", "their Content-Type, not ours");
  eq(log.panel.length, 1, "exactly one panel fetch: " + log.panel.length);
  ok(log.panel[0].url.includes("type=clash") && log.panel[0].url.includes("flag=meta"), "the panel was asked for its YAML variant — " + log.panel[0].url.slice(0, 42) + "…");
  eq(log.panel[0].ua, "clash-verge/v1.7.7", "the client's User-Agent reached the panel untouched (that is the format switch)");
  eq(log.hub.length, 0, "the hub was never contacted");
}

// ============================================================================
sect("2. the node list, for a client that does not speak YAML");
{
  resetCaches();
  state.panel = "list";
  log.panel.length = 0;
  const { r, bytes } = await get(`/e/${TOK}`, { "User-Agent": "Shadowrocket/2.2.32" });
  eq(bytes.toString("utf8").trim(), LIST_B64.trim(), "the base64 list is the panel's, copied");
  eq(Buffer.compare(bytes, Buffer.from(LIST_B64, "utf8")), 0, "byte-identical, no re-wrapping at 76 chars");
  ok(!log.panel[0].url.includes("flag=meta"), "a list client is NOT redirected to the YAML endpoint: " + log.panel[0].url.slice(0, 40) + "…");
  eq(r.headers.get("x-spvpn-mode"), "exact", "still exact mode");
  const dec = Buffer.from(bytes.toString("utf8").trim(), "base64").toString("utf8");
  ok(dec.includes("STATUS=🚀↑:0.11GB") && dec.includes("Expires:2026-12-10"), "and it decodes to the supplier's own lines, CRLF inside included");

  const q = await get(`/q/${TOK}`);
  ok(q.bytes.toString("utf8").includes("Expires:2026-12-10"), "/q/<token> shows the supplier's status line, unparsed");
}

// ============================================================================
sect("3. the fallback, over HTTP too");
{
  resetCaches();
  state.panel = "challenge"; state.hub = "up";
  log.panel.length = 0; log.hub.length = 0;
  const { r, bytes } = await get(`/e/${TOK}.yaml`, { "User-Agent": "mihomo" });
  eq(r.status, 200, "the customer still gets a subscription while the panel challenges us");
  eq(r.headers.get("x-spvpn-mode"), "safe", "mode: safe");
  eq(r.headers.get("x-spvpn-fallback"), "exact-throttled", "and the body of the failure is a header, not a mystery");
  eq(Buffer.compare(bytes, Buffer.from(HUB_DOC, "utf8")), 0, "the hub's document is forwarded byte-identically too — a proxy in both modes");
  ok(log.hub[0].url.includes("fmt=yaml"), "the hub hop was forced to YAML so it cannot hand a Clash app a base64 list");
  ok(log.hub[0].url.includes("t=" + TOK), "same customer token, hub's own route");

  // A FRESH cache short-circuits before any upstream is touched — that is what
  // keeps a stampede of refreshing apps off a struggling panel, so it is asserted
  // rather than assumed.
  state.panel = "challenge"; state.hub = "down";
  log.panel.length = 0; log.hub.length = 0;
  const warm = await get(`/e/${TOK}.yaml`, { "User-Agent": "mihomo" });
  eq(warm.r.status, 200, "cache still fresh: served without dialling anyone");
  eq(log.panel.length + log.hub.length, 0, "0 upstream fetches, both hops untouched");
  eq(warm.r.headers.get("x-spvpn-fallback"), "exact-throttled", "the cached entry still carries the reason it was built");

  // Now age it past the TTL: the same both-hops-down situation must fall back to
  // the last good file instead of failing, which is the point of a 24 h ceiling.
  eq(ageCaches(), 1, "ageCaches(): 1 entry pushed past its TTL");
  const stale = await get(`/e/${TOK}.yaml`, { "User-Agent": "mihomo" });
  eq(stale.r.status, 200, "panel challenged + hub broken, cache expired = still served");
  ok((stale.r.headers.get("x-spvpn-stale") || "").endsWith("s"), "X-SPVPN-Stale says how old: " + stale.r.headers.get("x-spvpn-stale"));
  eq(stale.r.headers.get("x-spvpn-fallback"), "stale-cache-both-hops-failed", "…and why");
  eq(Buffer.compare(stale.bytes, Buffer.from(HUB_DOC, "utf8")), 0, "the body is the last good document, byte-for-byte");
  eq(log.panel.length, 1, "the panel WAS tried this time, because the cache was stale");

  // With nothing cached, the same situation has to be an honest 503 that names
  // both hops — the failure message is the product when there is no file to give.
  resetCaches();
  const both = await get(`/e/${TOK}.yaml`, { "User-Agent": "mihomo" });
  eq(both.r.status, 503, "cold cache + both hops down = 503, honestly reported");
  const j = JSON.parse(both.bytes.toString("utf8"));
  ok(j.error.includes("supplier:") && j.error.includes("hub:"), "both hops named: " + j.error.slice(0, 70));
  eq(j.throttled, true, "throttled: true — a rate limit, not an outage");
  ok(!j.error.includes(PANEL_SECRET), "and the panel's token is not in it");
}

// ============================================================================
sect("4. the diagnostics, against the same live traffic");
{
  resetCaches();
  state.panel = "yaml"; state.hub = "up";
  const d = await get(`/diag?t=${TOK}`);
  const j = JSON.parse(d.bytes.toString("utf8"));
  eq(j.ok, true, "/diag ok");
  eq(j.served.mode, "exact", "served by exact");
  eq(j.served.bytes, YAML_BYTES.length, "the panel's full " + YAML_BYTES.length + " bytes");
  ok(j.served.head[0].includes("mixed-port: 7890"), "head line 1 is the panel's own (BOM and all)");
  eq(j.supplier.host, "127.0.0.1:8799", "the panel is identified by host only");
  eq(j.supplier.token, "[scrubbed]", "token reported as [scrubbed]");
  ok(!JSON.stringify(j).includes(PANEL_SECRET), "the panel secret appears nowhere in /diag");
  eq(j.loopback, false, "not a loop");

  const v = await get(`/admin/verify?t=${TOK}&v=live`);
  const vj = JSON.parse(v.bytes.toString("utf8"));
  eq(vj.identical, true, "/admin/verify: our public URL and the panel agree byte-for-byte");
  eq(vj.sha256.served, vj.sha256.supplier, "same sha256 on both sides");
  eq(vj.first_diff_offset, -1, "no first difference exists");
  eq(vj.served_mode, "exact", "and it records that exact mode is what proved it");
  ok(vj.verdict.includes("byte-identical"), "verdict: " + vj.verdict.slice(0, 46));

  const h = JSON.parse((await get(`/healthz?force=1`)).bytes.toString("utf8"));
  eq(h.ok, true, "/healthz ok");
  eq(h.level, "ok", "level ok with both hops alive");
  eq(h.checks.supplier.bytes, YAML_BYTES.length, "the probe measured the real file");
  eq(h.checks.hub.ok, true, "the rescue hop is reachable");
  ok(!JSON.stringify(h).includes(PANEL_SECRET), "/healthz leaks nothing either");
}

panelSrv.close(); hubSrv.close(); appSrv.close();
console.log("\n" + "─".repeat(70));
if (failures) {
  console.log(`💥 ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`🎉 ALL ${checks} CHECKS PASSED — byte-exact over real HTTP`);
process.exit(0);
