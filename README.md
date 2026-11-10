# SP-V1 — the converter that converts nothing

`v1.0` · companion to [sp-vpn-hub](https://github.com/Kaixx23/sp-vpn-hub)

A customer's app downloads a file from a subscription panel, and then connects to
the nodes inside it. **This host serves that file byte-for-byte.** Not a rebuild,
not a rebrand, not a "better" profile — the supplier's own bytes, so every node,
ping, port, key, group, DNS server, rule and quota line is exactly what their link
gives. If the panel's config is right for an app, this is identical; if the panel's
config is wrong for an app, `?profile=safe` hands over the hub's rebuilt profile
instead. Both modes ship, so a difference of opinion never becomes an outage.

```
node bin/verify-live.mjs https://your-site.netlify.app <token>   # proves it in production
```

---

## Deploy (about 5 minutes, no build step)

1. **New Netlify site** → *Add new site → Import an existing project* → this repo.
   Nothing to configure: `netlify.toml` sets `NODE_VERSION=20`, points
   `functions` at `netlify/functions`, keeps `@libsql/client` external (its native
   binding cannot be bundled), and rewrites `/*` to the function.
2. **Environment** (Site settings → Environment variables):

   | Variable | Value | Needed |
   | --- | --- | --- |
   | `TOKEN_STORE_URL` | the **same** Turso/libSQL URL as the hub | yes — this is what makes existing customer tokens work here |
   | `TOKEN_STORE_AUTH_TOKEN` | the same token as the hub | yes |
   | `HUB_BASE_URL` | `https://sp-vpn.netlify.app` | only for `safe` mode; this is the default if unset |

   No function timeout is configurable here (10 s is the platform default), so the
   code budgets itself instead: 6.5 s for the supplier hop, 2.6 s for the fallback
   hop, which is why a slow panel degrades instead of killing the request.
3. **Give customers a link.** Recommended, token in the path:

   ```
   https://<your-site>/e/<token>            ← auto-negotiated format
   https://<your-site>/e/<token>.yaml       ← force mihomo YAML
   https://<your-site>/e/<token>?fmt=sr     ← force the node list
   ```

   Every hub-shaped URL also works unchanged, so moving a customer across is a
   host swap, not a new link: `/all/SP VPN?t=<token>`, `/sub/<token>`,
   `/share/<token>`, `/q/<token>`.

   `/e/<token>` is preferred because function responses here are cached by **path**
   with the query stripped: `/all/SP VPN` is one cache entry for the whole site.
   `Cache-Control: no-store` is set on every response for that reason, and a
   token-in-path makes the guarantee structural rather than dependent on a header.

## The two modes

| | what the app receives | when to use it |
| --- | --- | --- |
| **`exact`** (default) | the supplier panel's own bytes, verbatim. Clash-family clients are asked for the panel's mihomo YAML (`&type=clash&flag=meta` — the panel's own switch); everything else gets its base64 link list. Their `external-controller`, their CN resolvers, their `fallback-filter`, their ~600 curated rules, their `GEOIP,CN,DIRECT`, their Chinese group names, their two quota pseudo-nodes inside the auto/fallback groups, `skip-cert-verify: false` on every node, `flow: ''` on the ws ones. | When the requirement is *"behaves exactly like the supplier's link, in Clash Meta and everything else."* |
| **`safe`** | `sp-vpn-hub`'s rebuilt profile: geo-free DNS that resolves anywhere, no geodata download needed at import, English rebrand, carrier groups, a probe `url` on the group customers actually open so latency numbers appear. | When an app cannot import the panel's file — usually a client that cannot download `geoip.metadb` — or when the customer wants the branded layout. |

`safe` is fetched from the hub at request time. It is deliberately **not** a copy of
the hub's generator: a copy drifts, a proxy cannot. The hub stays the only place that
profile is defined.

**Automatic fallback.** If the panel refuses (Cloudflare challenge, 429/403) or
answers with something the client cannot use, `exact` failing is not an error — the
request transparently returns the safe profile instead, and says so:

```
X-SPVPN-Mode: safe
X-SPVPN-Fallback: exact-throttled        # or exact-unusable | forced-by-profile-param
```

If both hops fail, the response names each hop (`supplier: … ; hub: …`) rather than
blaming the supplier for what was a rate limit — the lesson that cost a whole support
thread. And if the *token store* blinks, the last good file is served for up to 24 h
with `X-SPVPN-Stale: <age>`.

### Knobs

| Parameter | Effect |
| --- | --- |
| `?profile=safe` | skip exact entirely — no panel fetch at all |
| `?profile=exact` / `?fallback=0` | strict: never fall back, report the failure instead. Use this when you want to *see* a problem |
| `?raw=1` | ask the stored URL exactly as stored — no `type=clash&flag=meta` appended. For panels that already answer YAML, or to prove the parameter is the only thing we add |
| `?fmt=yaml` / `?fmt=sr`, `.yaml` / `.txt` suffix | force the format, whatever the User-Agent says |

## What "byte-exact" honestly means

Three things this site does, and no more:

1. **Chooses the endpoint.** A Clash-family client is pointed at the panel's YAML
   variant; the bytes of that response are then copied, never parsed.
2. **Forwards `User-Agent` and `Accept`** — because that is how the panel decides
   what to send. Nothing else is forwarded.
3. **Adds headers.** `Cache-Control: no-store`, `X-SPVPN-*`, and passes through the
   panel's `subscription-userinfo` / `profile-update-interval` / `content-disposition`
   when it sends them (that is how quota reaches the app). The body is never touched:
   no trim, no BOM strip, no CRLF normalisation, no re-encode, no added comment.

Which means: no rebranding, no DNS substitution, no geodata-free rule set, no extra
groups — the four things the hub does, and the four differences this repo exists to
remove. VPN traffic never passes through either converter; the file is downloaded
once, so this server cannot change a node's speed.

## Diagnostics

| | |
| --- | --- |
| `GET /healthz` | version, default mode, whether the panel answers, whether the hub fallback hop is reachable, cache counters. Cached 120 s (it fetches upstream); `?force=1` bypasses |
| `GET /diag?t=<token>` | which mode served, size/sha/node+rule counts, the first 12 lines of what the app gets, the fallback reason, the panel host (token always `[scrubbed]`) |
| `GET /admin/verify?t=<token>[&kind=raw][&v=<bust>]` | **the proof.** Fetches this site's own public URL *and* the panel's response, independently, and diffs them byte by byte: `identical`, `first_diff_offset`, a window around it, both sha256s, node counts, and `served_mode` |

`identical: false` with `served_mode: "safe"` is not a bug — that is the fallback
serving a rebuilt profile because the panel refused. `identical: false` with
`served_mode: "exact"` would mean this repo is broken, and the tests below are why
that combination is hard to ship by accident.

## Tests

```
npm test          # 249 checks: 181 + 68. No dev dependencies, no network.
```

Two suites, because they prove different things.

**`test/exact.test.mjs` (181 checks)** runs `worker.fetch` against a stubbed panel
and hub, on a fixture deliberately hostile to a helpful proxy — UTF-8 BOM, CRLF
endings, flow-style YAML, a Chinese group name, a full-width colon inside a node
name, commas inside quoted rules — and asserts **`Buffer.compare(served, fixture)
=== 0`**. That one comparison is the product claim. Around it:

- **§1–4** pure logic: the YAML-variant URL is built idempotently and never
  overwrites a `type=` from the row; the client-negotiation table is the hub's
  (Karing, Verge, Mi, Stash → YAML; Shadowrocket, curl → list); what counts as a
  usable profile vs a list vs a challenge; a 500 is *not* a rate limit; `scrub()`
  removes the panel token; the loop-back guard needs host **and** route, because a
  branded domain legitimately serves both a panel and customer links.
- **§5–6** byte-identity on both formats, `X-SPVPN-*` headers, panel Content-Type
  and `subscription-userinfo` passed through, the client's UA forwarded, the hub
  not touched at all.
- **§7** every failure shape: challenge → `safe` with `exact-throttled`; HTTP 200
  of rubbish → `exact-unusable`; `?fallback=0` → 502 naming the timeout and no hub
  fetch; both hops down → 503 with each hop's own reason; the fallback hop is
  verified to hit the hub's `/all/SP VPN?t=…&fmt=yaml`, so the hub cannot negotiate
  a base64 list for a Clash app.
- **§8** `?profile=safe` touches the panel zero times.
- **§9** unknown token → 410 without an upstream fetch; **revocation takes effect on
  the next request even with a warm 5-minute cache** (token is resolved *before* the
  cache is consulted); store down + cold cache → 503 that names *our* dependency and
  never says "supplier"; store down + warm cache → the same byte-exact body with
  `X-SPVPN-Stale`.
- **§10** 12 simultaneous refreshes are 1 upstream fetch (single-flight); a second
  wave inside the TTL is 0; a row whose upstream is the hub itself → 422
  `self_referential`, and the hub is not dialed.
- **§11–14** health levels (`ok` / `degraded` when the rescue hop is down / supplier
  failure visible), `/diag`, `/admin/verify` passing **and** failing on a tampered
  response, plus a sweep proving no response body this run produced contains the
  panel token or the supplier URL.

**`test/live-http.test.mjs` (68 checks)** cannot be replaced by the first suite: it
starts three real loopback servers (a panel, a hub, and the app behind the same
`fetch(request, env, ctx)` contract the Netlify wrapper uses) and makes a customer's
request over actual HTTP. That is what catches the layer around the worker — the
`Request` built from a socket, header case, a real client parsing our response, a
panel that is a real server. It checks the sha256 of what the panel wrote against the
sha256 of what the client received, byte 0 of the BOM and the last two bytes of the
trailing CRLF, that a list client is never redirected to the YAML endpoint, and the
three cache behaviours:

* fresh cache → served with **zero** upstream fetches, so a stampede of refreshing
  apps cannot pile onto a struggling panel;
* aged cache (`ageCaches()`, the test/ops hook that exists so this path is
  exercisable without waiting five minutes) + both hops down → the last good
  document, with `X-SPVPN-Stale` and `X-SPVPN-Fallback: stale-cache-both-hops-failed`;
* cold cache + both hops down → an honest 503 naming each hop, never a "supplier
  issue" for a rate limit.

## Support playbook

| Customer says | Do |
| --- | --- |
| "your link doesn't work in Clash, the panel's does" | `curl -i <their URL>` → `X-SPVPN-Mode`. `exact` + broken means the panel's own file is broken for that app (it will be for their panel link too) → `&profile=safe`. `safe` when they expected `exact` → read `/diag`'s `exact_attempt[].reason`: throttled, or unusable |
| "the pings don't show" | In `exact` the ping policy is the panel's: their `select` group has no `url`, so numbers appear in `自动选择`/`故障转移`, and their file needs `geoip.metadb` before `GEOIP` rules apply. `safe` puts a probe on the top group and needs no download |
| "quota is wrong" | The panel decides. Both modes read its `STATUS=` line / `subscription-userinfo`; nothing here computes a number. Use the hub dashboard |
| "I want my old link back" | Nothing was taken away: their old hub link keeps working on the hub host; this host is additive |

## What this repo is not

- **No dashboard, no billing, no renewals, no QR tool.** Customer rows, plans,
  expiry, reminders and revocation all live in `sp-vpn-hub`, which owns the same
  tables. `token-store.js` here is a verbatim copy of the hub's client so both
  sites read one database — keep the two files in sync if a column is added.
- **Not independent of the panel.** Exact mode *is* the panel: if it is slow or
  blocking bots, so is this, until the safe hop takes over.
- **Not a Vercel deployment.** `netlify/functions` only; the hub has the Vercel
  entry if you need one here.

## Version

`v1.0` — announced at `/healthz`, on every response as `X-SPVPN-Version`, and in
`exact-worker.js` (`export const VERSION`). Future updates are tagged
(`git tag v1.1`), so "what changed since I deployed?" is a `git log v1.0..HEAD`.
