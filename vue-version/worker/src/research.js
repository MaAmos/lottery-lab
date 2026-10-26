import artifact from "./generated/research-data.js";
import { readSnapshot, handleAutomation, automationStatus, ingestDraws, insertRows } from "./automation.js";

const CONFIG = { ssq: [33, 6, 16, 1], dlt: [35, 5, 12, 2] };
const MODELS = new Set(["uniform", "frequency", "history_logistic", "metadata_logistic"]);
const headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

export function statusFor(report, time = Date.now()) {
  // Conservative generation deadline; this is NOT an authoritative sales schedule.
  const deadline = `${report.target_date_estimate}T20:00:00+08:00`;
  return { stale: time >= Date.parse(deadline), generation_deadline: deadline,
    target_issue_verified: false, schedule_estimate_only: true };
}

function rng32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, weights, count) {
  const pool = weights.map((weight, index) => ({ number: index + 1, weight }));
  const selected = [];
  for (let n = 0; n < count; n++) {
    let value = random() * pool.reduce((sum, item) => sum + item.weight, 0);
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      value -= pool[i].weight;
      if (value < 0) { index = i; break; }
    }
    selected.push(pool.splice(index, 1)[0].number);
  }
  return selected.sort((a, b) => a - b).map(n => String(n).padStart(2, "0"));
}

export function generate(body, timestamp = Date.now(), snapshot = artifact) {
  const kind = body.lotteryType ?? body.lottery_type ?? "ssq";
  const count = body.count ?? 5;
  const model = body.model ?? "uniform";
  if (!Object.hasOwn(CONFIG, kind) || !Number.isInteger(count) || count < 1 || count > 20 || !MODELS.has(model)) {
    throw new Error("彩种须为 ssq/dlt，注数须为 1—20 的整数，模型须在实验列表中");
  }
  if (body.cost !== undefined && body.cost !== 2) throw new Error("新流程按每注2元生成基本单式；预算由注数决定");
  const report = snapshot.lotteries[kind];
  const status = statusFor(report, timestamp);
  if (status.stale) throw new Error("数据快照已过生成截止时间，请重新采集并训练后生成下一期候选");
  const seed = body.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed 须为0—4294967295整数");
  const [rm, rc, bm, bc] = CONFIG[kind];
  const weights = model === "uniform" ? { red: Array(rm).fill(1), blue: Array(bm).fill(1) } : report.research_marginals[model];
  const random = rng32(seed);
  const plans = [];
  const keys = new Set();
  let attempts = 0;
  while (plans.length < count) {
    if (++attempts > 2000) throw new Error("实验模型权重过于集中，无法生成足够的不同候选；请切换均匀随机");
    const ticket = { red: pick(random, weights.red, rc), blue: pick(random, weights.blue, bc) };
    const key = `${ticket.red.join(",")}|${ticket.blue.join(",")}`;
    if (!keys.has(key)) { plans.push(ticket); keys.add(key); }
  }
  return { run_id: crypto.randomUUID(), created_at: new Date(timestamp).toISOString(), lottery_type: kind,
    model, model_run_id: snapshot.model_run_id, dataset_sha256: snapshot.dataset_sha256,
    seed, rng: "mulberry32-v1", plans, count, cost_yuan: count * 2, purchased: false,
    target_issue: null, target_date_estimate: report.target_date_estimate,
    data_cutoff_issue: report.coverage.last_issue, status,
    jackpot_probability_under_fair_draw: count / report.combination_count,
    coverage_expression: `${count}/${report.combination_count}`,
    experimental: model !== "uniform",
    notice: model === "uniform" ? report.production_policy.reason : "实验性加权抽样，未证实能提高下一期一等奖概率；边际模型分数不等于整注概率。",
    saved: false, storage_notice: "可下载本次候选记录；下载或生成均不表示已购票。" };
}

export async function handleResearch(request, env) {
  const url = new URL(request.url);
  const admin = await handleAutomation(request, env);
  if (admin) return admin;
  const paths = ["/api/research", "/api/predict", "/api/predict-bundle", "/api/backtest", "/api/research-results"];
  if (!paths.includes(url.pathname)) return null;
  try {
    const { artifact: snapshot, ...source } = await readSnapshot(env);
    if (url.pathname === "/api/research-results" && request.method === "POST") {
      const body = await request.json();
      if (!Array.isArray(body.run_ids) || body.run_ids.length > 20 || body.run_ids.some(id => typeof id !== "string" || !/^[\w-]{8,100}$/.test(id))) throw new Error("最多查询20个有效记录ID");
      if (!env.DB || !body.run_ids.length) return response({ success: true, data: [] });
      const placeholders = body.run_ids.map(() => "?").join(",");
      const rows = await env.DB.prepare(`SELECT p.run_id,p.created_at,p.payload,r.payload AS result_payload FROM research_predictions p LEFT JOIN research_prediction_results r USING(run_id) WHERE p.run_id IN (${placeholders}) ORDER BY p.created_at DESC`)
        .bind(...body.run_ids).all();
      return response({ success: true, data: rows.results.map(row => ({ ...JSON.parse(row.payload), saved: true,
        result: row.result_payload ? JSON.parse(row.result_payload) : null })) });
    }
    if (url.pathname === "/api/research" && request.method === "GET") {
      const lotteries = Object.fromEntries(Object.entries(snapshot.lotteries).map(([kind, report]) => [kind, { ...report, status: statusFor(report) }]));
      const automation = await automationStatus(env, { ...source });
      return response({ success: true, data: { ...snapshot, lotteries, automation } });
    }
    if (url.pathname === "/api/backtest" && ["GET", "POST"].includes(request.method)) {
      const body = request.method === "POST" ? await request.json() : {};
      const kind = body.lotteryType ?? body.lottery_type ?? url.searchParams.get("type") ?? "ssq";
      if (!Object.hasOwn(CONFIG, kind)) throw new Error("不支持的彩种");
      return response({ success: true, data: { ...snapshot.lotteries[kind], available: true, model_run_id: snapshot.model_run_id } });
    }
    if (["/api/predict", "/api/predict-bundle"].includes(url.pathname) && request.method === "POST") {
      const data = generate(await request.json(), Date.now(), snapshot);
      // New independent table only. Never assign historic NULL-issue records to today's draw.
      if (env?.DB) {
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO research_predictions (run_id, created_at, model_run_id, payload) VALUES (?, ?, ?, ?)")
              .bind(data.run_id, data.created_at, data.model_run_id, JSON.stringify(data)),
            env.DB.prepare("INSERT INTO research_pending_candidates VALUES (?,?,?,?,?)")
              .bind(data.run_id, data.lottery_type, data.target_date_estimate, data.data_cutoff_issue, data.created_at),
          ]);
          data.saved = true;
          data.storage_notice = "已保存本次候选记录，不表示已购票。";
        } catch {
          data.storage_notice = "候选已生成，数据库未保存；请下载记录，并检查新数据表是否已迁移。";
        }
      }
      return response({ success: true, data });
    }
    return response({ success: false, error: "Method Not Allowed" }, 405);
  } catch (error) {
    const databaseError = /D1|SQLITE|no such table|database/i.test(error.message);
    return response({ success: false, error: databaseError ? "数据库暂不可用，请检查D1绑定和新表迁移" : error.message }, databaseError ? 503 : 400);
  }
}

export async function syncOfficialDraws(env) {
  // Independent backup collector; GitHub Actions also sends validated canonical draws.
  if (!env.DB) return response({ success: false, error: "D1 DB binding missing" }, 503);
  const sources = [
    ["ssq", "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?name=ssq&pageNo=1&pageSize=30&systemType=PC"],
    ["dlt", "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85&provinceId=0&pageSize=30&isVerify=1&pageNo=1"],
  ];
  const results = [];
  for (const [kind, sourceUrl] of sources) {
    try {
      const res = await fetch(sourceUrl, { headers: { Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/" } });
      if (!res.ok) throw new Error(`source HTTP ${res.status}`);
      const body = await res.json();
      if ((kind === "ssq" && body.state !== 0) || (kind === "dlt" && !body.success)) throw new Error("source API failed");
      const rows = kind === "ssq" ? body.result : body.value.list;
      if (!Array.isArray(rows) || !rows.length) throw new Error("source returned no rows");
      const retrieved = new Date().toISOString();
      const records = rows.map(row => {
        const original = kind === "ssq" ? row.code : row.lotteryDrawNum;
        const issue = kind === "dlt" && /^\d{5}$/.test(original) ? `20${original}` : original;
        if (!/^20\d{5}$/.test(issue)) throw new Error("unrecognized official issue");
        return [kind, issue, retrieved, sourceUrl, JSON.stringify(row)];
      });
      const statements = insertRows(env.DB, "official_draw_snapshots", ["lottery_type", "issue", "retrieved_at", "source_url", "payload"], records);
      await env.DB.batch(statements);
      const canonical = rows.map(row => {
        const nums = kind === "ssq" ? null : row.lotteryDrawResult.trim().split(/\s+/).map(Number);
        const original = kind === "ssq" ? row.code : row.lotteryDrawNum;
        return { lottery_type: kind, issue: kind === "dlt" && /^\d{5}$/.test(original) ? `20${original}` : original,
          draw_date: (kind === "ssq" ? row.date : row.lotteryDrawTime).slice(0, 10),
          red: kind === "ssq" ? row.red.split(",").map(Number) : nums.slice(0, 5),
          blue: kind === "ssq" ? row.blue.split(",").map(Number) : nums.slice(5), source_url: sourceUrl };
      });
      const settlement = await ingestDraws(env, canonical);
      results.push({ lottery_type: kind, success: true, observed: rows.length, retrieved_at: retrieved, settlement });
    } catch (error) { results.push({ lottery_type: kind, success: false, error: error.message }); }
  }
  return response({ success: results.every(r => r.success), data: results,
    notice: "定时采集并核对已发布记录；训练与新模型发布由GitHub Actions执行。" }, results.every(r => r.success) ? 200 : 502);
}
