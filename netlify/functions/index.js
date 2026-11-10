// SP-V1 — Netlify Functions entry. Adapts an incoming request to the worker's
// fetch(request, env, ctx) interface. Copied from the hub (sp-vpn-hub) so the two
// sites wire up identically, including the legacy v1-event path that `netlify dev`
// and older tooling still use.
import worker from "../../exact-worker.js";

const isWebRequest = (input) => typeof Request !== "undefined" && input instanceof Request;

const normHeaders = (headers = {}) => {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? String(v.join(", ")) : String(v);
  }
  return out;
};

const requestFromV1Event = (event) => {
  const method = (event.httpMethod || "GET").toUpperCase();
  const headers = normHeaders(event.headers);
  let body = null;
  if (["POST", "PUT", "PATCH"].includes(method)) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "");
  }
  let rawUrl = event.rawUrl;
  if (!rawUrl) {
    const proto = (headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = headers["x-forwarded-host"] || headers["host"] || "localhost";
    const qs = event.querystring ? "?" + event.querystring : "";
    rawUrl = `${proto}://${host}${event.rawPath || event.path || "/"}${qs}`;
  }
  return new Request(rawUrl, { method, headers, body });
};

export default async (input, context) => {
  const request = isWebRequest(input) ? input : requestFromV1Event(input);
  // The runtime env (TOKEN_STORE_URL, TOKEN_STORE_AUTH_TOKEN, HUB_BASE_URL) reaches
  // the worker here; `process` does not exist on the Edge runtime, hence the guard.
  let env = {};
  try { env = (typeof process !== "undefined" && process.env) || {}; } catch (e) { env = {}; }
  if (context && context.env) env = { ...env, ...context.env };
  const response = await worker.fetch(request, env, context || {});
  const out = new Headers();
  response.headers.forEach((v, k) => {
    if (!["content-length", "transfer-encoding", "connection", "date"].includes(k)) out.set(k, v);
  });
  return new Response(response.body, { status: response.status, headers: out });
};
