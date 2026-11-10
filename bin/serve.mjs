// Local dev server: node bin/serve.mjs [port]
//   GET http://localhost:8788/            the landing page
//   GET http://localhost:8788/e/<token>   the customer link
//   GET http://localhost:8788/healthz     what this build is doing
import worker, { VERSION } from "../exact-worker.js";

const port = Number(process.argv[2] || 8788);
const server = await import("node:http").then((http) => http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const request = new Request(url, {
    method: req.method,
    headers: new Headers(req.headers),
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  try {
    const r = await worker.fetch(request, process.env, {});
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String((e && e.message) || e));
  }
}));
server.listen(port, "0.0.0.0", () => console.log(`SP-V1 ${VERSION} listening on http://localhost:${port} — try /healthz and /e/<token>`));
