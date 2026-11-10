// ============================================================================
// SP-V1 — the exact-passthrough converter's whole contract, in one file.
//
// The product claim is a single sentence: what a customer's app downloads from
// this host is BYTE-IDENTICAL to what it downloads from the supplier. So almost
// every check here is a byte comparison against a fixture that is deliberately
// hostile to a helpful proxy — UTF-8 BOM, CRLF line endings, flow-style YAML, a
// group name in Chinese, commas and full-width colons inside node names — and the
// assertion is that none of it changed.
//
// The rest covers the parts a passthrough still has to get right: which of the
// panel's endpoints to ask, what counts as a usable document, which hop failed
// when it fails, the cache, revocation, and never echoing the supplier's token.
//
// Run: node test/exact.test.mjs
// ============================================================================
import worker, {
  VERSION, clashYamlUrl, hubRequestUrl, wantsClashYaml, CLASH_UA_KEYS, splitExt,
  isUsableProfile, isUsableList, isThrottleResponse, isLoopback, scrub,
  resetCaches, cacheState,
} from "../exact-worker.js";
import * as store from "../token-store.js";

let failures = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) failures++;
};
const sect = (t) => console.log("\n[" + t + "]");
const eq = (a, b, msg) => ok(a === b, `${msg} (${JSON.stringify(a)}${a === b ? "" : " ≠ " + JSON.stringify(b)})`);

// --------------------------------------------------------------- fixtures ----
const PANEL_TOKEN = "b1a1cdaf628827722776573ffd8f5e6e";
const SUPPLIER = `https://panel.test/api/v1/chuixue?token=${PANEL_TOKEN}`;
const HUB = "https://hub.test";
const HOST = "x.test";

// A profile shaped like the real 吹雪云 one: BOM, CRLF, flow style, group names
// in Chinese, a full-width colon in a node name, commas inside quoted rules.
const YAML_PROFILE = "\uFEFF" + [
  "mixed-port: 7890",
  "allow-lan: false",
  "mode: rule",
  "log-level: info",
  "external-controller: 127.0.0.1:9090",
  "ipv6: true",
  "dns: { enable: true, ipv6: true, enhanced-mode: fake-ip, fake-ip-range: 198.18.0.1/16, use-hosts: true, respect-rules: true, default-nameserver: [223.5.5.5, 119.29.29.29], nameserver: [223.5.5.5], fallback: [1.1.1.1, 8.8.8.8], fallback-filter: { geoip: true, geoip-code: CN, geosite: [gfw] } }",
  "proxies:",
  "- { name: 剩余流量：511.78 GB, type: vless, server: chuixuevl1.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: xtls-rprx-vision, servername: updates.cdn-apple.com, client-fingerprint: safari, reality-opts: { public-key: 70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4, short-id: 3191b53b }, network: tcp }",
  "- { name: 🇯🇵日本•移联01, type: vless, server: chuixuevl1.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: xtls-rprx-vision, servername: updates.cdn-apple.com, client-fingerprint: safari, reality-opts: { public-key: 70V0gDLKL3niFsNn__9MQhPMCTB_M4kNdbOKNIulii4, short-id: 3191b53b }, network: tcp }",
  "- { name: 🇯🇵日本•电信01, type: vless, server: chuixuecf.panel.test, port: 443, uuid: b06658de-1b44-4fad-8a2c-c1c7ca29f112, udp: true, tls: true, skip-cert-verify: false, flow: '', client-fingerprint: ios, servername: vipjp1.cyberguard-u1s1.top, network: ws, ws-opts: { path: /chuixue/jp1, headers: { Host: vipjp1.cyberguard-u1s1.top } } }",
  "proxy-groups:",
  "- { name: 吹雪云, type: select, proxies: [自动选择, 故障转移, 剩余流量：511.78 GB, 🇯🇵日本•移联01, 🇯🇵日本•电信01] }",
  "- { name: 自动选择, type: url-test, proxies: [剩余流量：511.78 GB, 🇯🇵日本•移联01, 🇯🇵日本•电信01], url: 'http://www.gstatic.com/generate_204', interval: 86400 }",
  "- { name: 故障转移, type: fallback, proxies: [🇯🇵日本•移联01, 🇯🇵日本•电信01], url: 'http://www.gstatic.com/generate_204', interval: 7200 }",
  "rules:",
  "- 'IP-CIDR,1.1.1.1/32,吹雪云,no-resolve'",
  "- 'DOMAIN-SUFFIX,cn,DIRECT'",
  "- 'GEOIP,CN,DIRECT'",
  "- 'MATCH,吹雪云'",
].join("\r\n") + "\r\n";
const YAML_BYTES = Buffer.from(YAML_PROFILE, "utf8");

// What the hub would build instead — same nodes, DIFFERENT document. Used to prove
// the two modes are not secretly the same thing, and to fake a fallback.
const HUB_PROFILE = [
  "# SP VPN — generated for your account (live quota below)",
  "mixed-port: 7890",
  "mode: rule",
  "dns: { enable: true, ipv6: true, enhanced-mode: fake-ip, nameserver: [1.1.1.1, 8.8.8.8, 9.9.9.9] }",
  "proxies:",
  '- name: "🇯🇵Japan•Mobile01"',
  "  type: vless",
  "proxy-groups:",
  '- name: "🚀 SP VPN"',
  "rules:",
  "- MATCH,🚀 SP VPN",
].join("\n") + "\n";

const NODE_LINES = [
  "STATUS=🚀↑:0.11GB,↓:0.12GB,TOT:512GB💡Expires:2026-12-10",
  "vless://b06658de-1b44-4fad-8a2c-c1c7ca29f112@chuixuevl1.panel.test:443?encryption=none&security=reality&type=tcp#%F0%9F%87%AF%E6%97%A5%E6%9C%AC%E2%80%A2%E7%A7%BB%E8%81%9401",
  "vless://b06658de-1b44-4fad-8a2c-c1c7ca29f112@chuixuecf.panel.test:443?encryption=none&security=tls&type=ws#%F0%9F%87%AF%E6%97%A5%E6%9C%AC%E2%80%A2%E7%94%B5%E4%BF%A101",
].join("\r\n") + "\r\n";
const LIST_B64 = Buffer.from(NODE_LINES, "utf8").toString("base64");

const CHALLENGE = "<html><head><title>Attention Required! | Cloudflare</title></head><body>Just a moment...</body></html>";

// ------------------------------------------------------------ the fake world --
const state = {
  panel: "yaml",      // yaml | list | challenge | broken | timeout | down
  hub: "yaml",        // yaml | down
  hubHealth: "ok",    // ok | down
  self: "exact",      // exact (same bytes as the panel) | tamper (a rebuilt doc)
  delayMs: 0,
};
let fetchLog = [];
const hits = (which) => fetchLog.filter((f) => (which === "panel" ? f.url.includes("panel.test")
  : which === "hub" ? f.url.includes("hub.test") && !f.url.includes("/healthz")
  : f.url.includes("x.test"))).length;

const res = (body, init = {}) => new Response(typeof body === "string" ? Buffer.from(body, "utf8") : body, init);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (u, o) => {
  const url = String(u);
  fetchLog.push({ url, ua: (o && o.headers && o.headers["User-Agent"]) || "" });
  if (state.delayMs) await sleep(state.delayMs);

  if (url.includes("hub.test/healthz")) {
    if (state.hubHealth === "down") throw new Error("hub health unreachable");
    return res(JSON.stringify({ ok: true, version: "hub" }), { headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("hub.test/")) {
    if (state.hub === "down") throw new Error("connect ECONNREFUSED hub.test:443");
    return res(HUB_PROFILE, { headers: { "Content-Type": "text/yaml; charset=utf-8" } });
  }
  if (url.includes("x.test/")) {
    // Our own public route, as an app would see it (that is the point of /admin/verify).
    if (state.self === "tamper") {
      return res(HUB_PROFILE, { headers: { "Content-Type": "text/yaml; charset=utf-8", "X-SPVPN-Mode": "safe" } });
    }
    const wantList = url.includes("/share/");
    return res(wantList ? LIST_B64 : YAML_BYTES, {
      headers: { "Content-Type": wantList ? "text/plain; charset=utf-8" : "application/yaml", "X-SPVPN-Mode": "exact" },
    });
  }
  if (url.includes("panel.test")) {
    switch (state.panel) {
      case "challenge": return res(CHALLENGE, { status: 503, headers: { "Content-Type": "text/html" } });
      case "broken": return res('{"error":"no nodes"}', { status: 200, headers: { "Content-Type": "application/json" } });
      case "timeout": throw Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" });
      case "down": throw new Error("fetch failed: socket hang up");
      case "list": return res(LIST_B64, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "subscription-userinfo": "upload=110000000&download=120000000&total=549755813888&expire=1796860800",
        },
      });
      default: return res(YAML_BYTES, {
        status: 200,
        headers: {
          "Content-Type": "application/yaml",
          "subscription-userinfo": "upload=110000000&download=120000000&total=549755813888&expire=1796860800",
        },
      });
    }
  }
  throw new Error("stub fetch got an unexpected URL: " + url);
};

const bodies = [];   // every response body this run produced — swept for leaks at the end
const get = async (path, opts = {}) => {
  const headers = {};
  if (opts.ua) headers["User-Agent"] = opts.ua;
  if (opts.accept) headers["Accept"] = opts.accept;
  for (const [k, v] of Object.entries(opts.headers || {})) headers[k] = v;
  const r = await worker.fetch(new Request(`https://${HOST}${path}`, { headers }), { HUB_BASE_URL: HUB }, {});
  const bytes = new Uint8Array(await r.arrayBuffer());
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const text = dec.decode(bytes);
  bodies.push({ path, status: r.status, bytes, text });
  return { r, bytes, text };
};

let TOK = "";
const freshStore = async () => {
  store.setBackend(new store.MemoryBackend());
  await store.ensureInit();
  resetCaches();
  fetchLog = [];
  state.panel = "yaml"; state.hub = "yaml"; state.hubHealth = "ok"; state.self = "exact"; state.delayMs = 0;
  TOK = await store.mint(SUPPLIER, "tester");
  return TOK;
};

// ============================================================================
sect("1. which URL the panel is asked — the only interpretation in exact mode");
{
  const added = clashYamlUrl(SUPPLIER);
  ok(added.includes("type=clash") && added.includes("flag=meta"), "appends the panel's own YAML switch");
  ok(added.includes("token=" + PANEL_TOKEN), "the customer's panel token is carried over untouched");
  eq(new URL(added).pathname, "/api/v1/chuixue", "path untouched");
  eq(clashYamlUrl(added), added, "idempotent — a stored clash URL is not double-parameterised");
  ok(clashYamlUrl(SUPPLIER + "&type=surge").includes("type=surge"), "an explicit type= from the row wins (we never overwrite the supplier's choice)");
  ok(clashYamlUrl("not a url") === "not a url", "a malformed row passes through rather than throwing");
}

// ============================================================================
sect("2. client negotiation — same table as the hub, on purpose");
{
  const t = (fmt, ua, accept, ext) => wantsClashYaml({ fmt, ua, accept, ext });
  ok(t("", "clash-verge/v1.7.7", "", "") === true, "Clash Verge → YAML");
  ok(t("", "Karing/1.2.34", "", "") === true, "Karing → YAML (it runs the mihomo core and says so only in its UA)");
  ok(t("", "mihomo", "", "") === true, "mihomo → YAML");
  ok(t("", "clashmi/2.0", "", "") === true, "Clash Mi → YAML");
  ok(t("", "Shadowrocket/2.2.32", "", "") === false, "Shadowrocket → node list");
  ok(t("", "curl/8.5.0", "", "") === false, "curl → node list (the safe answer when we cannot tell)");
  ok(t("", "", "application/x-yaml", "") === true, "Accept: yaml → YAML");
  ok(t("sr", "clash-verge/v1.7.7", "", "") === false, "?fmt=sr overrides the UA");
  ok(t("yaml", "curl/8.5.0", "", "") === true, "?fmt=yaml overrides the UA");
  ok(t("", "curl/8.5.0", "", "yaml") === true, "a .yaml suffix overrides the UA");
  ok(CLASH_UA_KEYS.includes("karing") && CLASH_UA_KEYS.includes("stash"), "the UA table still covers the clients that bit us");
  eq(splitExt("SP VPN.yaml").ext, "yaml", "splitExt reads the format suffix");
  eq(splitExt("SP VPN.yaml").name, "SP VPN", "…and strips it from the brand");
}

// ============================================================================
sect("3. what counts as a document, and what counts as a rate limit");
{
  ok(isUsableProfile(YAML_PROFILE), "a real profile is usable");
  ok(!isUsableProfile(CHALLENGE), "a Cloudflare challenge is not");
  ok(!isUsableProfile('{"error":"no nodes"}'), "a JSON error is not");
  ok(!isUsableProfile(""), "an empty body is not");
  ok(!isUsableProfile("proxies:\r\n- { name: x }\r\n"), "proxies with no proxy-groups is a Surge/legacy file, not a mihomo profile");
  ok(isUsableList(LIST_B64), "base64 node list is usable");
  ok(isUsableList(NODE_LINES), "plain node list is usable");
  ok(!isUsableList(CHALLENGE), "an HTML page is not");
  ok(!isUsableList("short"), "noise is not");
  ok(isThrottleResponse(429, ""), "429 is a rate limit, not an outage");
  ok(isThrottleResponse(403, "hi"), "403 ditto");
  ok(isThrottleResponse(503, CHALLENGE), "503 + a challenge page is a rate limit");
  ok(!isThrottleResponse(500, "internal error: bad sql"), "a 500 is NOT a rate limit");
  ok(!isThrottleResponse(200, "x".repeat(5000)), "a long body is not a challenge interstitial");
}

// ============================================================================
sect("4. never leak, never loop");
{
  const msg = `fetch failed for ${SUPPLIER} after 6s`;
  const clean = scrub(SUPPLIER, msg);
  ok(!clean.includes(PANEL_TOKEN), "the panel token does not survive scrub()");
  ok(clean.includes("panel.test"), "the host survives, because that is the useful part");
  ok(!scrub(null, "?t=abc123&x").includes("abc123"), "?t= values are scrubbed too");
  ok(isLoopback("https://hub.test/all/SP VPN?t=" + "a".repeat(48), [HOST, HUB]) === true, "our own hub host + a converter route = a loop");
  ok(isLoopback("https://x.test/sub/" + "a".repeat(48), [HOST, HUB]) === true, "a row pointing at THIS host is a loop");
  ok(isLoopback("https://panel.test/api/v1/chuixue?token=x", [HOST, HUB]) === false, "the panel's own API path is not a loop");
  ok(isLoopback("https://hub.test/api/v1/x?token=y", [HOST, HUB]) === false, "our host with a panel-shaped path is not a loop — a branded domain can serve both");
}

// ============================================================================
sect("5. exact mode serves the supplier's bytes, unchanged");
await freshStore();
{
  const { r, bytes, text } = await get(`/e/${TOK}.yaml`, { ua: "clash-verge/v1.7.7" });
  eq(r.status, 200, "status");
  eq(Buffer.compare(Buffer.from(bytes), YAML_BYTES), 0, "the body is byte-identical to the panel's, BOM and CRLF included");
  ok(text.startsWith("\uFEFF"), "even the UTF-8 BOM survived — nobody 'cleaned' it");
  ok(text.includes("吹雪云"), "the supplier's own group name is in the file, unrebranded");
  ok(text.includes("🇯🇵日本•移联01"), "the supplier's own node names are in the file, unrebranded");
  ok(text.includes("剩余流量：511.78 GB"), "the quota pseudo-node is kept exactly as they spell it");
  ok(!text.includes("# SP VPN"), "not one comment of ours was added");
  ok(!text.includes("SP VPN — generated"), "the hub's generated header is absent");
  ok(text.includes("external-controller: 127.0.0.1:9090"), "their external-controller is served, because it is theirs");
  ok(text.includes("223.5.5.5"), "their CN resolvers are served, because that is what their customers get");
  eq(r.headers.get("cache-control"), "no-store", "no-store — one cached path must never serve two customers");
  eq(r.headers.get("x-spvpn-mode"), "exact", "X-SPVPN-Mode: exact");
  eq(r.headers.get("x-spvpn-version"), VERSION, "X-SPVPN-Version: " + VERSION);
  eq(r.headers.get("x-spvpn-profile"), "supplier-bytes", "X-SPVPN-Profile says the document came from the supplier");
  eq(r.headers.get("content-type"), "application/yaml", "the panel's Content-Type is passed through, not replaced with ours");
  ok((r.headers.get("subscription-userinfo") || "").includes("total=549755813888"), "their quota header reaches the app");
  eq(r.headers.get("x-spvpn-fallback"), null, "no fallback header when exact worked");
  ok(fetchLog[0].url.includes("type=clash"), "the panel was asked for its YAML variant");
  eq(fetchLog[0].ua, "clash-verge/v1.7.7", "the client's own User-Agent was forwarded (that is what selects the format)");
  eq(hits("hub"), 0, "the hub was not contacted at all");
}

// ============================================================================
sect("6. the node list a non-Clash app gets");
await freshStore();
{
  state.panel = "list";
  const { r, text } = await get(`/e/${TOK}`, { ua: "Shadowrocket/2.2.32" });
  eq(r.status, 200, "status");
  eq(text.trim(), LIST_B64.trim(), "the base64 list is the panel's, copied");
  eq(Buffer.compare(Buffer.from(text, "utf8"), Buffer.from(LIST_B64, "utf8")), 0, "byte-identical, no re-wrapping");
  ok(new TextDecoder().decode(Buffer.from(text.trim(), "base64")).includes("vless://b06658de"), "and it still decodes to the supplier's links");
  eq(r.headers.get("x-spvpn-mode"), "exact", "mode exact");
  eq(hits("panel"), 1, "one upstream fetch");
  ok(!fetchLog[0].url.includes("flag=meta"), "a link-list client is NOT sent down the YAML endpoint");

  const share = await get(`/share/${TOK}`);
  ok(share.r.status === 200 && share.text.trim() === LIST_B64.trim(), "/share/<token> is the list too, byte-identical");

  resetCaches();
  const forced = await get(`/e/${TOK}?fmt=sr&raw=1`, { ua: "clash-verge/v1.7.7" });
  ok(forced.r.status === 200 && !fetchLog[fetchLog.length - 1].url.includes("type=clash"), "?raw=1 asks the stored URL exactly as stored");
}

// ============================================================================
sect("7. when exact fails, the fallback says WHY");
await freshStore();
state.panel = "challenge";
{
  const { r, text } = await get(`/e/${TOK}.yaml`, { ua: "mihomo" });
  eq(r.status, 200, "the customer still gets a working subscription");
  eq(r.headers.get("x-spvpn-mode"), "safe", "mode flipped to safe");
  eq(r.headers.get("x-spvpn-profile"), "hub-profile", "and says so in X-SPVPN-Profile");
  eq(r.headers.get("x-spvpn-fallback"), "exact-throttled", "X-SPVPN-Fallback: exact-throttled — a rate limit, not an outage");
  eq(Buffer.compare(Buffer.from(text, "utf8"), Buffer.from(HUB_PROFILE, "utf8")), 0, "the body is the hub's rebuilt profile, itself copied verbatim");
  eq(hits("hub"), 1, "the hub was fetched exactly once for the fallback");
}
{
  let hubPath = "";
  resetCaches(); fetchLog = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes("hub.test/")) hubPath = new URL(String(u)).pathname + new URL(String(u)).search;
    return orig(u, o);
  };
  const { r } = await get(`/e/${TOK}.yaml`, { ua: "mihomo" });
  eq(r.headers.get("x-spvpn-mode"), "safe", "safe mode reached through the rewrite");
  ok(/\/all\/SP(%20| )VPN/.test(hubPath), "…on the hub's own route (" + hubPath.split("?")[0] + ")");
  ok(hubPath.includes("t=" + TOK), "…with the same customer token");
  ok(hubPath.includes("fmt=yaml"), "…and fmt=yaml forced, so the hub cannot negotiate its way into a base64 list for a Clash app");
  globalThis.fetch = orig;
}
{
  await freshStore();
  state.panel = "broken";
  const { r } = await get(`/e/${TOK}.yaml`, { ua: "mihomo" });
  eq(r.headers.get("x-spvpn-fallback"), "exact-unusable", "an HTTP 200 of rubbish is 'unusable', not 'throttled'");
  eq(r.headers.get("x-spvpn-mode"), "safe", "and it still falls back");

  await freshStore();
  state.panel = "timeout";
  const t = await get(`/e/${TOK}.yaml?fallback=0`, { ua: "mihomo" });
  eq(t.r.status, 502, "?fallback=0 refuses to fall back and reports the failure");
  const j = JSON.parse(t.text);
  ok(j.tried[0].reason.includes("did not answer within"), "the reason names the timeout");
  eq(j.throttled, undefined, "and does not invent a rate limit");
  eq(hits("hub"), 0, "strict mode never touches the hub");

  await freshStore();
  state.panel = "down"; state.hub = "down";
  const both = await get(`/e/${TOK}.yaml`, { ua: "mihomo" });
  eq(both.r.status, 503, "both hops down is the only real error");
  const bj = JSON.parse(both.text);
  ok(bj.error.startsWith("supplier: "), "it names the supplier hop first");
  ok(bj.error.includes("hub:"), "…and the hub hop second");
  ok(bj.error.includes("socket hang up") && bj.error.includes("ECONNREFUSED"), "with each hop's own reason");
  ok(!bj.error.includes(PANEL_TOKEN), "and no panel token in the message");

  await freshStore();
  state.panel = "yaml";
  const strictOk = await get(`/e/${TOK}.yaml?profile=exact`, { ua: "mihomo" });
  eq(strictOk.r.headers.get("x-spvpn-mode"), "exact", "profile=exact + a healthy panel = exact");
  ok(strictOk.text.includes("吹雪云"), "byte-exact body again");
}

// ============================================================================
sect("8. forced safe mode: straight to the hub, panel untouched");
await freshStore();
{
  const { r } = await get(`/e/${TOK}.yaml?profile=safe`, { ua: "clash-verge/v1.7.7" });
  eq(r.headers.get("x-spvpn-mode"), "safe", "mode safe");
  eq(r.headers.get("x-spvpn-fallback"), "forced-by-profile-param", "the header says it was chosen, not forced by a failure");
  eq(hits("panel"), 0, "the supplier was not fetched at all");
  eq(hits("hub"), 1, "the hub was fetched once");

  const sub = await get(`/sub/${TOK}?profile=safe`);
  eq(sub.r.status, 200, "/sub works too (auto-update URL)");
  eq(sub.text, HUB_PROFILE, "…with the same document");
  eq(hits("hub"), 1, "served from cache, because the key is token+kind+mode, not the path — /sub and /e/ are the same subscription");
  eq(cacheState().entries, 1, "one cache entry for one customer+mode");
}

// ============================================================================
sect("9. tokens, revocation, and the store being down");
await freshStore();
{
  const unknown = await get(`/e/${"f".repeat(48)}.yaml`);
  eq(unknown.r.status, 410, "an unknown token is 410 Gone");
  ok(JSON.parse(unknown.text).error.includes("unknown or revoked link"), "and says which");
  eq(hits("panel"), 0, "an unknown token never reaches the supplier");

  const warm = await get(`/e/${TOK}.yaml`);
  eq(warm.r.status, 200, "the same token works while it is active");
  eq(hits("panel"), 1, "fetched once while active");
  await store.updateRow(TOK, { revoked: 1 });
  const revoked = await get(`/e/${TOK}.yaml`);
  eq(revoked.r.status, 410, "revocation takes effect immediately, even with a warm 5-minute cache");
  eq(hits("panel"), 1, "…and the cached file is NOT served to a revoked customer");
  await store.updateRow(TOK, { revoked: 0 });
  eq((await get(`/e/${TOK}.yaml`)).r.status, 200, "un-revoking works too (the row is re-read every request)");

  // Store down, nothing cached yet: 503 that names OUR dependency.
  const good = new store.MemoryBackend();
  await good.put({ token: "a".repeat(48), supplier_url: SUPPLIER, label: "x", revoked: false, created_at: new Date().toISOString() });
  store.setBackend(good);
  await store.ensureInit();
  resetCaches();
  store.clearCache();
  store.setBackend({
    init: async () => { throw new Error("no such table"); },
    get: async () => { throw new Error("no such table"); },
    list: async () => { throw new Error("no such table"); },
  });
  const cold = await get(`/e/${"a".repeat(48)}.yaml`);
  eq(cold.r.status, 503, "store unreachable + nothing cached = 503, not a lie about the supplier");
  ok(JSON.parse(cold.text).error.includes("link store unreachable"), "and it names OUR dependency");
  ok(!JSON.parse(cold.text).error.includes("supplier"), "the word 'supplier' is not in it");

  // Store down AFTER a good fetch: the cached file keeps the customer connected.
  store.setBackend(good);
  resetCaches();
  const okAgain = await get(`/e/${"a".repeat(48)}.yaml`);
  eq(okAgain.r.status, 200, "healthy request first, so there is something to fall back on");
  store.clearCache();
  store.setBackend({
    init: async () => { throw new Error("db timeout"); },
    get: async () => { throw new Error("db timeout"); },
    list: async () => { throw new Error("db timeout"); },
  });
  const stale = await get(`/e/${"a".repeat(48)}.yaml`);
  eq(stale.r.status, 200, "store blip: the customer sees nothing");
  eq(stale.r.headers.get("x-spvpn-stale"), "0s", "X-SPVPN-Stale is present even at 0s — a falsy-zero bug we nearly shipped");
  eq(stale.r.headers.get("x-spvpn-fallback"), "token-store-unreachable", "…and the note explains why");
  eq(Buffer.compare(Buffer.from(stale.bytes), YAML_BYTES), 0, "the stale body is the same byte-exact document, not a degraded one");
  ok(cacheState().stale_served >= 1, "and the counter /healthz reports moved");
}

// ============================================================================
sect("10. cache, single-flight, and a loop-back row");
await freshStore();
{
  state.delayMs = 40;
  const burst = await Promise.all(Array.from({ length: 12 }, () => get(`/e/${TOK}.yaml`, { ua: "mihomo" })));
  eq(hits("panel"), 1, "12 simultaneous app refreshes are 1 supplier fetch");
  ok(burst.every((b) => b.r.status === 200), "and all 12 get the file");
  state.delayMs = 0;
  await get(`/e/${TOK}.yaml`, { ua: "mihomo" });
  eq(hits("panel"), 1, "a second wave inside the TTL is served from cache");

  const loopTok = await store.mint(`${HUB}/all/SP VPN?t=${"a".repeat(48)}`, "reseller-loop");
  resetCaches();
  const loop = await get(`/e/${loopTok}.yaml`);
  eq(loop.r.status, 422, "a row whose upstream is the hub itself is refused, not looped");
  eq(JSON.parse(loop.text).self_referential, true, "with the flag the hub's dashboard also uses");
  ok(JSON.parse(loop.text).error.includes("loop"), "and a sentence that says what to fix");
  eq(hits("hub"), 0, "no request was made to the hub");

  resetCaches();
  state.panel = "list";
  const q = await get(`/q/${TOK}`);
  eq(q.r.status, 200, "/q/<token> answers");
  ok(q.text.includes("Expires:2026-12-10"), "…with the supplier's own status line, unparsed");
  ok(q.text.includes("mode exact"), "…and which mode served it");
}

// ============================================================================
sect("11. /healthz — is this deployment alive, and is the fallback alive?");
await freshStore();
{
  const { text } = await get(`/healthz?force=1`);
  const j = JSON.parse(text);
  eq(j.version, VERSION, "version " + VERSION);
  eq(j.ok, true, "ok");
  eq(j.level, "ok", "level ok while both hops answer");
  eq(j.mode_default, "exact", "the default mode is stated");
  eq(j.checks.store.ok, true, "store reachable");
  eq(j.checks.supplier.mode, "exact", "the probe went through exact");
  eq(j.checks.supplier.bytes, YAML_BYTES.length, "and got the supplier's full file: " + j.checks.supplier.bytes + " bytes");
  eq(j.checks.hub.ok, true, "the fallback hop is reachable, so ?profile=safe can actually rescue someone");
  ok(j.note.includes("never flows through"), "and the note says what this endpoint cannot prove about speed");

  await freshStore();
  state.hubHealth = "down";
  const h2 = JSON.parse((await get(`/healthz?force=1`)).text);
  eq(h2.level, "degraded", "hub unreachable = degraded, not ok: the rescue route is down");
  eq(h2.ok, true, "customers are still served, so not 'down'");

  await freshStore();
  state.panel = "challenge"; state.hub = "down";
  const h3 = JSON.parse((await get(`/healthz?force=1`)).text);
  eq(h3.checks.supplier.ok, false, "both hops failing shows in the health report");
  ok(h3.checks.supplier.error.includes("challenge") || h3.checks.supplier.error.includes("503"), "with the reason: " + h3.checks.supplier.error);
}

// ============================================================================
sect("12. /diag — which document is an app getting, and from where");
await freshStore();
{
  const j = JSON.parse((await get(`/diag?t=${TOK}`)).text);
  eq(j.ok, true, "diag ok");
  eq(j.served.mode, "exact", "served.mode");
  eq(j.served.bytes, YAML_BYTES.length, "served.bytes is the panel's size exactly");
  eq(j.served.lines, YAML_PROFILE.split(/\r?\n/).length, "line count matches the panel's file exactly — we added no header line");
  ok(j.served.head[0].includes("mixed-port: 7890"), "head shows the panel's own first line, unedited");
  ok(j.served.head.join("\n").includes("external-controller"), "the customer's file has the panel's keys, and diag proves it without us asserting them");
  ok(j.served.rules > 0, "rules counted: " + j.served.rules);
  ok(j.served.passthrough_headers.includes("subscription-userinfo"), "quota header was passed through");
  eq(j.served.content_type, "application/yaml", "content type came from the panel");
  eq(j.served.fallback, null, "no fallback happened");
  eq(j.supplier.host, "panel.test", "supplier host reported");
  eq(j.supplier.token, "[scrubbed]", "the panel token is never echoed");
  ok(j.supplier.yaml_url_params.includes("type") && j.supplier.yaml_url_params.includes("flag"), "the YAML variant's params are listed by NAME");
  eq(j.loopback, false, "not a loop");
  ok(j.hub_fallback_path.startsWith("/all/"), "the fallback would be " + j.hub_fallback_path);
  ok(!JSON.stringify(j).includes(PANEL_TOKEN), "and the whole report is free of the panel token");

  await freshStore();
  state.panel = "challenge";
  const j2 = JSON.parse((await get(`/diag?t=${TOK}`)).text);
  eq(j2.served.mode, "safe", "diag shows the fallback that happened");
  eq(j2.exact_attempt[0].throttled, true, "…with the exact hop's classification: throttled");
  ok(j2.served.fallback === "exact-throttled", "and the note");
}

// ============================================================================
sect("13. /admin/verify — the proof, against production, byte by byte");
await freshStore();
{
  const j = JSON.parse((await get(`/admin/verify?t=${TOK}&v=unit1`)).text);
  eq(j.identical, true, "our public response is byte-identical to the panel's");
  eq(j.bytes.served, j.bytes.supplier, "same length");
  eq(j.bytes.delta, 0, "zero delta");
  eq(j.first_diff_offset, -1, "no first difference exists");
  eq(j.sha256.served, j.sha256.supplier, "same sha256");
  eq(j.served_mode, "exact", "served in exact mode");
  ok(j.verdict.includes("byte-identical"), "verdict: " + j.verdict.slice(0, 60));
  ok(!JSON.stringify(j).includes(PANEL_TOKEN), "the proof does not leak the token either");

  await freshStore();
  state.self = "tamper";
  const j2 = JSON.parse((await get(`/admin/verify?t=${TOK}&v=unit2`)).text);
  eq(j2.identical, false, "and the same endpoint FAILS when the bytes differ");
  ok(j2.first_diff_offset >= 0, "pointing at the offset: " + j2.first_diff_offset);
  ok(j2.bytes.served !== j2.bytes.supplier && j2.bytes.delta !== 0, "and the lengths disagree: " + j2.bytes.served + " vs " + j2.bytes.supplier);
  eq(j2.served_mode, "safe", "…and it can see why: the response says it was a fallback");
  ok(j2.verdict.includes("safe-mode fallback"), "verdict explains it: " + j2.verdict.slice(0, 50));
  ok(j2.around_first_diff && j2.around_first_diff.served.length > 0, "with a window around the difference");
}

// ============================================================================
sect("14. the edges");
await freshStore();
{
  const nf = await get("/nothing-here");
  eq(nf.r.status, 404, "unknown path is 404");
  const land = await get("/");
  eq(land.r.status, 200, "the landing page answers");
  ok(land.text.includes("exact") && land.text.includes(VERSION), "and names the mode + version");
  ok(land.text.includes("/e/&lt;token&gt;"), "with the link format to give a customer");
  const noTok = await get("/diag");
  eq(noTok.r.status, 400, "/diag without a token explains its usage instead of 500ing");
  const noTok2 = await get("/e/");
  ok(noTok2.r.status === 404 || noTok2.r.status === 400, "a bare /e/ is a 404/400, not a crash: " + noTok2.r.status);

  // The leak sweep: nothing this run served may carry the panel's credentials.
  const leaked = bodies.filter((b) => b.text.includes(PANEL_TOKEN) && !b.path.includes("x.test"));
  eq(leaked.length, 0, `no response body leaks the panel token (${bodies.length} responses swept)`);
  const leakedUrl = bodies.filter((b) => b.text.includes(SUPPLIER));
  eq(leakedUrl.length, 0, "no response body contains the supplier URL either");
}

console.log("\n" + "─".repeat(70));
if (failures) {
  console.log(`💥 ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`🎉 ALL ${checks} CHECKS PASSED`);
