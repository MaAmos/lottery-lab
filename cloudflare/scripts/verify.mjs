import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/verify.mjs /absolute/path/to/release-directory");
const stateRoot = path.join(root, "cloudflare/.wrangler");
await mkdir(stateRoot, { recursive: true });
const directory = await mkdtemp(path.join(stateRoot, "verify-"));
const config = JSON.parse(await readFile(path.join(release, "wrangler.json"), "utf8"));
config.main = path.join(release, "worker.js");
config.assets.directory = path.join(release, "assets");
config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000001";
const updateToken = "local-integration-only-0123456789-0123456789";
config.vars = { ...config.vars, AUTO_UPDATE_TOKEN: updateToken };
const configFile = path.join(directory, "wrangler.json");
await writeFile(configFile, JSON.stringify(config, null, 2));
const cli = path.join(root, "cloudflare/node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
const run = args => execFileSync(process.execPath, [cli, ...args, "--config", configFile], {
  cwd: directory, env, stdio: "inherit", timeout: 60000,
});
run(["deploy", "--dry-run", "--outdir", path.join(directory, "bundle")]);
run(["d1", "execute", "DB", "--local", "--file", path.join(release, "schema.sql")]);
// Prove that the additive schema can safely run again.
run(["d1", "execute", "DB", "--local", "--file", path.join(release, "schema.sql")]);
const port = 8791;
let logs = "";
const server = spawn(process.execPath, [cli, "dev", "--config", configFile, "--port", String(port), "--ip", "127.0.0.1", "--local"], {
  cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", d => { logs += d; });
server.stderr.on("data", d => { logs += d; });
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`wrangler exited: ${logs}`);
    try { ready = (await fetch(base + "/api/research")).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(ready, `wrangler did not become ready: ${logs}`);
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Lottery Lab/);
  const spa = await fetch(base + "/history", { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /id="app"/);
  const unknown = await fetch(base + "/api/unknown");
  assert.equal(unknown.status, 404);
  const report = await (await fetch(base + "/api/research")).json();
  assert.equal(report.success, true);
  const admin = async (route, body) => fetch(base + "/api/admin/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${updateToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await fetch(base + "/api/admin/snapshot")).status, 401);
  const initial = JSON.parse(await readFile(path.join(release, "model-report.json"), "utf8"));
  const draws = Object.entries(initial.lotteries).map(([kind, r]) => ({
    lottery_type: kind, ...r.latest_draw,
    source_url: kind === "ssq" ? "https://www.cwl.gov.cn/api" : "https://webapi.sporttery.cn/api",
  }));
  const ingestion = await admin("draws", { draws });
  assert.equal(ingestion.status, 200, await ingestion.text());
  const initialPublish = await admin("publish", { expected_model_run_id: initial.model_run_id, artifact: initial });
  assert.equal(initialPublish.status, 200, await initialPublish.text());
  const next = structuredClone(initial);
  next.model_run_id += "-local-check";
  for (const r of Object.values(next.lotteries)) r.candidate_run.model_run_id = next.model_run_id;
  const updated = await admin("publish", { expected_model_run_id: initial.model_run_id, artifact: next });
  assert.equal(updated.status, 200, await updated.text());
  const active = await (await fetch(base + "/api/research")).json();
  assert.equal(active.data.model_run_id, next.model_run_id);
  assert.equal(active.data.automation.source, "d1");
  const conflict = await admin("publish", { expected_model_run_id: initial.model_run_id, artifact: initial });
  assert.equal(conflict.status, 409);
  const invalid = structuredClone(next); invalid.model_run_id += "-invalid"; invalid.lotteries.ssq.coverage.count -= 1;
  const rejected = await admin("publish", { expected_model_run_id: next.model_run_id, artifact: invalid });
  assert.equal(rejected.status, 400);
  assert.equal((await (await admin("snapshot")).json()).data.artifact.model_run_id, next.model_run_id);
  const runStatus = await admin("run", { run_id: "integration-test", status: "succeeded", stage: "complete", detail: "Local verification only" });
  assert.equal(runStatus.status, 200);
  const generation = await fetch(base + "/api/predict-bundle", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lotteryType: "ssq", count: 5, model: "uniform", seed: 20261026 }),
  });
  const body = await generation.json();
  const stale = report.data.lotteries.ssq.status.stale;
  if (stale) {
    assert.equal(generation.status, 400);
    assert.match(body.error, /截止时间/);
  } else {
    assert.equal(generation.status, 200);
    assert.equal(body.data.saved, true);
    assert.equal(body.data.plans.length, 5);
    assert.equal(body.data.cost_yuan, 10);
    assert.equal(body.data.model_run_id, next.model_run_id);
    const history = await (await fetch(base + "/api/research-results", {
      method: "POST", body: JSON.stringify({ run_ids: [body.data.run_id] }),
    })).json();
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].result, null);
  }
  run(["d1", "execute", "DB", "--local", "--command", "SELECT count(*) AS candidates FROM research_predictions"]);
  run(["d1", "execute", "DB", "--local", "--command", "SELECT lottery_type,COUNT(*) AS unique_targets FROM research_forecasts GROUP BY lottery_type"]);
  console.log(JSON.stringify({ success: true, tests: ["Wrangler dry-run", "idempotent D1 schema", "static assets", "SPA navigation", "API 404", "research report", "admin authentication", "official canonical ingestion", "D1 activation and live snapshot switch", "conflict and invalid publication retain active model", "automation run status", "unique prospective targets", stale ? "expired snapshot rejection" : "candidate generation, persistence and result lookup"], model_run_id: next.model_run_id, local_only: true, release }, null, 2));
} finally {
  server.kill("SIGTERM");
}
