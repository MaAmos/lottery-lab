import http from "node:http";
import { handleResearch } from "./src/research.js";

const server = http.createServer(async (req, res) => {
  try {
    const parts = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > 65536) { res.writeHead(413).end(); return; }
      parts.push(part);
    }
    const request = new Request(`http://127.0.0.1:8787${req.url}`, {
      method: req.method, headers: req.headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(parts) }),
    });
    const response = await handleResearch(request, {});
    if (!response) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) { res.writeHead(500).end(error.message); }
});
server.listen(8787, "127.0.0.1", () => console.log("Research API: http://127.0.0.1:8787 (local only, download runs to preserve them)"));
