import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("static navigation goes to assets, unknown APIs stay APIs", async () => {
  let assetCalls = 0;
  const env = { ASSETS: { async fetch(request) {
    assetCalls++;
    return new Response(`static:${new URL(request.url).pathname}`);
  } } };
  for (const path of ["/", "/history", "/assets/app.js"]) {
    const response = await worker.fetch(new Request(`https://example.org${path}`), env, {});
    assert.equal(await response.text(), `static:${path}`);
  }
  for (const path of ["/api", "/api/unknown"]) {
    const response = await worker.fetch(new Request(`https://example.org${path}`), env, {});
    assert.equal(response.status, 404);
  }
  assert.equal(assetCalls, 3);
});

test("same-origin research report and CORS preflight reach the API", async () => {
  const env = { ASSETS: { fetch() { throw new Error("API must not return index.html"); } } };
  const response = await worker.fetch(new Request("https://example.org/api/research"), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  const options = await worker.fetch(new Request("https://example.org/api/predict", { method: "OPTIONS" }), env, {});
  assert.equal(options.status, 200);
  assert.match(options.headers.get("Access-Control-Allow-Methods"), /POST/);
});
