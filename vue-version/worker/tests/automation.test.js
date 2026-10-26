import test from "node:test";
import assert from "node:assert/strict";
import artifact from "../src/generated/research-data.js";
import { handleAutomation, readSnapshot, ingestDraws, settle, validateSnapshot, scoreForecast, eligible } from "../src/automation.js";
import { handleResearch } from "../src/research.js";
import { database } from "./db-helper.js";

const token = "unit-test-token-0123456789-0123456789";
const official = kind => kind === "ssq" ? "https://www.cwl.gov.cn/api" : "https://webapi.sporttery.cn/api";
const request = (path, body, secret = token) => new Request(`https://example.org/api/admin/${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${secret}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function seedDraws(env) {
  for (const kind of ["ssq", "dlt"]) await ingestDraws(env, [{ ...artifact.lotteries[kind].latest_draw, lottery_type: kind, source_url: official(kind) }]);
}

test("admin auth rejects missing/incorrect credentials before accessing DB", async () => {
  const DB = { prepare() { throw new Error("must not access DB"); } };
  assert.equal((await handleAutomation(request("snapshot"), { DB })).status, 503);
  assert.equal((await handleAutomation(request("snapshot", undefined, "incorrect"), { DB, AUTO_UPDATE_TOKEN: token })).status, 401);
});

test("atomic publication changes dynamic report; version conflicts keep previous active model", async () => {
  const env = { DB: database(), AUTO_UPDATE_TOKEN: token };
  try {
    await seedDraws(env);
    let result = await handleAutomation(request("publish", { expected_model_run_id: artifact.model_run_id, artifact }), env);
    assert.equal(result.status, 200, await result.text());
    assert.equal((await readSnapshot(env)).source, "d1");
    const next = structuredClone(artifact); next.model_run_id += "-next";
    for (const report of Object.values(next.lotteries)) report.candidate_run.model_run_id = next.model_run_id;
    result = await handleAutomation(request("publish", { expected_model_run_id: artifact.model_run_id, artifact: next }), env);
    assert.equal(result.status, 200, await result.text());
    const publicReport = await (await handleResearch(new Request("https://example.org/api/research"), env)).json();
    assert.equal(publicReport.data.model_run_id, next.model_run_id);
    // Repeated snapshots for one target date do not add forecast observations.
    assert.ok(env.DB.sqlite.prepare("SELECT count(*) AS n FROM research_forecasts").get().n <= 2);
    result = await handleAutomation(request("publish", { expected_model_run_id: artifact.model_run_id, artifact }), env);
    assert.equal(result.status, 409);
    const bad = structuredClone(next); bad.model_run_id += "-bad"; bad.lotteries.ssq.research_marginals.uniform.red[0] = 0.9;
    result = await handleAutomation(request("publish", { expected_model_run_id: next.model_run_id, artifact: bad }), env);
    assert.equal(result.status, 400);
    assert.equal((await readSnapshot(env)).artifact.model_run_id, next.model_run_id);
  } finally { env.DB.sqlite.close(); }
});

test("quality gates reject expiry extension, protocol drift and cutoff regression", () => {
  const next = structuredClone(artifact);
  next.lotteries.ssq.target_date_estimate = "2026-11-30";
  assert.throws(() => validateSnapshot(next, artifact), /expiry/);
  next.lotteries.ssq.target_date_estimate = artifact.lotteries.ssq.target_date_estimate;
  next.lotteries.ssq.frequency_windows.red += 1;
  assert.throws(() => validateSnapshot(next, artifact), /protocol/);
  next.lotteries.ssq.coverage.count -= 1;
  assert.throws(() => validateSnapshot(next, artifact), /regressing/);
});

test("settlement is date-specific, uses pre-draw server provenance and is idempotent", async () => {
  const env = { DB: database() }, db = env.DB.sqlite;
  try {
    const report = structuredClone(artifact.lotteries.ssq);
    report.coverage.last_issue = "2026001";
    report.target_date_estimate = "2026-01-04";
    const forecastTime = "2026-01-03T10:00:00Z";
    db.prepare("INSERT INTO research_forecasts VALUES (?,?,?,?,?)").run("ssq", "2026-01-04", "fixture-version", forecastTime, JSON.stringify(report));
    const draw = { lottery_type: "ssq", issue: "2026002", draw_date: "2026-01-04", red: [1, 2, 3, 4, 5, 6], blue: [1], source_url: official("ssq") };
    const candidate = { plans: [{ red: ["01", "02", "03", "04", "05", "06"], blue: ["01"] }], data_cutoff_issue: "2026001", target_date_estimate: "2026-01-04" };
    for (const [id, date, created] of [["candidate-eligible", "2026-01-04", forecastTime], ["candidate-late", "2026-01-04", "2026-01-04T12:00:00Z"], ["candidate-other-date", "2026-01-06", forecastTime]]) {
      db.prepare("INSERT INTO research_predictions VALUES (?,?,?,?)").run(id, created, "fixture-version", JSON.stringify({ ...candidate, target_date_estimate: date }));
      db.prepare("INSERT INTO research_pending_candidates VALUES (?,?,?,?,?)").run(id, "ssq", date, "2026001", created);
    }
    assert.equal((await ingestDraws(env, [draw])).evaluated, 2);
    const result = JSON.parse(db.prepare("SELECT payload FROM research_prediction_results").get().payload);
    assert.deepEqual(result.hits, [{ red_hits: 6, blue_hits: 1, jackpot: true }]);
    assert.equal(result.monetary_payout, null);
    assert.equal((await settle(env)).evaluated, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM research_forecast_results").get().n, 1);
    const revised = { ...draw, blue: [2] };
    await assert.rejects(ingestDraws(env, [revised]), /conflict/);
    assert.equal(eligible(candidate, draw, "2026-01-04T12:00:00Z"), false);
    const score = scoreForecast(report, draw);
    assert.equal(score.scores.uniform.delta_vs_uniform, 0);
    assert.ok(Number.isFinite(score.scores.metadata_logistic.marginal_log_loss));
  } finally { db.close(); }
});

test("a failed D1 batch rolls back model and active pointer together", async () => {
  const DB = database();
  try {
    await assert.rejects(DB.batch([
      DB.prepare("INSERT INTO research_model_versions VALUES (?,?,?,?)").bind("rollback-test", "now", "hash", "{}"),
      DB.prepare("INSERT INTO research_active_model VALUES (?,?,?)").bind(2, "rollback-test", "now"),
    ]));
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM research_model_versions").get().n, 0);
  } finally { DB.sqlite.close(); }
});
