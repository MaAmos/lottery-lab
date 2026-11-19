import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import artifact from "../src/generated/research-data.js";
import { generate, handleResearch, statusFor, syncOfficialDraws } from "../src/research.js";
import { database } from "./db-helper.js";

const time = kind => Date.parse(`${artifact.lotteries[kind].target_date_estimate}T12:00:00+08:00`);

test("deterministic unique basic tickets, exact cost and transparent issue", () => {
  for (const lotteryType of ["ssq", "dlt"]) {
    const body = { lotteryType, seed: 12345, count: 20 };
    const a = generate(body, time(lotteryType)), b = generate(body, time(lotteryType));
    assert.deepEqual(a.plans, b.plans);
    assert.equal(new Set(a.plans.map(p => JSON.stringify(p))).size, 20);
    assert.equal(a.cost_yuan, 40);
    assert.equal(a.target_issue, null);
    assert.equal(a.purchased, false);
    assert.equal(a.jackpot_probability_under_fair_draw, 20 / artifact.lotteries[lotteryType].combination_count);
    for (const p of a.plans) {
      assert.equal(p.red.length, lotteryType === "ssq" ? 6 : 5);
      assert.equal(p.blue.length, lotteryType === "ssq" ? 1 : 2);
      assert.equal(new Set(p.red).size, p.red.length);
      assert.equal(new Set(p.blue).size, p.blue.length);
    }
    assert.equal(Object.hasOwn(a, "confidence"), false);
  }
});

test("experimental models keep their status and probabilities distinct from scores", () => {
  for (const model of ["frequency", "history_logistic", "metadata_logistic"]) {
    const a = generate({ model, seed: 99 }, time("ssq"));
    assert.equal(a.experimental, true);
    assert.equal(a.model, model);
    assert.match(a.notice, /未证实/);
  }
});

test("fixed birthday pool creates legal, reproducible 10-yuan single tickets", () => {
  for (const lotteryType of ["ssq", "dlt"]) {
    const body = { lotteryType, birthdayPool: true, selectionMode: "single", budget: 10, seed: 12345 };
    const a = generate(body, time(lotteryType)), b = generate(body, time(lotteryType));
    assert.deepEqual(a.plans, b.plans);
    assert.equal(a.plans.length, 5);
    assert.equal(a.cost_yuan, 10);
    assert.deepEqual(a.fixed_number_pool, ["01", "02", "05", "07", "16", "18", "21", "27"]);
    assert.deepEqual(a.blue_pool, lotteryType === "ssq" ? ["01", "02", "05", "07", "16"] : ["01", "02", "05", "07"]);
    for (const plan of a.plans) {
      assert.ok(plan.red.every(number => a.red_pool.includes(number)));
      assert.ok(plan.blue.every(number => a.blue_pool.includes(number)));
      assert.equal(plan.red.length, lotteryType === "ssq" ? 6 : 5);
      assert.equal(plan.blue.length, lotteryType === "ssq" ? 1 : 2);
    }
    assert.match(a.notice, /不会提高/);
  }
});

test("birthday compound costs match expanded legal combinations", () => {
  const ssq = generate({ lotteryType: "ssq", selectionMode: "compound", budget: 10, seed: 7 }, time("ssq"));
  const dlt = generate({ lotteryType: "dlt", selectionMode: "compound", budget: 10, seed: 7 }, time("dlt"));
  assert.equal(ssq.structure, "6+5 复式（5 注）");
  assert.equal(ssq.cost_yuan, 10);
  assert.equal(dlt.structure, "5+4 复式（6 注）");
  assert.equal(dlt.cost_yuan, 12);
  assert.equal(ssq.plans.length * 2, ssq.cost_yuan);
  assert.equal(dlt.plans.length * 2, dlt.cost_yuan);
});

test("birthday selection validates mode, budget, and supported lottery", () => {
  for (const body of [
    { selectionMode: "system" }, { selectionMode: "single", budget: 1 },
    { selectionMode: "single", budget: 102 }, { lotteryType: "xyz", selectionMode: "single" },
  ]) assert.throws(() => generate(body, time("ssq")));
});

test("concentrated experimental weights cannot cause an unbounded duplicate loop", () => {
  const snapshot = structuredClone(artifact), p = snapshot.lotteries.ssq.research_marginals.frequency;
  p.red = Array.from({ length: 33 }, (_, i) => i < 6 ? 1 - 1e-12 : 1e-300);
  p.blue = Array.from({ length: 16 }, (_, i) => i === 0 ? 1 - 1e-12 : 1e-300);
  assert.throws(() => generate({ model: "frequency", count: 2, seed: 1 }, time("ssq"), snapshot), /权重过于集中/);
});

test("rejects malformed parameters, unsupported compound costs and stale snapshots", () => {
  for (const body of [{ count: 0 }, { count: 1.5 }, { count: 21 }, { count: "5" }, { lotteryType: "xyz" }, { lotteryType: "__proto__" }, { model: "magic" }, { seed: -1 }, { cost: 14 }]) {
    assert.throws(() => generate(body, time("ssq")));
  }
  const deadline = Date.parse(`${artifact.lotteries.ssq.target_date_estimate}T20:00:00+08:00`);
  assert.equal(statusFor(artifact.lotteries.ssq, deadline).stale, true);
  assert.throws(() => generate({}, deadline), /截止/);
});

test("research endpoints use the frozen full-dataset report and validate requests", async () => {
  const result = await handleResearch(new Request("https://example.org/api/research"), {});
  const body = await result.json();
  assert.equal(body.data.dataset_sha256, artifact.dataset_sha256);
  assert.equal(body.data.lotteries.ssq.coverage.count, artifact.lotteries.ssq.coverage.count);
  const invalid = await handleResearch(new Request("https://example.org/api/predict", { method: "POST", body: "{" }), {});
  assert.equal(invalid.status, 400);
});

test("public GET cannot write to DB", async () => {
  const env = { DB: { prepare() { throw new Error("must not access DB"); } } };
  const response = await worker.fetch(new Request("https://example.org/api/fetch-results"), env, {});
  assert.equal(response.status, 405);
});

test("scheduled ingestion persists every draw and never updates legacy predictions", async () => {
  const originalFetch = globalThis.fetch;
  const periods = Array.from({ length: 30 }, (_, i) => ({ issue: String(i + 1).padStart(3, "0"), day: String(i + 1).padStart(2, "0") }));
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes("cwl.gov")
    ? { state: 0, result: periods.map(n => ({ code: `2026${n.issue}`, date: `2026-01-${n.day}`, red: "01,02,03,04,05,06", blue: "01" })) }
    : { success: true, value: { list: periods.map(n => ({ lotteryDrawNum: `26${n.issue}`, lotteryDrawTime: `2026-01-${n.day}`, lotteryDrawResult: "01 02 03 04 05 01 02" })) } }));
  const db = database();
  try {
    const result = await syncOfficialDraws({ DB: db });
    assert.equal(result.status, 200);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM official_draw_snapshots").get().n, 60);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM research_draws").get().n, 60);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM research_predictions").get().n, 0);
    assert.ok(db.stats.queries <= 50, `D1 invocation query count: ${db.stats.queries}`);
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});
