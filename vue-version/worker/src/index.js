/*
 * Cloudflare Worker 后端逻辑
 * 包含：API 接口, CORS 处理, 定时任务(Cron)
 * 无需外部依赖，可直接在 Dashboard 编辑
 */

import { handleResearch, syncOfficialDraws } from "./research.js";

export default {
  // 1. 处理 HTTP 请求 (API)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --- 全局 CORS 处理 ---
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-user-id",
        },
      });
    }

    const researchResponse = await handleResearch(request, env);
    if (researchResponse) return researchResponse;

    // --- 路由分发 ---
    // [POST] AI 预测接口
    if (path === "/api/predict" && method === "POST") {
      return await handlePredict(request, env);
    }

    // [POST] 一键生成多组分散方案
    if (path === "/api/predict-bundle" && method === "POST") {
      return await handlePredictBundle(request, env);
    }

    // [GET/POST] 回测评分器
    if (path === "/api/backtest" && (method === "GET" || method === "POST")) {
      return await handleBacktest(request, env, url);
    }

    // [POST] 保存预测结果
    if (path === "/api/save-prediction" && method === "POST") {
      return jsonResponse({ success: false, error: "旧保存接口已停用；新候选在生成时单独记录，不再写入旧预测表" }, 410);
    }

    // [GET] 获取历史记录
    if (path === "/api/history" && method === "GET") {
      return await handleGetHistory(request, env, url);
    }

    // [GET] 手动触发开奖抓取 (用于测试)
    if (path === "/api/fetch-results" && method === "GET") {
      return jsonResponse({ success: false, error: "公开 GET 不再触发数据写入；请运行采集命令或使用定时任务" }, 405);
    }

    // 404
    return new Response("Not Found", { status: 404 });
  },

  // 2. 处理定时任务 (Cron)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOfficialDraws(env).then(async response => {
      if (!response.ok) console.error("Official draw sync failed", await response.text());
    }));
  },
};

// --- 辅助函数 ---

const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-user-id",
    },
  });
};

// --- 业务逻辑 ---

// 1. 生成预测号码 (模拟 AI)
// Top 1/3 (Hot), Middle 1/3 (Warm), Bottom 1/3 (Cold) derived from historical frequency
const STATS = {
  ssq: {
    hot: [14, 26, 22, 1, 17, 6, 32, 18, 20, 7, 2],
    warm: [8, 27, 9, 10, 19, 3, 13, 5, 12, 30, 4],
    cold: [25, 16, 15, 11, 31, 24, 23, 21, 29, 28, 33],
    blue_hot: [16, 1, 15, 12, 11],
  },
  dlt: {
    hot: [29, 35, 33, 30, 32, 22, 34, 7, 1, 5, 31],
    warm: [3, 19, 11, 2, 25, 20, 6, 23, 27, 10, 28, 18, 26],
    cold: [9, 8, 14, 21, 12, 17, 13, 4, 15, 24, 16],
    blue_hot: [10, 7, 5, 12, 2],
  },
};

const STRATEGY = {
  ssq: {
    redCount: 6,
    blueCount: 1,
    redMax: 33,
    blueMax: 16,
    historyLimit: 60,
    decay: 0.96,
    rankDecay: 0.9,
    repeatRedRate: 0.34,
    repeatBlueRate: 0.08,
    groupWeights: { hot: 0.42, warm: 0.36, cold: 0.22 },
    desiredGroup: { hot: 2, warm: 2, cold: 2 },
    sumRange: [86, 118],
    oddRange: [2, 4],
    maxConsecutiveRun: 2,
    blueHotChance: 0.58,
    recentPredictionLimit: 16,
    maxRecentRedOverlap: 3,
    maxRecentBlueOverlap: 0,
    similarityPenalty: 7,
    topCandidateCount: 10,
    scoreTemperature: 3.5,
  },
  dlt: {
    redCount: 5,
    blueCount: 2,
    redMax: 35,
    blueMax: 12,
    historyLimit: 60,
    decay: 0.955,
    rankDecay: 0.9,
    repeatRedRate: 0.32,
    repeatBlueRate: 0.08,
    groupWeights: { hot: 0.4, warm: 0.35, cold: 0.25 },
    desiredGroup: { hot: 2, warm: 2, cold: 1 },
    sumRange: [72, 128],
    oddRange: [2, 3],
    maxConsecutiveRun: 2,
    blueHotChance: 0.6,
    recentPredictionLimit: 16,
    maxRecentRedOverlap: 2,
    maxRecentBlueOverlap: 1,
    similarityPenalty: 7,
    topCandidateCount: 10,
    scoreTemperature: 3.5,
  },
};

const ALGORITHM_LABELS = {
  balanced: "平衡型",
  omission: "遗漏值",
  neighbor: "邻号",
  matrix: "共现矩阵",
  template: "历史模板",
  ensemble: "多策略集成",
  random: "随机兜底",
};

const BACKTEST_CACHE_TTL = 5 * 60 * 1000;
const backtestCache = new Map();
const backtestPending = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sumArray(arr) {
  return arr.reduce((total, n) => total + n, 0);
}

function countOdd(arr) {
  return arr.filter((n) => n % 2 !== 0).length;
}

function maxConsecutiveRun(arr) {
  if (!arr.length) return 0;
  let maxRun = 1;
  let currentRun = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1] + 1) {
      currentRun++;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  return maxRun;
}

function average(arr) {
  if (!arr.length) return 0;
  return sumArray(arr) / arr.length;
}

function createRange(max) {
  return Array.from({ length: max }, (_, i) => i + 1);
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function candidateKey(candidate) {
  return `${candidate.red.join(",")}|${candidate.blue.join(",")}`;
}

function scoreMap(numbers, map) {
  return numbers.reduce((total, n) => total + (map?.[n] || 0), 0);
}

function intersectionCount(a, b) {
  const right = new Set(b);
  return a.filter((n) => right.has(n)).length;
}

function scorePairs(numbers, map) {
  let total = 0;
  for (let i = 0; i < numbers.length; i++) {
    for (let j = i + 1; j < numbers.length; j++) {
      total += map?.[pairKey(numbers[i], numbers[j])] || 0;
    }
  }
  return total;
}

function pairSynergy(number, chosen, map) {
  let total = 0;
  chosen.forEach((n) => {
    total += map?.[pairKey(n, number)] || 0;
  });
  return total;
}

function weightedPickFromRange(range, weightsMap, exclude = new Set()) {
  const pool = range.filter((n) => !exclude.has(n));
  if (!pool.length) return null;
  const weights = pool.map((n) => Math.max(0.01, weightsMap?.[n] || 1));
  return weightedPick(pool, weights);
}

function modeFromBuckets(values, bucketSize = 1) {
  const buckets = {};
  values.forEach((value) => {
    const bucket = Math.round(value / bucketSize) * bucketSize;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });

  let bestBucket = null;
  let bestCount = -1;
  Object.entries(buckets).forEach(([bucket, count]) => {
    const num = parseInt(bucket);
    if (count > bestCount || (count === bestCount && num < bestBucket)) {
      bestBucket = num;
      bestCount = count;
    }
  });
  return bestBucket;
}

function weightedPick(items, weights) {
  if (!items.length) return null;
  if (!weights || weights.length !== items.length) {
    return items[Math.floor(Math.random() * items.length)];
  }

  const total = weights.reduce((acc, weight) => acc + weight, 0);
  if (total <= 0) {
    return items[Math.floor(Math.random() * items.length)];
  }

  let cursor = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickFromPool(pool, exclude = new Set(), rankDecay = 0.9) {
  const excluded = exclude instanceof Set ? exclude : new Set(exclude);
  const available = pool.filter((n) => !excluded.has(n));
  if (!available.length) return null;

  const weights = available.map((_, index) => Math.pow(rankDecay, index));
  return weightedPick(available, weights);
}

function chooseGroup(stats, chosen, cfg) {
  const groups = [
    { key: "hot", pool: stats.hot || [], weight: cfg.groupWeights.hot },
    { key: "warm", pool: stats.warm || [], weight: cfg.groupWeights.warm },
    { key: "cold", pool: stats.cold || [], weight: cfg.groupWeights.cold },
  ].filter((group) => group.pool.some((n) => !chosen.includes(n)));

  if (!groups.length) return null;

  const counts = {
    hot: chosen.filter((n) => (stats.hot || []).includes(n)).length,
    warm: chosen.filter((n) => (stats.warm || []).includes(n)).length,
    cold: chosen.filter((n) => (stats.cold || []).includes(n)).length,
  };

  const weights = groups.map((group) => {
    const desired = cfg.desiredGroup[group.key] || 0;
    const deficit = desired - counts[group.key];
    return Math.max(0.05, group.weight + deficit * 0.15);
  });

  return weightedPick(groups, weights);
}

function analyzeCandidate(reds, blues, stats, cfg, profile = null) {
  const target = profile || cfg;
  const sum = sumArray(reds);
  const oddCount = countOdd(reds);
  const consecutiveRun = maxConsecutiveRun(reds);
  const hotCount = reds.filter((n) => (stats.hot || []).includes(n)).length;
  const warmCount = reds.filter((n) => (stats.warm || []).includes(n)).length;
  const coldCount = reds.filter((n) => (stats.cold || []).includes(n)).length;
  const repeatRedCount = stats.lastDraw?.red
    ? reds.filter((n) => stats.lastDraw.red.includes(n)).length
    : 0;
  const repeatBlueCount = stats.lastDraw?.blue
    ? blues.filter((n) => stats.lastDraw.blue.includes(n)).length
    : 0;
  const blueHotCount = blues.filter((n) => (stats.blue_hot || []).includes(n))
    .length;

  const sumRange = target.sumRange || cfg.sumRange;
  const oddRange = target.oddRange || cfg.oddRange;
  const spanRange = target.spanRange || [10, 26];
  const desired = target.desiredGroup || cfg.desiredGroup;
  const blueTarget = target.blueTarget;

  const sumMid = (sumRange[0] + sumRange[1]) / 2;
  const sumSpan = Math.max(1, sumRange[1] - sumRange[0]);
  const sumScore = Math.max(
    0,
    18 - (Math.abs(sum - sumMid) / (sumSpan / 2)) * 18,
  );

  const oddMid = (oddRange[0] + oddRange[1]) / 2;
  const oddScore = Math.max(0, 12 - Math.abs(oddCount - oddMid) * 6);

  const groupScore =
    Math.max(0, 6 - Math.abs(hotCount - desired.hot) * 2) +
    Math.max(0, 6 - Math.abs(warmCount - desired.warm) * 2) +
    Math.max(0, 6 - Math.abs(coldCount - desired.cold) * 2);

  const span = Math.max(...reds) - Math.min(...reds);
  const spanMid = (spanRange[0] + spanRange[1]) / 2;
  const spanScore = Math.max(
    0,
    10 - (Math.abs(span - spanMid) / Math.max(1, spanRange[1] - spanRange[0])) * 10,
  );
  const repeatScore = repeatRedCount * 4 + repeatBlueCount * 2;
  const blueScore = blueHotCount * 3;
  const profileBlueScore = blueTarget
    ? Math.max(0, 6 - Math.abs(blueHotCount - blueTarget) * 2)
    : 0;
  const consecutivePenalty = Math.max(0, consecutiveRun - cfg.maxConsecutiveRun)
    * 18;

  const score =
    sumScore +
    oddScore +
    groupScore +
    spanScore +
    repeatScore +
    blueScore +
    profileBlueScore -
    consecutivePenalty;

  const confidence = clamp(Math.round(74 + score * 0.45), 78, 96);

  return {
    score,
    confidence,
    metrics: {
      sum,
      oddCount,
      consecutiveRun,
      min: Math.min(...reds),
      max: Math.max(...reds),
      span,
      hotCount,
      warmCount,
      coldCount,
      repeatRedCount,
      repeatBlueCount,
      blueHotCount,
    },
  };
}

function evaluateCandidate(reds, blues, stats, cfg, method, profile = null) {
  const base = analyzeCandidate(reds, blues, stats, cfg, profile);
  let methodBonus = 0;
  let similarityPenalty = 0;
  let maxRecentRedOverlap = 0;
  let maxRecentBlueOverlap = 0;

  if (method === "omission") {
    const redOmissions = reds.map((n) => stats.omissionRed?.[n] || 0);
    const blueOmissions = blues.map((n) => stats.omissionBlue?.[n] || 0);
    methodBonus += average(redOmissions) * 0.28;
    methodBonus += average(blueOmissions) * 0.18;
  } else if (method === "neighbor") {
    methodBonus += scoreMap(reds, stats.neighborRedScores) * 0.9;
    methodBonus += scoreMap(blues, stats.neighborBlueScores) * 0.9;
    methodBonus += scorePairs(reds, stats.redPairScores) * 0.12;
  } else if (method === "matrix") {
    methodBonus += scorePairs(reds, stats.redPairScores) * 0.42;
    methodBonus += scorePairs(blues, stats.bluePairScores) * 0.22;
    methodBonus += scoreMap(reds, stats.omissionRed) * 0.06;
  } else if (method === "template") {
    const profileTarget = profile || {};
    const sumDelta = Math.abs((base.metrics.sum || 0) - (profileTarget.sumMid || 0));
    const oddDelta = Math.abs(
      (base.metrics.oddCount || 0) - (profileTarget.oddMid || 0),
    );
    const spanDelta = Math.abs((base.metrics.span || 0) - (profileTarget.spanMid || 0));
    methodBonus += Math.max(0, 18 - sumDelta) * 0.12;
    methodBonus += Math.max(0, 10 - oddDelta * 2) * 0.25;
    methodBonus += Math.max(0, 12 - spanDelta) * 0.1;
  }

  (stats.recentPredictions || []).forEach((item) => {
    const redOverlap = intersectionCount(reds, item.red);
    const blueOverlap = intersectionCount(blues, item.blue);
    maxRecentRedOverlap = Math.max(maxRecentRedOverlap, redOverlap);
    maxRecentBlueOverlap = Math.max(maxRecentBlueOverlap, blueOverlap);

    const redExcess = Math.max(0, redOverlap - cfg.maxRecentRedOverlap);
    const blueExcess = Math.max(0, blueOverlap - cfg.maxRecentBlueOverlap);
    similarityPenalty += (redExcess + blueExcess) * cfg.similarityPenalty;
  });

  const rawScore = base.score + methodBonus;
  const score = rawScore - similarityPenalty;
  const confidence = clamp(Math.round(74 + score * 0.45), 78, 96);

  return {
    ...base,
    metrics: {
      ...base.metrics,
      maxRecentRedOverlap,
      maxRecentBlueOverlap,
      similarityPenalty: Math.round(similarityPenalty * 10) / 10,
    },
    rawScore,
    score,
    confidence,
    method,
    methodBonus,
    similarityPenalty,
    maxRecentRedOverlap,
    maxRecentBlueOverlap,
  };
}

function finalizeCandidate(rawReds, rawBlues, stats, cfg, method, profile = null) {
  const reds = [...new Set(rawReds)].filter((n) => Number.isInteger(n));
  const blues = [...new Set(rawBlues)].filter((n) => Number.isInteger(n));

  if (reds.length !== cfg.redCount || blues.length !== cfg.blueCount) {
    return null;
  }

  reds.sort((a, b) => a - b);
  blues.sort((a, b) => a - b);

  if (
    reds.some((n) => n < 1 || n > cfg.redMax) ||
    blues.some((n) => n < 1 || n > cfg.blueMax)
  ) {
    return null;
  }

  const sum = sumArray(reds);
  if (sum < cfg.sumRange[0] || sum > cfg.sumRange[1]) return null;

  const oddCount = countOdd(reds);
  if (oddCount < cfg.oddRange[0] || oddCount > cfg.oddRange[1]) return null;

  if (maxConsecutiveRun(reds) > cfg.maxConsecutiveRun) return null;

  const analysis = evaluateCandidate(reds, blues, stats, cfg, method, profile);
  return {
    red: reds.map((n) => n.toString().padStart(2, "0")),
    blue: blues.map((n) => n.toString().padStart(2, "0")),
    strategy: method,
    analysis,
  };
}

function buildCandidate(type, stats, cfg) {
  const chosenReds = [];
  const chosenBlue = [];
  const usedReds = new Set();
  const usedBlues = new Set();

  if (stats.lastDraw?.red?.length && Math.random() < cfg.repeatRedRate) {
    const repeated =
      stats.lastDraw.red[Math.floor(Math.random() * stats.lastDraw.red.length)];
    if (repeated != null) {
      chosenReds.push(repeated);
      usedReds.add(repeated);
    }
  }

  while (chosenReds.length < cfg.redCount) {
    const group = chooseGroup(stats, chosenReds, cfg);
    let pick = null;
    if (group) {
      pick = pickFromPool(group.pool, usedReds, cfg.rankDecay);
    }

    if (pick == null) {
      const fallbackPool = [
        ...(stats.hot || []),
        ...(stats.warm || []),
        ...(stats.cold || []),
      ];
      pick = pickFromPool(fallbackPool, usedReds, cfg.rankDecay);
    }

    if (pick == null) break;
    chosenReds.push(pick);
    usedReds.add(pick);
  }

  if (chosenReds.length !== cfg.redCount) {
    const fallbackPool = [
      ...(stats.hot || []),
      ...(stats.warm || []),
      ...(stats.cold || []),
    ];
    for (const n of fallbackPool) {
      if (!usedReds.has(n)) {
        chosenReds.push(n);
        usedReds.add(n);
      }
      if (chosenReds.length === cfg.redCount) break;
    }
  }

  chosenReds.sort((a, b) => a - b);
  if (new Set(chosenReds).size !== cfg.redCount) return null;

  const sum = sumArray(chosenReds);
  if (sum < cfg.sumRange[0] || sum > cfg.sumRange[1]) return null;

  const oddCount = countOdd(chosenReds);
  if (oddCount < cfg.oddRange[0] || oddCount > cfg.oddRange[1]) return null;

  if (maxConsecutiveRun(chosenReds) > cfg.maxConsecutiveRun) return null;

  if (stats.lastDraw?.blue?.length && Math.random() < cfg.repeatBlueRate) {
    const repeatedBlue =
      stats.lastDraw.blue[Math.floor(Math.random() * stats.lastDraw.blue.length)];
    if (repeatedBlue != null) {
      chosenBlue.push(repeatedBlue);
      usedBlues.add(repeatedBlue);
    }
  }

  while (chosenBlue.length < cfg.blueCount) {
    let pick = null;
    if (Math.random() < cfg.blueHotChance && (stats.blue_hot || []).length) {
      pick = pickFromPool(stats.blue_hot, usedBlues, cfg.rankDecay);
    } else {
      const bluePool = Array.from({ length: cfg.blueMax }, (_, i) => i + 1);
      pick = pickFromPool(bluePool, usedBlues, 1);
    }

    if (pick == null) break;
    chosenBlue.push(pick);
    usedBlues.add(pick);
  }

  if (chosenBlue.length !== cfg.blueCount) {
    const bluePool = Array.from({ length: cfg.blueMax }, (_, i) => i + 1);
    for (const n of bluePool) {
      if (!usedBlues.has(n)) {
        chosenBlue.push(n);
        usedBlues.add(n);
      }
      if (chosenBlue.length === cfg.blueCount) break;
    }
  }

  chosenBlue.sort((a, b) => a - b);
  if (new Set(chosenBlue).size !== cfg.blueCount) return null;

  const analysis = evaluateCandidate(chosenReds, chosenBlue, stats, cfg, "balanced");

  return {
    red: chosenReds.map((n) => n.toString().padStart(2, "0")),
    blue: chosenBlue.map((n) => n.toString().padStart(2, "0")),
    strategy: "balanced",
    analysis,
  };
}

function buildOmissionCandidate(stats, cfg) {
  const redRange = createRange(cfg.redMax);
  const blueRange = createRange(cfg.blueMax);

  for (let attempt = 0; attempt < 40; attempt++) {
    const reds = [];
    const blues = [];
    const usedReds = new Set();
    const usedBlues = new Set();

    while (reds.length < cfg.redCount) {
      const pool = redRange.filter((n) => !usedReds.has(n));
      const weights = pool.map((n) => {
        const omit = stats.omissionRed?.[n] || 0;
        const hotBoost = (stats.hot || []).includes(n) ? 0.8 : 0;
        const warmBoost = (stats.warm || []).includes(n) ? 0.45 : 0;
        return 1 + omit * 1.25 + hotBoost + warmBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      reds.push(pick);
      usedReds.add(pick);
    }

    if (reds.length !== cfg.redCount) continue;

    while (blues.length < cfg.blueCount) {
      const pool = blueRange.filter((n) => !usedBlues.has(n));
      const weights = pool.map((n) => {
        const omit = stats.omissionBlue?.[n] || 0;
        const hotBoost = (stats.blue_hot || []).includes(n) ? 0.75 : 0;
        return 1 + omit * 1.4 + hotBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      blues.push(pick);
      usedBlues.add(pick);
    }

    const candidate = finalizeCandidate(reds, blues, stats, cfg, "omission");
    if (candidate) return candidate;
  }

  return null;
}

function buildNeighborCandidate(stats, cfg) {
  const redRange = createRange(cfg.redMax);
  const blueRange = createRange(cfg.blueMax);

  for (let attempt = 0; attempt < 40; attempt++) {
    const reds = [];
    const blues = [];
    const usedReds = new Set();
    const usedBlues = new Set();

    if (stats.lastDraw?.red?.length && Math.random() < cfg.repeatRedRate) {
      const repeat =
        stats.lastDraw.red[Math.floor(Math.random() * stats.lastDraw.red.length)];
      reds.push(repeat);
      usedReds.add(repeat);
    }

    while (reds.length < cfg.redCount) {
      const pool = redRange.filter((n) => !usedReds.has(n));
      const weights = pool.map((n) => {
        const neighbor = stats.neighborRedScores?.[n] || 0;
        const omit = stats.omissionRed?.[n] || 0;
        const hotBoost = (stats.hot || []).includes(n) ? 0.5 : 0;
        return 1 + neighbor * 1.6 + omit * 0.12 + hotBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      reds.push(pick);
      usedReds.add(pick);
    }

    if (reds.length !== cfg.redCount) continue;

    if (stats.lastDraw?.blue?.length && Math.random() < cfg.repeatBlueRate) {
      const repeatBlue =
        stats.lastDraw.blue[Math.floor(Math.random() * stats.lastDraw.blue.length)];
      blues.push(repeatBlue);
      usedBlues.add(repeatBlue);
    }

    while (blues.length < cfg.blueCount) {
      const pool = blueRange.filter((n) => !usedBlues.has(n));
      const weights = pool.map((n) => {
        const neighbor = stats.neighborBlueScores?.[n] || 0;
        const omit = stats.omissionBlue?.[n] || 0;
        const hotBoost = (stats.blue_hot || []).includes(n) ? 0.55 : 0;
        return 1 + neighbor * 1.5 + omit * 0.14 + hotBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      blues.push(pick);
      usedBlues.add(pick);
    }

    const candidate = finalizeCandidate(reds, blues, stats, cfg, "neighbor");
    if (candidate) return candidate;
  }

  return null;
}

function buildMatrixCandidate(stats, cfg) {
  const redRange = createRange(cfg.redMax);
  const blueRange = createRange(cfg.blueMax);

  for (let attempt = 0; attempt < 50; attempt++) {
    const reds = [];
    const blues = [];
    const usedReds = new Set();
    const usedBlues = new Set();

    const firstRed = weightedPick(
      redRange,
      redRange.map(
        (n) =>
          1 +
          ((stats.hot || []).includes(n) ? 0.9 : 0) +
          ((stats.omissionRed?.[n] || 0) * 0.15),
      ),
    );
    if (firstRed == null) continue;
    reds.push(firstRed);
    usedReds.add(firstRed);

    while (reds.length < cfg.redCount) {
      const pool = redRange.filter((n) => !usedReds.has(n));
      const weights = pool.map((n) => {
        const pairGain = pairSynergy(n, reds, stats.redPairScores);
        const omit = stats.omissionRed?.[n] || 0;
        const hotBoost = (stats.hot || []).includes(n) ? 0.45 : 0;
        return 1 + pairGain * 0.45 + omit * 0.1 + hotBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      reds.push(pick);
      usedReds.add(pick);
    }

    if (reds.length !== cfg.redCount) continue;

    while (blues.length < cfg.blueCount) {
      const pool = blueRange.filter((n) => !usedBlues.has(n));
      const weights = pool.map((n) => {
        const pairGain = pairSynergy(n, blues, stats.bluePairScores);
        const omit = stats.omissionBlue?.[n] || 0;
        const hotBoost = (stats.blue_hot || []).includes(n) ? 0.55 : 0;
        return 1 + pairGain * 0.55 + omit * 0.15 + hotBoost;
      });
      const pick = weightedPick(pool, weights);
      if (pick == null) break;
      blues.push(pick);
      usedBlues.add(pick);
    }

    const candidate = finalizeCandidate(reds, blues, stats, cfg, "matrix");
    if (candidate) return candidate;
  }

  return null;
}

function chooseTemplateSource(stats, profile) {
  if (!stats.draws || !stats.draws.length) return null;
  const target = profile || {};
  const sumMid = target.sumMid || average(stats.draws.map((d) => sumArray(d.red)));
  const oddMid = target.oddMid ?? average(stats.draws.map((d) => countOdd(d.red)));
  const spanMid =
    target.spanMid || average(stats.draws.map((d) => Math.max(...d.red) - Math.min(...d.red)));

  const weights = stats.draws.map((draw) => {
    const sum = sumArray(draw.red);
    const odd = countOdd(draw.red);
    const span = Math.max(...draw.red) - Math.min(...draw.red);
    const hotCount = draw.red.filter((n) => (stats.hot || []).includes(n)).length;
    const warmCount = draw.red.filter((n) => (stats.warm || []).includes(n)).length;
    const coldCount = draw.red.filter((n) => (stats.cold || []).includes(n)).length;
    const blueHotCount = draw.blue.filter((n) => (stats.blue_hot || []).includes(n)).length;
    const distance =
      Math.abs(sum - sumMid) +
      Math.abs(odd - oddMid) * 5 +
      Math.abs(span - spanMid) * 1.5 +
      Math.abs(hotCount - (target.desiredGroup?.hot ?? hotCount)) * 3 +
      Math.abs(warmCount - (target.desiredGroup?.warm ?? warmCount)) * 2 +
      Math.abs(coldCount - (target.desiredGroup?.cold ?? coldCount)) * 2 +
      Math.abs(blueHotCount - (target.blueTarget ?? blueHotCount)) * 2;
    return (1 / (1 + distance)) * draw.weight;
  });

  return weightedPick(stats.draws, weights);
}

function mutateTowardTemplate(reds, blues, stats, cfg, profile) {
  const sumTarget = profile.sumMid || average(cfg.sumRange);
  const oddTarget = profile.oddMid ?? average(cfg.oddRange);
  const spanTarget = profile.spanMid || average(profile.spanRange || [10, 26]);
  const usedReds = new Set(reds);
  const pool = createRange(cfg.redMax).filter((n) => !usedReds.has(n));
  if (!pool.length) return;

  const sum = sumArray(reds);
  const odd = countOdd(reds);
  const span = Math.max(...reds) - Math.min(...reds);

  let replacementIndex = Math.floor(reds.length / 2);
  if (sum < sumTarget) {
    replacementIndex = reds.indexOf(Math.min(...reds));
  } else if (sum > sumTarget) {
    replacementIndex = reds.indexOf(Math.max(...reds));
  } else if (odd < oddTarget) {
    replacementIndex = reds.findIndex((n) => n % 2 === 0);
  } else if (odd > oddTarget) {
    replacementIndex = reds.findIndex((n) => n % 2 !== 0);
  } else if (span < spanTarget) {
    replacementIndex = reds.indexOf(Math.max(...reds));
  }

  if (replacementIndex < 0) replacementIndex = 0;

  const removed = reds[replacementIndex];
  usedReds.delete(removed);
  const weights = pool.map((n) => {
    const omit = stats.omissionRed?.[n] || 0;
    const hotBoost = (stats.hot || []).includes(n) ? 0.7 : 0.2;
    const directionBoost =
      sum < sumTarget
        ? n > removed
          ? 1
          : 0.2
        : sum > sumTarget
        ? n < removed
          ? 1
          : 0.2
        : 0.5;
    return 1 + omit * 0.7 + hotBoost + directionBoost;
  });
  const picked = weightedPick(pool, weights);
  if (picked != null) {
    reds[replacementIndex] = picked;
  }

  if (blues.length) {
    const bluePool = createRange(cfg.blueMax).filter((n) => !blues.includes(n));
    if (bluePool.length) {
      const blueWeights = bluePool.map((n) => {
        const omit = stats.omissionBlue?.[n] || 0;
        const hotBoost = (stats.blue_hot || []).includes(n) ? 0.7 : 0.15;
        return 1 + omit * 0.6 + hotBoost;
      });
      const bluePick = weightedPick(bluePool, blueWeights);
      if (bluePick != null) {
        blues[Math.floor(Math.random() * blues.length)] = bluePick;
      }
    }
  }
}

function buildTemplateCandidate(stats, cfg) {
  const profile = stats.templateProfile || {};
  if (!stats.draws || !stats.draws.length) return null;

  for (let attempt = 0; attempt < 40; attempt++) {
    const source = chooseTemplateSource(stats, profile);
    if (!source) continue;

    const reds = [...source.red];
    const blues = [...source.blue];

    for (let round = 0; round < 3; round++) {
      const candidate = finalizeCandidate(reds, blues, stats, cfg, "template", profile);
      if (candidate) return candidate;
      mutateTowardTemplate(reds, blues, stats, cfg, profile);
    }
  }

  return null;
}

function normalizeAlgorithm(algorithm) {
  const value = (algorithm || "ensemble").toLowerCase();
  if (["history_weighted", "weighted", "balanced"].includes(value)) return "balanced";
  if (["omission", "omit"].includes(value)) return "omission";
  if (["neighbor", "adjacent"].includes(value)) return "neighbor";
  if (["matrix", "pair", "cooccurrence"].includes(value)) return "matrix";
  if (["template", "pattern"].includes(value)) return "template";
  return "ensemble";
}

function generateSmartPrediction(type, stats = STATS[type], algorithm = "ensemble") {
  const cfg = STRATEGY[type];
  if (!cfg) return null;

  const mode = normalizeAlgorithm(algorithm);
  const builders = {
    balanced: () => buildCandidate(type, stats, cfg),
    omission: () => buildOmissionCandidate(stats, cfg),
    neighbor: () => buildNeighborCandidate(stats, cfg),
    matrix: () => buildMatrixCandidate(stats, cfg),
    template: () => buildTemplateCandidate(stats, cfg),
  };

  const activeModes =
    mode === "ensemble"
      ? ["balanced", "omission", "neighbor", "matrix", "template"]
      : [mode];

  const candidateMap = new Map();
  activeModes.forEach((name) => {
    const builder = builders[name];
    if (!builder) return;
    const tries = mode === "ensemble" ? 12 : 35;
    for (let attempt = 0; attempt < tries; attempt++) {
      const candidate = builder();
      if (!candidate) continue;
      const enriched = {
        ...candidate,
        strategy: candidate.strategy || name,
        strategy_label: ALGORITHM_LABELS[candidate.strategy || name] || "多策略集成",
      };
      const key = candidateKey(enriched);
      const existing = candidateMap.get(key);
      if (!existing || enriched.analysis.score > existing.analysis.score) {
        candidateMap.set(key, enriched);
      }
    }
  });

  const candidates = Array.from(candidateMap.values());
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.analysis.score - a.analysis.score);
  const topCandidates = candidates.slice(0, cfg.topCandidateCount);
  const bestScore = topCandidates[0].analysis.score;
  const weights = topCandidates.map((candidate) => {
    const delta = Math.max(0, bestScore - candidate.analysis.score);
    return Math.exp(-delta / cfg.scoreTemperature);
  });
  const selected = weightedPick(topCandidates, weights) || topCandidates[0];

  selected.analysis.metrics.candidateRank =
    topCandidates.findIndex((candidate) => candidate === selected) + 1;
  selected.analysis.metrics.candidatePool = candidates.length;

  return selected;
}

function createStatsFromDraws(type, inputDraws = [], recentPredictions = []) {
  const cfg = STRATEGY[type] || STRATEGY.ssq;
  const fallback = STATS[type] || STATS.ssq;
  const redMax = cfg.redMax;
  const blueMax = cfg.blueMax;
  const draws = inputDraws
    .filter((draw) => draw?.red?.length && draw?.blue?.length)
    .slice(0, cfg.historyLimit)
    .map((draw, index) => ({
      issue: draw.issue,
      red: draw.red.map(Number),
      blue: draw.blue.map(Number),
      weight: draw.weight ?? Math.pow(cfg.decay, index),
    }));

  if (draws.length < 5) {
    return {
      ...fallback,
      recentPredictions,
      draws,
      historyCount: draws.length,
    };
  }

  const redCounts = {};
  const blueCounts = {};
  const omissionRed = {};
  const omissionBlue = {};
  const neighborRedScores = {};
  const neighborBlueScores = {};
  const redPairScores = {};
  const bluePairScores = {};

  for (let i = 1; i <= redMax; i++) {
    redCounts[i] = 0;
    omissionRed[i] = draws.length;
    neighborRedScores[i] = 0;
  }
  for (let i = 1; i <= blueMax; i++) {
    blueCounts[i] = 0;
    omissionBlue[i] = draws.length;
    neighborBlueScores[i] = 0;
  }

  draws.forEach((draw, index) => {
    const weight = draw.weight;
    draw.red.forEach((n, idx) => {
      if (redCounts[n] != null) redCounts[n] += weight;
      if (omissionRed[n] === draws.length) omissionRed[n] = index;
      if (n > 1) neighborRedScores[n - 1] += weight;
      if (n < redMax) neighborRedScores[n + 1] += weight;
      for (let j = idx + 1; j < draw.red.length; j++) {
        const key = pairKey(n, draw.red[j]);
        redPairScores[key] = (redPairScores[key] || 0) + weight;
      }
    });

    draw.blue.forEach((n, idx) => {
      if (blueCounts[n] != null) blueCounts[n] += weight;
      if (omissionBlue[n] === draws.length) omissionBlue[n] = index;
      if (n > 1) neighborBlueScores[n - 1] += weight;
      if (n < blueMax) neighborBlueScores[n + 1] += weight;
      for (let j = idx + 1; j < draw.blue.length; j++) {
        const key = pairKey(n, draw.blue[j]);
        bluePairScores[key] = (bluePairScores[key] || 0) + weight;
      }
    });
  });

  const sortByFreq = (counts) =>
    Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([k]) => parseInt(k));

  const sortedReds = sortByFreq(redCounts);
  const sortedBlues = sortByFreq(blueCounts);
  const third = Math.floor(sortedReds.length / 3);
  const redHot = sortedReds.slice(0, third);
  const redWarm = sortedReds.slice(third, third * 2);
  const redCold = sortedReds.slice(third * 2);
  const blueHot = sortedBlues.slice(0, 5);

  const sumMode = modeFromBuckets(draws.map((d) => sumArray(d.red)), 5) || 0;
  const oddMode = modeFromBuckets(draws.map((d) => countOdd(d.red)), 1) || 0;
  const spanMode =
    modeFromBuckets(
      draws.map((d) => Math.max(...d.red) - Math.min(...d.red)),
      4,
    ) || 0;
  const hotMode =
    modeFromBuckets(
      draws.map((d) => d.red.filter((n) => redHot.includes(n)).length),
      1,
    ) || 0;
  const warmMode =
    modeFromBuckets(
      draws.map((d) => d.red.filter((n) => redWarm.includes(n)).length),
      1,
    ) || 0;
  const coldMode =
    modeFromBuckets(
      draws.map((d) => d.red.filter((n) => redCold.includes(n)).length),
      1,
    ) || 0;
  const blueMode =
    modeFromBuckets(
      draws.map((d) => d.blue.filter((n) => blueHot.includes(n)).length),
      1,
    ) || 0;

  return {
    hot: redHot,
    warm: redWarm,
    cold: redCold,
    blue_hot: blueHot,
    lastDraw: draws[0]
      ? {
          red: draws[0].red,
          blue: draws[0].blue,
        }
      : null,
    historyCount: draws.length,
    recentPredictions,
    draws,
    omissionRed,
    omissionBlue,
    neighborRedScores,
    neighborBlueScores,
    redPairScores,
    bluePairScores,
    templateProfile: {
      name: "template",
      sumMid: sumMode,
      oddMid: oddMode,
      spanMid: spanMode,
      sumRange: [Math.max(0, sumMode - 6), sumMode + 6],
      oddRange: [Math.max(0, oddMode - 1), oddMode + 1],
      spanRange: [Math.max(6, spanMode - 4), spanMode + 4],
      desiredGroup: {
        hot: hotMode,
        warm: warmMode,
        cold: coldMode,
      },
      blueTarget: blueMode,
    },
  };
}

/**
 * Helper: Shuffle array
 */
function shuffle(array) {
  let currentIndex = array.length,
    randomIndex;
  while (currentIndex != 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
  return array;
}

/**
 * Helper: Sample n elements
 */
function sample(array, n) {
  const shuffled = shuffle([...array]);
  return shuffled.slice(0, n);
}

/**
 * Analyze historical data to generate dynamic stats
 */
async function getDynamicStats(env, type) {
  try {
    const cfg = STRATEGY[type] || STRATEGY.ssq;
    let recentPredictions = [];
    try {
      const { results: recentPredictionRows = [] } = await env.DB.prepare(
        `SELECT red_predicted_nums, blue_predicted_nums FROM predictions
         WHERE lottery_type = ?
         ORDER BY create_time DESC LIMIT ?`,
      )
        .bind(type, cfg.recentPredictionLimit)
        .all();

      recentPredictions = recentPredictionRows
        .map((r) => {
          try {
            return {
              red: JSON.parse(r.red_predicted_nums).map(Number),
              blue: JSON.parse(r.blue_predicted_nums).map(Number),
            };
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {}

    // Fetch unique issues with results (recent draws get higher weight)
    const { results } = await env.DB.prepare(
      `SELECT issue, red_lottery_nums, blue_lottery_nums FROM predictions
       WHERE lottery_type = ? AND red_lottery_nums IS NOT NULL
       GROUP BY issue
       ORDER BY issue DESC LIMIT ?`,
    )
      .bind(type, cfg.historyLimit)
      .all();

    if (!results || results.length < 5) {
      return { ...STATS[type], recentPredictions }; // Fallback if insufficient data
    }

    const draws = [];
    results.forEach((r, index) => {
      const weight = Math.pow(cfg.decay, index);
      try {
        const reds = JSON.parse(r.red_lottery_nums);
        const blues = JSON.parse(r.blue_lottery_nums);
        const redNums = reds.map((n) => parseInt(n)).filter(Number.isFinite);
        const blueNums = blues.map((n) => parseInt(n)).filter(Number.isFinite);

        if (!redNums.length || !blueNums.length) return;
        draws.push({
          red: redNums,
          blue: blueNums,
          weight,
        });
      } catch (e) {}
    });
    return createStatsFromDraws(type, draws, recentPredictions);
  } catch (e) {
    // console.error("Stats error:", e);
    return STATS[type];
  }
}

function generateSmartSSQ(stats = STATS.ssq, algorithm = "ensemble") {
  return generateSmartPrediction("ssq", stats, algorithm);
}

function generateSmartDLT(stats = STATS.dlt, algorithm = "ensemble") {
  return generateSmartPrediction("dlt", stats, algorithm);
}

function normalizePredictionForRecent(prediction) {
  return {
    red: (prediction.red || []).map(Number),
    blue: (prediction.blue || []).map(Number),
  };
}

function normalizeNums(nums = []) {
  return nums.map((n) => n.toString().padStart(2, "0"));
}

function buildPredictionResponse(type, prediction, algorithm = "ensemble") {
  return {
    lottery_type: type,
    prediction,
    algorithm,
    strategy: prediction.strategy || "balanced",
    strategy_label: prediction.strategy_label || "多策略集成",
    confidence: prediction.analysis?.confidence || 80,
    analysis: prediction.analysis?.metrics || {},
  };
}

function buildAdaptiveAlgorithmPlan(backtestReport, count = 5, requestedAlgorithm = "ensemble") {
  const requested = normalizeAlgorithm(requestedAlgorithm);
  if (requested !== "ensemble") {
    return Array.from({ length: count }, () => requested);
  }

  const ranked = (backtestReport?.strategies || [])
    .filter((item) => item?.algorithm && Number.isFinite(item.score))
    .slice(0, 3);

  if (!ranked.length) {
    return Array.from({ length: count }, (_, index) =>
      index % 3 === 0 ? "balanced" : index % 3 === 1 ? "omission" : "ensemble",
    );
  }

  const plan = [];
  const topAlgorithms = ranked.map((item) => item.algorithm);
  plan.push(topAlgorithms[0]);
  if (count > 1) plan.push(topAlgorithms[1] || "ensemble");
  if (count > 2) plan.push("ensemble");

  const minScore = Math.min(...ranked.map((item) => item.score));
  const weights = ranked.map((item) => Math.max(0.2, item.score - minScore + 0.2));
  while (plan.length < count) {
    plan.push(weightedPick(topAlgorithms, weights) || "ensemble");
  }

  return plan.slice(0, count);
}

function summarizeAlgorithmPlan(plan = []) {
  const counts = {};
  plan.forEach((algorithm) => {
    const label = ALGORITHM_LABELS[algorithm] || algorithm;
    counts[label] = (counts[label] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([label, count]) => `${label}${count}组`)
    .join("、");
}

function generateBundlePredictions(
  type,
  stats,
  count = 5,
  algorithm = "ensemble",
  algorithmPlan = null,
) {
  const cfg = STRATEGY[type] || STRATEGY.ssq;
  const selected = [];
  const used = new Set();
  const workingStats = {
    ...stats,
    recentPredictions: [...(stats.recentPredictions || [])],
  };

  let attempts = 0;
  const plan = algorithmPlan?.length
    ? algorithmPlan
    : Array.from({ length: count }, () => algorithm);
  while (selected.length < count && attempts < count * 24) {
    attempts++;
    const targetAlgorithm = plan[selected.length] || algorithm;
    const candidate = generateSmartPrediction(type, workingStats, targetAlgorithm);
    if (!candidate) continue;

    const key = candidateKey(candidate);
    if (used.has(key)) continue;

    const maxRedOverlap = selected.reduce((max, item) => {
      return Math.max(max, intersectionCount(candidate.red, item.prediction.red));
    }, 0);
    const maxBlueOverlap = selected.reduce((max, item) => {
      return Math.max(max, intersectionCount(candidate.blue, item.prediction.blue));
    }, 0);

    if (
      selected.length > 0 &&
      (maxRedOverlap > cfg.maxRecentRedOverlap ||
        maxBlueOverlap > cfg.maxRecentBlueOverlap)
    ) {
      continue;
    }

    used.add(key);
    workingStats.recentPredictions.unshift(normalizePredictionForRecent(candidate));
    selected.push({
      ...buildPredictionResponse(type, candidate, targetAlgorithm),
      max_bundle_red_overlap: maxRedOverlap,
      max_bundle_blue_overlap: maxBlueOverlap,
    });
  }

  return selected;
}

async function savePredictionRecord(env, userId, lotteryType, redNums, blueNums) {
  const result = await env.DB.prepare(
    `INSERT INTO predictions (user_id, lottery_type, red_predicted_nums, blue_predicted_nums, create_time, issue)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      userId || "anonymous",
      lotteryType,
      JSON.stringify(normalizeNums(redNums || [])),
      JSON.stringify(normalizeNums(blueNums || [])),
      Date.now(),
    )
    .run();

  return result.meta.last_row_id;
}

async function savePredictionPlans(env, userId, lotteryType, plans = []) {
  const validPlans = plans.filter((plan) => {
    const prediction = plan.prediction || plan;
    return prediction?.red?.length && prediction?.blue?.length;
  });
  if (!validPlans.length) return [];

  const createdAt = Date.now();
  const statements = validPlans.map((plan) => {
    const prediction = plan.prediction || plan;
    return env.DB.prepare(
      `INSERT INTO predictions (user_id, lottery_type, red_predicted_nums, blue_predicted_nums, create_time, issue)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(
      userId || "anonymous",
      lotteryType,
      JSON.stringify(normalizeNums(prediction.red)),
      JSON.stringify(normalizeNums(prediction.blue)),
      createdAt,
    );
  });

  const results = await env.DB.batch(statements);
  return results.map((result, index) => {
    const id = result.meta?.last_row_id;
    const plan = validPlans[index];
    if (id != null) plan.saved_prediction_id = id;
    return id;
  }).filter((id) => id != null);
}

function pickSavedNumbers(prediction, recommendations = [], targetCost = 2) {
  const target = Number(targetCost);
  if (target > 2) {
    const compound = recommendations.find((item) => item.cost === target);
    if (compound?.red?.length && compound?.blue?.length) {
      return {
        red: compound.red,
        blue: compound.blue,
      };
    }
  }
  return {
    red: prediction.red,
    blue: prediction.blue,
  };
}

function calculateHitStats(type, prediction, draw) {
  const red = (prediction.red || []).map(Number);
  const blue = (prediction.blue || []).map(Number);
  const redHits = intersectionCount(red, draw.red);
  const blueHits = intersectionCount(blue, draw.blue);
  return {
    redHits,
    blueHits,
    totalHits: redHits + blueHits,
    prize: calculatePrizeOutput(
      type,
      red.map((n) => n.toString().padStart(2, "0")),
      blue.map((n) => n.toString().padStart(2, "0")),
      draw.red.map((n) => n.toString().padStart(2, "0")),
      draw.blue.map((n) => n.toString().padStart(2, "0")),
    ).text,
  };
}

function summarizeBacktest(type, rows, algorithm) {
  const rounds = rows.length || 1;
  const totalRed = rows.reduce((sum, row) => sum + row.redHits, 0);
  const totalBlue = rows.reduce((sum, row) => sum + row.blueHits, 0);
  const totalHits = rows.reduce((sum, row) => sum + row.totalHits, 0);
  const prizeHits = rows.filter((row) => row.prize).length;
  const best = rows.reduce((current, row) => {
    if (!current || row.totalHits > current.totalHits) return row;
    if (row.totalHits === current.totalHits && row.blueHits > current.blueHits) {
      return row;
    }
    return current;
  }, null);

  return {
    algorithm,
    label: ALGORITHM_LABELS[algorithm] || algorithm,
    rounds,
    avgRedHits: Math.round((totalRed / rounds) * 100) / 100,
    avgBlueHits: Math.round((totalBlue / rounds) * 100) / 100,
    avgTotalHits: Math.round((totalHits / rounds) * 100) / 100,
    blueHitRate: Math.round((rows.filter((row) => row.blueHits > 0).length / rounds) * 100),
    prizeHitRate: Math.round((prizeHits / rounds) * 100),
    best,
    score:
      totalRed / rounds +
      (totalBlue / rounds) * (type === "ssq" ? 2.2 : 1.5) +
      prizeHits / rounds,
  };
}

function runBacktest(type, draws, rounds = 20) {
  const cfg = STRATEGY[type] || STRATEGY.ssq;
  const algorithms = ["balanced", "omission", "neighbor", "matrix", "template", "ensemble"];
  const sortedDraws = [...draws]
    .filter((draw) => draw?.red?.length && draw?.blue?.length)
    .sort((a, b) => String(a.issue || "").localeCompare(String(b.issue || "")));
  const maxRounds = Math.max(1, Math.min(rounds, sortedDraws.length - 6));
  const startIndex = Math.max(5, sortedDraws.length - maxRounds);

  const summaries = algorithms.map((algorithm) => {
    const rows = [];
    for (let i = startIndex; i < sortedDraws.length; i++) {
      const history = sortedDraws
        .slice(Math.max(0, i - cfg.historyLimit), i)
        .reverse()
        .map((draw, index) => ({
          ...draw,
          weight: Math.pow(cfg.decay, index),
        }));
      const stats = createStatsFromDraws(type, history, []);
      const prediction = generateSmartPrediction(type, stats, algorithm);
      if (!prediction) continue;

      const hit = calculateHitStats(type, prediction, sortedDraws[i]);
      rows.push({
        issue: sortedDraws[i].issue,
        prediction: {
          red: prediction.red,
          blue: prediction.blue,
          strategy_label: prediction.strategy_label,
        },
        lottery: {
          red: sortedDraws[i].red.map((n) => n.toString().padStart(2, "0")),
          blue: sortedDraws[i].blue.map((n) => n.toString().padStart(2, "0")),
        },
        ...hit,
      });
    }
    return summarizeBacktest(type, rows, algorithm);
  });

  summaries.sort((a, b) => b.score - a.score);
  return {
    type,
    rounds: summaries[0]?.rounds || 0,
    recommended: summaries[0],
    strategies: summaries,
  };
}

async function getResultDraws(env, type, limit = 80) {
  const { results = [] } = await env.DB.prepare(
    `SELECT issue, red_lottery_nums, blue_lottery_nums, lottery_date, update_time
     FROM predictions
     WHERE lottery_type = ? AND red_lottery_nums IS NOT NULL
     GROUP BY issue
     ORDER BY issue DESC LIMIT ?`,
  )
    .bind(type, limit)
    .all();

  return results
    .map((r) => {
      try {
        return {
          issue: r.issue,
          red: JSON.parse(r.red_lottery_nums).map(Number),
          blue: JSON.parse(r.blue_lottery_nums).map(Number),
          time: r.lottery_date || r.update_time,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

async function getCachedBacktest(env, type, rounds = 20) {
  const cacheKey = `${type}:${rounds}`;
  const cached = backtestCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < BACKTEST_CACHE_TTL) {
    return cached.value;
  }

  if (backtestPending.has(cacheKey)) {
    return backtestPending.get(cacheKey);
  }

  const pending = (async () => {
    const limit = clamp(rounds + 50, 60, 100);
    const draws = await getResultDraws(env, type, limit);
    const value = {
      availableDraws: draws.length,
      report: draws.length >= 12 ? runBacktest(type, draws, rounds) : null,
    };
    backtestCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  })();

  backtestPending.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    backtestPending.delete(cacheKey);
  }
}

/**
 * Fallback Random Generator (from user example)
 */
const generateRandomUnique = (max, count) => {
  const nums = new Set();
  while (nums.size < count) {
    nums.add(Math.floor(Math.random() * max) + 1);
  }
  return Array.from(nums)
    .sort((a, b) => a - b)
    .map((n) => n.toString().padStart(2, "0"));
};

/**
 * Generate 10-yuan / 14-yuan Compound Recommendations (Fushi)
 * Based on the generated single prediction, expand to cover more numbers.
 * @param {string} type - 'ssq' or 'dlt'
 * @param {object} base - The base prediction object {red: [], blue: []}
 * @param {object} stats - Historical statistics
 * @param {number} targetCost - Optional. If provided, generate ONLY this cost recommendation.
 */
function generateCompoundRecommendations(type, base, stats, targetCost = 0) {
  const recommendations = [];
  const { hot, warm, cold, blue_hot } = stats;

  const poolRed = hot && warm && cold ? [...hot, ...warm, ...cold] : [];
  // Ensure blue_hot exists
  const poolBlue = blue_hot && blue_hot.length ? [...blue_hot] : [];

  // Convert base strings to numbers for comparison
  const baseRedNums = base.red.map(Number);
  const baseBlueNums = base.blue.map(Number);

  if (type === "ssq") {
    // 1. 10 Yuan Compound (6+5) - Prize: 10 RMB
    if (targetCost === 0 || targetCost === 10) {
      // Logic: Keep 6 reds, Add 4 blues to make 5 blues
      // 5 Blue bets = C(6,6)*C(5,1) * 2 = 1 * 5 * 2 = 10
      const targetBlueCount = 5;
      const neededBlues = targetBlueCount - baseBlueNums.length; // usually 5-1 = 4

      if (neededBlues > 0) {
        // Prepare blue pool (prefer hot)
        let bPool = poolBlue.filter((n) => !baseBlueNums.includes(n));
        // Fill with 1-16 if not enough
        const allBlues = Array.from({ length: 16 }, (_, i) => i + 1);
        const restBlues = allBlues.filter(
          (n) => !baseBlueNums.includes(n) && !bPool.includes(n),
        );
        bPool = [...bPool, ...restBlues];

        const addedBlues = sample(bPool, neededBlues);
        const finalBlues = [...baseBlueNums, ...addedBlues].sort(
          (a, b) => a - b,
        );

        recommendations.push({
          type: "10元复式 (6+5)",
          desc: "红球不变，蓝球扩充至5个",
          cost: 10,
          red: base.red,
          blue: finalBlues.map((n) => n.toString().padStart(2, "0")),
        });
      }
    }

    // 2. 14 Yuan Compound (7+1) - Prize: 14 RMB
    if (targetCost === 0 || targetCost === 14) {
      // Logic: Add 1 red, Keep 1 blue
      // 7 Red bets = C(7,6)*C(1,1) * 2 = 7 * 1 * 2 = 14
      const targetRedCount = 7;
      const neededReds = targetRedCount - baseRedNums.length; // usually 7-6 = 1

      if (neededReds > 0) {
        let rPool = poolRed.filter((n) => !baseRedNums.includes(n));
        // Fallback if stats empty
        if (rPool.length < neededReds) {
          const allReds = Array.from({ length: 33 }, (_, i) => i + 1);
          rPool = allReds.filter((n) => !baseRedNums.includes(n));
        }

        const addedReds = sample(rPool, neededReds);
        const finalReds = [...baseRedNums, ...addedReds].sort((a, b) => a - b);

        recommendations.push({
          type: "14元复式 (7+1)",
          desc: "红球扩充至7个，蓝球不变",
          cost: 14,
          red: finalReds.map((n) => n.toString().padStart(2, "0")),
          blue: base.blue,
        });
      }
    }
  } else {
    // DLT
    // 12 Yuan: 6 Red + 2 Blue (Standard Small Compound)
    if (targetCost === 0 || targetCost === 12) {
      // C(6,5)*C(2,2)*2 = 6 * 1 * 2 = 12
      const targetRedCount = 6;
      const neededReds = targetRedCount - baseRedNums.length; // 6-5 = 1
      if (neededReds > 0) {
        let rPool = poolRed.filter((n) => !baseRedNums.includes(n));
        if (rPool.length === 0)
          rPool = Array.from({ length: 35 }, (_, i) => i + 1).filter(
            (n) => !baseRedNums.includes(n),
          );

        const addedReds = sample(rPool, neededReds);
        const finalReds = [...baseRedNums, ...addedReds].sort((a, b) => a - b);

        recommendations.push({
          type: "12元复式 (6+2)",
          desc: "红球扩充至6个，蓝球不变 (大乐透无14元复式)",
          cost: 12,
          red: finalReds.map((n) => n.toString().padStart(2, "0")),
          blue: base.blue,
        });
      }
    }

    // 6 Yuan: 5 Red + 3 Blue
    if (targetCost === 0 || targetCost === 6) {
      // C(5,5)*C(3,2)*2 = 1 * 3 * 2 = 6
      const targetBlueCount = 3;
      const neededBlues = targetBlueCount - baseBlueNums.length; // 3-2 = 1
      if (neededBlues > 0) {
        let bPool = poolBlue.filter((n) => !baseBlueNums.includes(n));
        const allBlues = Array.from({ length: 12 }, (_, i) => i + 1);
        const restBlues = allBlues.filter(
          (n) => !baseBlueNums.includes(n) && !bPool.includes(n),
        );
        bPool = [...bPool, ...restBlues];

        const addedBlues = sample(bPool, neededBlues);
        const finalBlues = [...baseBlueNums, ...addedBlues].sort(
          (a, b) => a - b,
        );

        recommendations.push({
          type: "6元复式 (5+3)",
          desc: "红球不变，蓝球扩充至3个",
          cost: 6,
          red: base.red,
          blue: finalBlues.map((n) => n.toString().padStart(2, "0")),
        });
      }
    }
  }

  return recommendations;
}

/**
 * Main Logic Handler
 */
async function handlePredictBundle(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const userId = request.headers.get("x-user-id") || "anonymous";
    const lotteryType = body.lotteryType || body.lottery_type || "ssq";
    const algorithm = body.algorithm || "ensemble";
    const count = clamp(parseInt(body.count || "5"), 2, 10);
    const stats = await getDynamicStats(env, lotteryType);
    const requestedMode = normalizeAlgorithm(algorithm);
    let backtestReport = null;
    let algorithmPlan = null;

    if (requestedMode === "ensemble") {
      try {
        const backtest = await getCachedBacktest(env, lotteryType, 20);
        if (backtest.report) {
          backtestReport = backtest.report;
          algorithmPlan = buildAdaptiveAlgorithmPlan(backtestReport, count, algorithm);
        }
      } catch (e) {
        // 回测只影响策略加权，失败时继续使用默认集成策略。
      }
    }

    const plans = generateBundlePredictions(
      lotteryType,
      stats,
      count,
      algorithm,
      algorithmPlan,
    );
    let savedIds = [];
    let saveError = null;
    try {
      savedIds = await savePredictionPlans(env, userId, lotteryType, plans);
    } catch (e) {
      saveError = "方案已生成，但保存历史失败，请稍后再试";
    }
    const actualPlan = plans.map((plan) => plan.algorithm || plan.strategy || algorithm);

    return jsonResponse({
      success: true,
      data: {
        lottery_type: lotteryType,
        count: plans.length,
        plans,
        saved_prediction_ids: savedIds,
        saved: savedIds.length === plans.length && plans.length > 0,
        save_attempted: true,
        save_error: saveError,
        strategy_source: backtestReport ? "backtest_adaptive" : "default_diversified",
        strategy_plan: actualPlan,
        strategy_plan_summary: summarizeAlgorithmPlan(actualPlan),
        backtest_recommended: backtestReport?.recommended || null,
      },
      message: "Bundle predicted successfully",
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function handleBacktest(request, env, url) {
  try {
    let body = {};
    if (request.method === "POST") {
      body = await request.json().catch(() => ({}));
    }
    const lotteryType =
      body.lotteryType || body.lottery_type || url.searchParams.get("type") || "ssq";
    const rounds = clamp(
      parseInt(body.rounds || url.searchParams.get("rounds") || "20"),
      8,
      40,
    );
    const backtest = await getCachedBacktest(env, lotteryType, rounds);

    if (!backtest.report) {
      return jsonResponse({
        success: true,
        data: {
          type: lotteryType,
          available: false,
          available_draws: backtest.availableDraws,
          minimum_draws: 12,
          rounds: 0,
          recommended: null,
          strategies: [],
          notice: `当前已回填${backtest.availableDraws}期开奖数据，满12期后显示回测排名；当前预测使用基础集成策略`,
        },
        message: "Backtest is waiting for more draw data",
      });
    }

    return jsonResponse({
      success: true,
      data: backtest.report,
      message: "Backtested successfully",
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function handlePredict(request, env) {
  try {
    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch (e) {}
    } else {
      const url = new URL(request.url);
      body = {
        lotteryType: url.searchParams.get("type") || "ssq",
        algorithm: url.searchParams.get("algo") || "history_weighted",
        cost: parseInt(url.searchParams.get("cost") || "2"),
      };
    }

    const {
      lotteryType = "ssq",
      algorithm = "ensemble",
      cost = 2,
    } = body;
    const userId = request.headers.get("x-user-id") || "anonymous";
    const autoSave = body.autoSave !== false;
    const isSSQ = lotteryType === "ssq";
    // Ensure cost is integer
    const targetCost = parseInt(cost);

    // 1. Get Dynamic Stats (History Analysis)
    const stats = await getDynamicStats(env, lotteryType);
    const requestedMode = normalizeAlgorithm(algorithm);
    let resolvedAlgorithm = requestedMode;
    let backtestReport = null;
    if (requestedMode === "ensemble") {
      try {
        const backtest = await getCachedBacktest(env, lotteryType, 20);
        if (backtest.report) {
          backtestReport = backtest.report;
          resolvedAlgorithm = backtestReport.recommended?.algorithm || requestedMode;
        }
      } catch (e) {
        resolvedAlgorithm = requestedMode;
      }
    }

    // Try smart generation first
    let prediction = null;
    if (isSSQ) {
      prediction = generateSmartSSQ(stats, resolvedAlgorithm);
    } else {
      prediction = generateSmartDLT(stats, resolvedAlgorithm);
    }

    // Fallback if smart gen failed or not applicable
    if (!prediction) {
      const redMax = isSSQ ? 33 : 35;
      const blueMax = isSSQ ? 16 : 12;
      const redCount = isSSQ ? 6 : 5;
      const blueCount = isSSQ ? 1 : 2;

      prediction = {
        red: generateRandomUnique(redMax, redCount),
        blue: generateRandomUnique(blueMax, blueCount),
        strategy: "random",
        strategy_label: "随机兜底",
      };
    }

    if (!prediction.analysis) {
      const cfg = STRATEGY[lotteryType] || STRATEGY.ssq;
      prediction.analysis = analyzeCandidate(
        prediction.red.map(Number),
        prediction.blue.map(Number),
        stats,
        cfg,
      );
    }

    if (!prediction.strategy_label) {
      prediction.strategy_label =
        ALGORITHM_LABELS[prediction.strategy] || "多策略集成";
    }

    // Generate Compound Recommendations based on the single prediction
    // Only if requested cost > 2, or if explicitly requested (cost=0 could mean all?)
    // Here we respect targetCost if > 2.
    let recommendations = [];
    if (targetCost > 2) {
      try {
        recommendations = generateCompoundRecommendations(
          lotteryType,
          prediction,
          stats,
          targetCost,
        );
      } catch (e) {
        // ignore error
      }
    }

    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const diff = now - startOfYear;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    const issueNum = Math.floor(dayOfYear / 2.5) + 1;
    const issueStr = `${now.getFullYear()}${issueNum.toString().padStart(3, "0")}`;

    const predictionResult = {
      lottery_type: lotteryType,
      issue: issueStr,
      prediction: prediction,
      compounds: recommendations,
      algorithm: algorithm,
      resolved_algorithm: resolvedAlgorithm,
      strategy: prediction.strategy || "balanced",
      strategy_label: prediction.strategy_label || "多策略集成",
      confidence: prediction.analysis.confidence,
      analysis: prediction.analysis.metrics,
      strategy_source: backtestReport
        ? "backtest_adaptive"
        : requestedMode === "ensemble"
          ? "ensemble_fallback"
          : "fixed_strategy",
      backtest_recommended: backtestReport?.recommended || null,
      create_time: now,
    };

    if (autoSave) {
      predictionResult.save_attempted = true;
      try {
        const savedNumbers = pickSavedNumbers(prediction, recommendations, targetCost);
        predictionResult.saved_prediction_id = await savePredictionRecord(
          env,
          userId,
          lotteryType,
          savedNumbers.red,
          savedNumbers.blue,
        );
        predictionResult.saved = true;
      } catch (e) {
        predictionResult.saved = false;
        predictionResult.save_error = "号码已生成，但保存历史失败，请稍后再试";
      }
    }

    return jsonResponse({
      success: true,
      data: predictionResult,
      message: "Predicted successfully",
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

// 2. 保存预测
async function handleSavePrediction(request, env) {
  try {
    const body = await request.json();
    const userId = request.headers.get("x-user-id") || "anonymous";
    const { lottery_type, red_predicted_nums, blue_predicted_nums } = body;

    const predictionId = await savePredictionRecord(
      env,
      userId,
      lottery_type,
      red_predicted_nums,
      blue_predicted_nums,
    );
    return jsonResponse({
      success: true,
      predictionId,
      message: "Saved successfully",
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

// 3. 获取历史记录
async function handleGetHistory(request, env, url) {
  try {
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const page = parseInt(url.searchParams.get("page") || "1");
    // 增加 mode 参数: 'top' (默认,只返回中奖记录按命中数排序) | 'all' (所有记录按时间倒序) | 'mine' (我的记录)
    const mode = url.searchParams.get("mode") || "top";
    // 从 Header 或 URL 参数获取 userId
    const userId =
      request.headers.get("x-user-id") || url.searchParams.get("userId");
    const offset = (page - 1) * limit;

    let sql = "";
    let params = [];

    if (mode === "mine" && userId) {
      // 查询我的所有记录（按时间倒序）
      sql = `SELECT * FROM predictions WHERE user_id = ? ORDER BY create_time DESC LIMIT ? OFFSET ?`;
      params = [userId, limit, offset];
    } else if (mode === "all") {
      // 查询全网所有记录（按时间倒序）
      sql = `SELECT * FROM predictions ORDER BY create_time DESC LIMIT ? OFFSET ?`;
      params = [limit, offset];
    } else {
      // 默认：按总奖金倒序；浮动奖金按奖级优先，同金额再按命中数和时间排序。
      sql = `SELECT *,
        CASE
          WHEN prize_level LIKE '一等奖%' THEN 1000000000000
          WHEN prize_level LIKE '二等奖%' THEN 100000000000
          WHEN instr(prize_level, '共') > 0 THEN CAST(
            substr(
              prize_level,
              instr(prize_level, '共') + 1,
              instr(prize_level, '元') - instr(prize_level, '共') - 1
            ) AS INTEGER
          )
          WHEN instr(prize_level, '(') > 0 AND instr(prize_level, '元') > instr(prize_level, '(') THEN CAST(
            substr(
              prize_level,
              instr(prize_level, '(') + 1,
              instr(prize_level, '元') - instr(prize_level, '(') - 1
            ) AS INTEGER
          )
          ELSE 0
        END AS prize_amount
      FROM predictions
      WHERE issue IS NOT NULL AND prize_level IS NOT NULL
      ORDER BY prize_amount DESC, hit_count DESC, create_time DESC
      LIMIT ? OFFSET ?`;
      params = [limit, offset];
    }

    const { results } = await env.DB.prepare(sql)
      .bind(...params)
      .all();

    const formatted = results.map((r) => {
      const predRed = JSON.parse(r.red_predicted_nums);
      const predBlue = JSON.parse(r.blue_predicted_nums);
      const drawRed = r.red_lottery_nums ? JSON.parse(r.red_lottery_nums) : [];
      const drawBlue = r.blue_lottery_nums
        ? JSON.parse(r.blue_lottery_nums)
        : [];

      // Calculate hits for display
      const redHits = predRed.filter((n) => drawRed.includes(n)).length;
      const blueHits = predBlue.filter((n) => drawBlue.includes(n)).length;

      return {
        ...r,
        red_predicted_nums: predRed,
        blue_predicted_nums: predBlue,
        red_lottery_nums: drawRed,
        blue_lottery_nums: drawBlue,
        // Added for frontend distinction
        hit_detail: {
          red: redHits,
          blue: blueHits,
        },
      };
    });

    return jsonResponse({
      success: true,
      data: { history: { data: formatted } },
    });
  } catch (e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

// --- 奖金计算辅助函数 ---

function getCombinations(arr, k) {
  if (k === 1) return arr.map((e) => [e]);
  if (k === arr.length) return [arr];
  if (k > arr.length) return [];
  const res = [];
  function helper(start, combo) {
    if (combo.length === k) {
      res.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return res;
}

function calculatePrizeOutput(type, userRed, userBlue, winRed, winBlue) {
  let totalMoney = 0;
  let maxPrizeText = "";
  let prizeDetails = {}; // "三等奖": 2
  let hitCount = 0; // Just for sorting, max single hit

  // 1. Expand standard bets
  let redCombos = [];
  let blueCombos = [];

  if (type === "ssq") {
    // SSQ Standard: 6 Red, 1 Blue from selection
    redCombos = getCombinations(userRed, 6);
    blueCombos = getCombinations(userBlue, 1);
  } else {
    // DLT Standard: 5 Red, 2 Blue from selection
    redCombos = getCombinations(userRed, 5);
    blueCombos = getCombinations(userBlue, 2);
  }

  // Check each combination
  for (const rC of redCombos) {
    for (const bC of blueCombos) {
      const rHits = rC.filter((n) => winRed.includes(n)).length;
      const bHits = bC.filter((n) => winBlue.includes(n)).length;
      const currentHitCount = rHits + bHits;
      if (currentHitCount > hitCount) hitCount = currentHitCount;

      let prizeName = null;
      let money = 0;

      if (type === "ssq") {
        if (rHits === 6 && bHits === 1) prizeName = "一等奖";
        else if (rHits === 6 && bHits === 0) prizeName = "二等奖";
        else if (rHits === 5 && bHits === 1) {
          prizeName = "三等奖";
          money = 3000;
        } else if (rHits === 5 && bHits === 0) {
          prizeName = "四等奖";
          money = 200;
        } else if (rHits === 4 && bHits === 1) {
          prizeName = "四等奖";
          money = 200;
        } else if (rHits === 4 && bHits === 0) {
          prizeName = "五等奖";
          money = 10;
        } else if (rHits === 3 && bHits === 1) {
          prizeName = "五等奖";
          money = 10;
        } else if (
          (rHits === 2 && bHits === 1) ||
          (rHits === 1 && bHits === 1) ||
          (rHits === 0 && bHits === 1)
        ) {
          prizeName = "六等奖";
          money = 5;
        }
      } else {
        // DLT
        if (rHits === 5 && bHits === 2) prizeName = "一等奖";
        else if (rHits === 5 && bHits === 1) prizeName = "二等奖";
        else if (rHits === 5 && bHits === 0) {
          prizeName = "三等奖";
          money = 10000;
        } else if (rHits === 4 && bHits === 2) {
          prizeName = "四等奖";
          money = 3000;
        } else if (rHits === 4 && bHits === 1) {
          prizeName = "五等奖";
          money = 300;
        } else if (rHits === 3 && bHits === 2) {
          prizeName = "六等奖";
          money = 200;
        } else if (rHits === 4 && bHits === 0) {
          prizeName = "七等奖";
          money = 100;
        } else if (
          (rHits === 3 && bHits === 1) ||
          (rHits === 2 && bHits === 2)
        ) {
          prizeName = "八等奖";
          money = 15;
        } else if (
          (rHits === 3 && bHits === 0) ||
          (rHits === 2 && bHits === 1) ||
          (rHits === 1 && bHits === 2) ||
          (rHits === 0 && bHits === 2)
        ) {
          prizeName = "九等奖";
          money = 5;
        }
      }

      if (prizeName) {
        totalMoney += money;
        prizeDetails[prizeName] = (prizeDetails[prizeName] || 0) + 1;
        // Logic for max prize text (Simple priority)
        if (!maxPrizeText) maxPrizeText = prizeName;
        else {
          const priority = [
            "一等奖",
            "二等奖",
            "三等奖",
            "四等奖",
            "五等奖",
            "六等奖",
            "七等奖",
            "八等奖",
            "九等奖",
          ];
          if (priority.indexOf(prizeName) < priority.indexOf(maxPrizeText)) {
            maxPrizeText = prizeName;
          }
        }
      }
    }
  }

  // Format Result String
  if (!maxPrizeText) return { text: null, hits: hitCount };

  let text = maxPrizeText;
  // If compound win (determined by total combos > 1 and money > 0)
  // Or just show total money if money > 0
  if (totalMoney > 0) {
    if (
      Object.keys(prizeDetails).length > 1 ||
      prizeDetails[maxPrizeText] > 1
    ) {
      // Compound summary
      // E.g. "三等奖等 (共3200元)"
      text += `等 (共${totalMoney}元)`;
    } else {
      // Single win with money
      text += ` (${totalMoney}元)`;
    }
  } else {
    // Floating prize only (1st/2nd)
    text += "(浮动奖金)";
  }

  return { text, hits: hitCount };
}

// 4. 定时任务 & 数据抓取逻辑
async function handleScheduled(env) {
  const API_CONFIG = {
    ssq: {
      url: "https://alpha.lottery.sina.com.cn/gateway/index/entry?format=json&__caller__=wap&__version__=1.0.0&__verno__=10000&cat1=gameOpenList&lottoType=101&paginationType=1&page=1&pageSize=20&dpc=1",
      type: 101,
      cutoffHour: 20,
    },
    dlt: {
      url: "https://alpha.lottery.sina.com.cn/gateway/index/entry?format=json&__caller__=wap&__version__=1.0.0&__verno__=10000&cat1=gameOpenList&lottoType=201&paginationType=1&page=1&pageSize=20&dpc=1",
      type: 201,
      cutoffHour: 21,
    },
  };

  const types = ["ssq", "dlt"];
  const logs = [];

  for (const type of types) {
    try {
      const resp = await fetch(API_CONFIG[type].url);
      const data = await resp.json();

      if (
        data &&
        data.result &&
        data.result.data &&
        data.result.data.length > 0
      ) {
        const latest = data.result.data[0];
        const issueNo = latest.issueNo;
        const openTimeStr = latest.openTime;
        const openDateObj = new Date(openTimeStr);
        const year = openDateObj.getFullYear();
        const month = openDateObj.getMonth();
        const day = openDateObj.getDate();

        // 设定截止时间
        const cutoffTime = new Date(
          year,
          month,
          day,
          API_CONFIG[type].cutoffHour,
          0,
          0,
        ).getTime();

        // 解析红蓝球结果 (兼容 openCode)
        let currentRed = latest.redResults;
        let currentBlue = latest.blueResults;
        if ((!currentRed || !currentRed.length) && latest.openCode) {
          const parts = latest.openCode.split("+");
          if (parts.length >= 1) currentRed = parts[0].split(",");
          if (parts.length >= 2) currentBlue = parts[1].split(",");
        }

        // Ensure format
        if (!currentRed || !currentBlue) continue;
        // clean up parsing if they are strings in array? Assuming they are correct strings "01" etc.

        // 查找在该【截止时间】之前创建且未开奖的预测
        const { results: pendingList } = await env.DB.prepare(
          `SELECT * FROM predictions WHERE lottery_type = ? AND issue IS NULL AND create_time <= ?`,
        )
          .bind(type, cutoffTime)
          .all();

        for (const r of pendingList) {
          let userRed = [];
          let userBlue = [];
          try {
            userRed = JSON.parse(r.red_predicted_nums);
            userBlue = JSON.parse(r.blue_predicted_nums);
          } catch (e) {
            continue;
          }

          // Calculate Prize (Compound Aware)
          const { text: prize_level_txt, hits: maxHits } = calculatePrizeOutput(
            type,
            userRed,
            userBlue,
            currentRed,
            currentBlue,
          );

          await env.DB.prepare(
            `UPDATE predictions SET issue = ?, prize_level = ?, red_lottery_nums = ?, blue_lottery_nums = ?, hit_count = ?, lottery_date = ?, update_time = ? WHERE id = ?`,
          )
            .bind(
              issueNo,
              prize_level_txt,
              JSON.stringify(currentRed),
              JSON.stringify(currentBlue),
              maxHits, // Uses the best single bet hit count for sorting
              openDateObj.getTime(),
              Date.now(),
              r.id,
            )
            .run();
        }
        logs.push(
          `Updated ${pendingList.length} records for ${type} issue ${issueNo} (Cutoff: ${new Date(cutoffTime).toLocaleString()})`,
        );
      }
    } catch (e) {
      logs.push(`Error processing ${type}: ${e.message}`);
    }
  }

  return jsonResponse({ success: true, logs });
}
