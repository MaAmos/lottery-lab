// Training runs in GitHub Actions; the Worker only validates, stores and scores.
import bootstrap from "./generated/research-data.js";

export const CONFIG = { ssq: [33, 6, 16, 1], dlt: [35, 5, 12, 2] };
export const MODELS = ["uniform", "frequency", "history_logistic", "metadata_logistic"];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const dateOK = value => typeof value === "string" && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const deadline = date => Date.parse(`${date}T20:00:00+08:00`);

// D1 has limits on both queries per invocation and bound parameters per query.
// Group records into SQL statements, not just individual statements into a batch.
export function insertRows(db, table, columns, rows) {
  const statements = [], size = Math.floor(100 / columns.length);
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    statements.push(db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES ${chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`)
      .bind(...chunk.flat()));
  }
  return statements;
}

export async function readSnapshot(env) {
  if (!env?.DB) return { artifact: bootstrap, source: "bundled", activated_at: null };
  // A missing migration must be visible instead of silently falling back on a DB failure.
  const row = await env.DB.prepare("SELECT v.payload,a.activated_at FROM research_active_model a JOIN research_model_versions v USING(model_run_id) WHERE a.slot=1").first();
  return row ? { artifact: JSON.parse(row.payload), source: "d1", activated_at: row.activated_at }
    : { artifact: bootstrap, source: "bundled", activated_at: null };
}

export function validateDraw(draw) {
  const config = CONFIG[draw?.lottery_type];
  if (!config || !/^20\d{5}$/.test(draw.issue) || !dateOK(draw.draw_date)
    || draw.issue.slice(0, 4) !== draw.draw_date.slice(0, 4)) fail("Invalid canonical draw");
  for (const [pool, maximum, count] of [["red", config[0], config[1]], ["blue", config[2], config[3]]]) {
    const values = draw[pool];
    if (!Array.isArray(values) || values.length !== count || new Set(values).size !== count
      || values.some(n => !Number.isInteger(n) || n < 1 || n > maximum)) fail("Invalid draw numbers");
  }
  const source = new URL(draw.source_url);
  const expected = draw.lottery_type === "ssq" ? "www.cwl.gov.cn" : "webapi.sporttery.cn";
  if (source.protocol !== "https:" || source.hostname !== expected) fail("An official source is required");
  if (deadline(draw.draw_date) > Date.now()) fail("Cannot ingest a future draw");
  return draw;
}

export function validateSnapshot(next, previous) {
  if (!next || !/^[\w-]{8,100}$/.test(next.model_run_id) || !/^[a-f0-9]{64}$/.test(next.dataset_sha256)
    || !Number.isFinite(Date.parse(next.created_at)) || Date.parse(next.created_at) > Date.now() + 300000) fail("Invalid model identity");
  if (Object.keys(next.lotteries || {}).sort().join(",") !== "dlt,ssq") fail("Exactly two lotteries are required");
  for (const [kind, config] of Object.entries(CONFIG)) {
    const r = next.lotteries?.[kind], old = previous.lotteries[kind];
    if (!r || r.lottery_type !== kind || !/^20\d{5}$/.test(r.coverage?.last_issue)
      || !dateOK(r.coverage.last_date) || !dateOK(r.target_date_estimate)
      || r.target_date_estimate <= r.coverage.last_date
      || r.coverage.last_issue < old.coverage.last_issue || r.coverage.last_date < old.coverage.last_date
      || !Number.isInteger(r.coverage.count) || r.coverage.count < old.coverage.count
      || !Array.isArray(r.coverage.missing_issues) || r.coverage.missing_issues.length
      || r.production_policy?.model !== "uniform" || r.production_policy.jackpot_advantage_established !== false
      || r.combination_count !== old.combination_count) fail(`Invalid or regressing ${kind} snapshot`);
    if (r.coverage.last_issue === old.coverage.last_issue && r.target_date_estimate !== old.target_date_estimate) fail("Cannot extend expiry without a new draw");
    if (r.latest_draw?.issue !== r.coverage.last_issue || r.latest_draw.draw_date !== r.coverage.last_date) fail("Inconsistent latest draw");
    if (JSON.stringify(r.split) !== JSON.stringify(old.split)
      || JSON.stringify(r.frequency_windows) !== JSON.stringify(old.frequency_windows)
      || JSON.stringify(r.logistic_regularization) !== JSON.stringify(old.logistic_regularization)) fail("Frozen evaluation protocol changed");
    for (const name of MODELS) {
      for (const [pool, max, count] of [["red", config[0], config[1]], ["blue", config[2], config[3]]]) {
        const p = r.research_marginals?.[name]?.[pool];
        if (!Array.isArray(p) || p.length !== max || p.some(x => !Number.isFinite(x) || x <= 0 || x >= 1)
          || Math.abs(p.reduce((a, b) => a + b, 0) - count) > 1e-5) fail("Invalid marginal probabilities");
      }
    }
    if (!r.candidate_run || r.candidate_run.target_date_estimate !== r.target_date_estimate
      || r.candidate_run.data_cutoff_issue !== r.coverage.last_issue
      || r.candidate_run.model_run_id !== next.model_run_id || r.candidate_run.dataset_sha256 !== next.dataset_sha256
      || r.candidate_run.model !== "uniform" || r.candidate_run.cost_yuan !== 10
      || r.candidate_run.plans?.length !== 5) fail("Invalid candidate provenance");
    for (const plan of r.candidate_run.plans) {
      for (const [pool, max, count] of [["red", config[0], config[1]], ["blue", config[2], config[3]]]) {
        const nums = plan[pool]?.map(Number);
        if (!nums || nums.length !== count || new Set(nums).size !== count || nums.some(n => !Number.isInteger(n) || n < 1 || n > max)) fail("Invalid candidate numbers");
      }
    }
  }
  return next;
}

async function authorized(request, env) {
  if (typeof env.AUTO_UPDATE_TOKEN !== "string" || env.AUTO_UPDATE_TOKEN.length < 32) fail("AUTO_UPDATE_TOKEN is not configured", 503);
  const supplied = request.headers.get("Authorization") || "";
  if (supplied.length > 512) fail("Unauthorized", 401);
  const hash = async value => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${env.AUTO_UPDATE_TOKEN}`)]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff) fail("Unauthorized", 401);
  if (!env.DB) fail("D1 DB binding missing", 503);
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) fail("JSON body required");
  let length = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 262144) { await reader.cancel(); fail("Body too large", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function ticketHits(plans, draw) {
  return plans.map(plan => {
    const red = plan.red.filter(n => draw.red.includes(Number(n))).length;
    const blue = plan.blue.filter(n => draw.blue.includes(Number(n))).length;
    return { red_hits: red, blue_hits: blue, jackpot: red === draw.red.length && blue === draw.blue.length };
  });
}

export function scoreForecast(forecast, draw) {
  const scores = {};
  for (const name of MODELS) {
    const errors = [], losses = [];
    for (const pool of ["red", "blue"]) {
      forecast.research_marginals[name][pool].forEach((p, index) => {
        const y = Number(draw[pool].includes(index + 1));
        errors.push((p - y) ** 2); losses.push(-(y * Math.log(p) + (1 - y) * Math.log(1 - p)));
      });
    }
    scores[name] = { brier: errors.reduce((a, b) => a + b, 0) / errors.length,
      marginal_log_loss: losses.reduce((a, b) => a + b, 0) / losses.length };
  }
  for (const name of MODELS) scores[name].delta_vs_uniform = scores[name].brier - scores.uniform.brier;
  return { scores, candidate_hits: ticketHits(forecast.candidate_run.plans, draw), monetary_payout: null };
}

export function eligible(record, draw, publishedAt) {
  return record.target_date_estimate === draw.draw_date && record.data_cutoff_issue < draw.issue
    && Date.parse(publishedAt) < deadline(draw.draw_date);
}

export async function ingestDraws(env, draws) {
  if (!Array.isArray(draws) || draws.length > 60) fail("Expected at most 60 official draws");
  draws.forEach(validateDraw);
  const existing = new Map();
  for (const kind of Object.keys(CONFIG)) {
    const issues = draws.filter(d => d.lottery_type === kind).map(d => d.issue);
    if (!issues.length) continue;
    const found = await env.DB.prepare(`SELECT issue,payload FROM research_draws WHERE lottery_type=? AND issue IN (${issues.map(() => "?").join(",")})`).bind(kind, ...issues).all();
    found.results.forEach(row => existing.set(`${kind}/${row.issue}`, row));
  }
  const records = [];
  for (const draw of draws) {
    const old = existing.get(`${draw.lottery_type}/${draw.issue}`);
    if (old) {
      const parsed = JSON.parse(old.payload);
      if (["draw_date", "red", "blue"].some(k => JSON.stringify(parsed[k]) !== JSON.stringify(draw[k]))) fail("Official draw conflict; manual review required", 409);
    }
    records.push([draw.lottery_type, draw.issue, draw.draw_date, new Date().toISOString(), JSON.stringify(draw)]);
  }
  const statements = insertRows(env.DB, "research_draws", ["lottery_type", "issue", "draw_date", "retrieved_at", "payload"], records);
  if (statements.length) await env.DB.batch(statements);
  return settle(env);
}

export async function settle(env) {
  const now = new Date().toISOString(), forecastRows = [], candidateRows = [];
  const forecasts = await env.DB.prepare(`SELECT f.*,d.payload AS draw_payload FROM research_forecasts f
    JOIN research_draws d ON d.lottery_type=f.lottery_type AND d.draw_date=f.target_date
    LEFT JOIN research_forecast_results r ON r.lottery_type=f.lottery_type AND r.target_date=f.target_date
    WHERE r.issue IS NULL ORDER BY f.target_date LIMIT 60`).all();
  for (const row of forecasts.results) {
    const forecast = JSON.parse(row.payload), draw = JSON.parse(row.draw_payload);
    if (!eligible({ target_date_estimate: row.target_date, data_cutoff_issue: forecast.coverage.last_issue }, draw, row.published_at)) continue;
    const payload = { ...scoreForecast(forecast, draw), issue: draw.issue, draw_date: draw.draw_date,
      model_run_id: row.model_run_id, published_at: row.published_at, source_url: draw.source_url };
    forecastRows.push([row.lottery_type, row.target_date, draw.issue, now, JSON.stringify(payload)]);
  }
  const candidates = await env.DB.prepare(`SELECT p.run_id,p.created_at,r.payload,d.payload AS draw_payload FROM research_pending_candidates p
    JOIN research_predictions r USING(run_id) JOIN research_draws d ON d.lottery_type=p.lottery_type AND d.draw_date=p.target_date
    LEFT JOIN research_prediction_results s USING(run_id) WHERE s.run_id IS NULL AND d.issue>p.cutoff_issue
    ORDER BY p.created_at LIMIT 100`).all();
  for (const row of candidates.results) {
    const candidate = JSON.parse(row.payload), draw = JSON.parse(row.draw_payload);
    if (!eligible(candidate, draw, row.created_at)) continue;
    const payload = { issue: draw.issue, draw_date: draw.draw_date, numbers: { red: draw.red, blue: draw.blue },
      hits: ticketHits(candidate.plans, draw), monetary_payout: null, source_url: draw.source_url };
    candidateRows.push([row.run_id, draw.issue, now, JSON.stringify(payload)]);
  }
  const statements = [
    ...insertRows(env.DB, "research_forecast_results", ["lottery_type", "target_date", "issue", "evaluated_at", "payload"], forecastRows),
    ...insertRows(env.DB, "research_prediction_results", ["run_id", "issue", "evaluated_at", "payload"], candidateRows),
  ];
  if (statements.length) await env.DB.batch(statements);
  return { evaluated: forecastRows.length + candidateRows.length, remaining_checked_next_run: candidates.results.length === 100 };
}

export async function automationStatus(env, snapshot) {
  if (!env.DB) return { configured: false, source: snapshot.source, latest_run: null, prospective: [] };
  const latest = await env.DB.prepare("SELECT * FROM research_automation_runs ORDER BY updated_at DESC LIMIT 1").first();
  const summary = await env.DB.prepare(`SELECT lottery_type,COUNT(*) AS draws,MAX(issue) AS last_issue,
    AVG(json_extract(payload,'$.scores.frequency.delta_vs_uniform')) AS frequency_delta,
    AVG(json_extract(payload,'$.scores.history_logistic.delta_vs_uniform')) AS history_delta,
    AVG(json_extract(payload,'$.scores.metadata_logistic.delta_vs_uniform')) AS metadata_delta
    FROM research_forecast_results GROUP BY lottery_type`).all();
  return { configured: typeof env.AUTO_UPDATE_TOKEN === "string" && env.AUTO_UPDATE_TOKEN.length >= 32,
    source: snapshot.source, activated_at: snapshot.activated_at, latest_run: latest,
    prospective: summary.results, notice: "前瞻样本只统计服务发布后、开奖截止前的首次快照；差值是模型Brier减随机Brier，不代表一等奖概率优势。" };
}

export async function handleAutomation(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/admin/")) return null;
  try {
    await authorized(request, env);
    if (path === "/api/admin/snapshot" && request.method === "GET") return json({ success: true, data: await readSnapshot(env) });
    if (request.method !== "POST") return json({ success: false, error: "Method Not Allowed" }, 405);
    const body = await boundedBody(request);
    if (path === "/api/admin/run") {
      if (!/^[\w-]{1,100}$/.test(body.run_id) || !["running", "failed", "no_change", "succeeded"].includes(body.status)
        || typeof body.stage !== "string" || body.stage.length > 100 || typeof body.detail !== "string" || body.detail.length > 500) fail("Invalid run status");
      await env.DB.prepare("INSERT INTO research_automation_runs VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,stage=excluded.stage,updated_at=excluded.updated_at,detail=excluded.detail")
        .bind(body.run_id, body.status, body.stage, new Date().toISOString(), body.detail).run();
      return json({ success: true });
    }
    if (path === "/api/admin/draws") return json({ success: true, data: await ingestDraws(env, body.draws) });
    if (path !== "/api/admin/publish") return json({ success: false, error: "Not Found" }, 404);
    const current = await readSnapshot(env), next = body.artifact;
    if (body.expected_model_run_id !== current.artifact.model_run_id) fail("Active version changed; rerun against the current snapshot", 409);
    validateSnapshot(next, current.artifact);
    const existing = await env.DB.prepare("SELECT payload FROM research_model_versions WHERE model_run_id=?").bind(next.model_run_id).first();
    if (existing) {
      if (existing.payload !== JSON.stringify(next)) fail("Model versions are immutable", 409);
      if (next.model_run_id === current.artifact.model_run_id) return json({ success: true, already_active: true });
      fail("Cannot reactivate an older model version", 409);
    }
    for (const kind of Object.keys(CONFIG)) {
      const r = next.lotteries[kind];
      const verified = await env.DB.prepare("SELECT payload FROM research_draws WHERE lottery_type=? AND issue=?").bind(kind, r.coverage.last_issue).first();
      if (!verified) fail("Publish official draws before the model");
      const draw = JSON.parse(verified.payload);
      if (["draw_date", "red", "blue"].some(k => JSON.stringify(draw[k]) !== JSON.stringify(r.latest_draw[k]))) fail("Model cutoff does not match verified draw");
    }
    const now = new Date().toISOString();
    const statements = [
      env.DB.prepare("INSERT INTO research_model_versions VALUES (?,?,?,?)").bind(next.model_run_id, now, next.dataset_sha256, JSON.stringify(next)),
      env.DB.prepare(`INSERT INTO research_active_model(slot,model_run_id,activated_at)
        SELECT 1,?,? WHERE COALESCE((SELECT model_run_id FROM research_active_model WHERE slot=1),?)=?
        ON CONFLICT(slot) DO UPDATE SET model_run_id=excluded.model_run_id,activated_at=excluded.activated_at
        WHERE research_active_model.model_run_id=?`).bind(next.model_run_id, now, bootstrap.model_run_id, body.expected_model_run_id, body.expected_model_run_id),
    ];
    for (const [kind, r] of Object.entries(next.lotteries)) {
      if (Date.now() >= deadline(r.target_date_estimate)) continue;
      // The first real server publication owns this target; repeated training cannot inflate evidence.
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO research_forecasts
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM research_active_model WHERE slot=1 AND model_run_id=?)`)
        .bind(kind, r.target_date_estimate, next.model_run_id, now, JSON.stringify(r), next.model_run_id));
    }
    const result = await env.DB.batch(statements);
    if (!result[1].meta.changes) fail("Concurrent publication won; reload and retry", 409);
    return json({ success: true, model_run_id: next.model_run_id, published_at: now });
  } catch (error) {
    const databaseError = /D1|SQLITE|no such table|database/i.test(error.message);
    return json({ success: false, error: databaseError ? "Database unavailable; check D1 migration" : error.message }, error.status || (databaseError ? 503 : 400));
  }
}
