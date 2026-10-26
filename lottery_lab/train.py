"""Reproducible chronological experiments. No jackpot 'confidence' scores."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import uuid

import numpy as np

from pipeline import CONFIG, DATA, ROOT, audit, connect, load_draws, now

VERSION = "chronological-logistic-v1"
HISTORY_NAMES = ["frequency20", "frequency60", "frequency200", "omission", "previous", "previous2", "number", "odd", "neighbor_previous"]
META_NAMES = ["log_sales", "log_pool", "log_first_stakes", "log_first_amount", "region_concentration", "sales_missing", "pool_missing", "prize_missing", "regions_missing"]


def labels(draws, pool, maximum):
    result = np.zeros((len(draws), maximum), dtype=np.float64)
    for i, draw in enumerate(draws):
        result[i, np.array(draw[pool]) - 1] = 1
    return result


def metadata(draws, index, target_date):
    # At least TWO draws lag, plus an explicit 48h-after-draw-date embargo.
    # This is a conservative retrospective proxy, not a verified publication time.
    cutoff = dt.date.fromisoformat(target_date)
    j = index - 2
    while j >= 0 and dt.date.fromisoformat(draws[j]["draw_date"]) + dt.timedelta(days=2) > cutoff:
        j -= 1
    if j < 0:
        return np.zeros(len(META_NAMES)), None
    d = draws[j]
    first = next((p for p in d["prize_tiers"] if p["label"] in ("1等奖", "一等奖")), {})
    sales, pool, stakes, amount = d["sales_cents"], d["pool_cents"], first.get("stakes"), first.get("amount_cents")
    if "pool_zero_unverified" in d.get("metadata_flags", []):
        pool = None
    counts = [r["first_prize_stakes"] for r in d["regions"]]
    if sum(counts) != stakes:
        counts = []  # Partial regional lists must not masquerade as full distributions.
    total = sum(counts)
    concentration = sum((n / total) ** 2 for n in counts) if total else 0
    values = [math.log1p((sales or 0) / 100), math.log1p((pool or 0) / 100),
              math.log1p(stakes or 0), math.log1p((amount or 0) / 100), concentration,
              float(sales is None), float(pool is None), float(stakes is None), float(not counts)]
    return np.array(values), j


def feature_at(draws, y, index, target_date):
    maximum = y.shape[1]
    probability = y[0].sum() / maximum
    past = y[:index]
    numbers = np.arange(1, maximum + 1)
    rates = [(past[-window:].sum(axis=0) + probability * 50) / (min(window, index) + 50) - probability
             for window in (20, 60, 200)]
    omission = np.zeros(maximum)
    for n in range(maximum):
        hits = np.flatnonzero(past[:, n])
        omission[n] = min(index - 1 - hits[-1] if len(hits) else index, 120) / 60
    neighbor = np.zeros(maximum)
    neighbor[1:] += past[-1, :-1]
    neighbor[:-1] += past[-1, 1:]
    history = np.column_stack([*rates, omission, past[-1], past[-2], numbers / maximum, numbers % 2, neighbor])
    meta, meta_index = metadata(draws, index, target_date)
    # Draw-level context needs interactions to distinguish different numbers.
    interactions = (history[:, [0, 1, 3, 6, 7], None] * meta[None, None, :]).reshape(maximum, -1)
    return history, np.column_stack([history, interactions]), meta_index


def make_features(draws, pool, maximum):
    y = labels(draws, pool, maximum)
    history, augmented, targets, indices = [], [], [], []
    for i in range(200, len(draws)):
        h, a, _ = feature_at(draws, y, i, draws[i]["draw_date"])
        history.append(h)
        augmented.append(a)
        targets.append(y[i])
        indices.append(i)
    return np.array(history), np.array(augmented), np.array(targets), indices, y


def fit(x, y, regularization):
    flat = x.reshape(-1, x.shape[-1])
    target = y.reshape(-1)
    mean = flat.mean(axis=0)
    scale = flat.std(axis=0)
    scale[scale < 1e-8] = 1
    z = np.clip((flat - mean) / scale, -6, 6)
    weight = np.zeros(z.shape[1])
    base = float(target.mean())
    intercept = math.log(base / (1 - base))
    for _ in range(220):
        linear = np.clip(z @ weight + intercept, -25, 25)
        error = 1 / (1 + np.exp(-linear)) - target
        weight -= 0.08 * (z.T @ error / len(error) + regularization * weight)
        intercept -= 0.08 * error.mean()
    return dict(mean=mean.tolist(), scale=scale.tolist(), weight=weight.tolist(), intercept=float(intercept), regularization=regularization)


def predict(model, x, count):
    z = np.clip((x - np.array(model["mean"])) / np.array(model["scale"]), -6, 6)
    logits = z @ np.array(model["weight"]) + model["intercept"]
    # Project marginal inclusion probabilities to the known fixed number count.
    low, high = np.full(logits.shape[:-1] + (1,), -40.), np.full(logits.shape[:-1] + (1,), 40.)
    for _ in range(55):
        offset = (low + high) / 2
        probs = 1 / (1 + np.exp(-np.clip(logits + offset, -40, 40)))
        too_low = probs.sum(axis=-1, keepdims=True) < count
        low = np.where(too_low, offset, low)
        high = np.where(too_low, high, offset)
    return 1 / (1 + np.exp(-np.clip(logits + (low + high) / 2, -40, 40)))


def frequency_predictions(y, indices, window):
    base = y[0].mean()
    return np.array([(y[max(0, i - window):i].sum(axis=0) + 50 * base) / (min(i, window) + 50) for i in indices])


def scores(probs, target):
    p = np.clip(probs, 1e-10, 1 - 1e-10)
    return ((p - target) ** 2).mean(axis=1), -(target * np.log(p) + (1 - target) * np.log1p(-p)).mean(axis=1)


def bootstrap_interval(delta, seed, confidence=.99):
    rng = np.random.default_rng(seed)
    block = 10
    offsets = np.arange(block)
    samples = []
    for _ in range(2000):
        starts = rng.integers(0, len(delta), size=math.ceil(len(delta) / block))
        ids = ((starts[:, None] + offsets) % len(delta)).reshape(-1)[:len(delta)]
        samples.append(float(delta[ids].mean()))
    tail = (1 - confidence) / 2
    return [float(v) for v in np.quantile(samples, [tail, 1 - tail])]


def metric(probs, target, base_probs, seed):
    brier, loss = scores(probs, target)
    base_brier, _ = scores(base_probs, target)
    return dict(brier=float(brier.mean()), marginal_log_loss=float(loss.mean()),
                brier_delta_vs_uniform=float((brier - base_brier).mean()),
                delta_99pct_block_bootstrap_ci=bootstrap_interval(brier - base_brier, seed))


def sample_pool(rng, weights, count):
    candidates = list(range(1, len(weights) + 1))
    selected = []
    for _ in range(count):
        w = [weights[n - 1] for n in candidates]
        chosen = rng.choices(candidates, weights=w, k=1)[0]
        selected.append(chosen)
        candidates.remove(chosen)
    return sorted(selected)


def tickets(kind, count, seed, probabilities=None):
    if kind not in CONFIG or type(count) is not int or not 1 <= count <= 20:
        raise ValueError("lottery_type must be ssq/dlt and count must be 1..20")
    rm, rc, bm, bc = CONFIG[kind]
    rng = random.Random(seed)
    probabilities = probabilities or dict(red=[1] * rm, blue=[1] * bm)
    seen, plans = set(), []
    while len(plans) < count:
        red = sample_pool(rng, probabilities["red"], rc)
        blue = sample_pool(rng, probabilities["blue"], bc)
        key = (tuple(red), tuple(blue))
        if key not in seen:
            seen.add(key)
            plans.append(dict(red=[f"{n:02d}" for n in red], blue=[f"{n:02d}" for n in blue]))
    return plans


def next_date(kind, last_date):
    # Schedule estimate only, holidays or temporary suspensions require official confirmation.
    days = {"ssq": (1, 3, 6), "dlt": (0, 2, 5)}[kind]
    day = dt.date.fromisoformat(last_date) + dt.timedelta(days=1)
    while day.weekday() not in days:
        day += dt.timedelta(days=1)
    return day.isoformat()


def ticket_evaluation(kind, draws, pools, sl, name, seed):
    rm, rc, bm, bc = CONFIG[kind]
    results = []
    for i in range(sl.start, sl.stop):
        probabilities = {p: pools[p]["predictions"][name][i].tolist() for p in pools}
        # Common random seeds and exactly 5 distinct basic tickets for every model.
        plans = tickets(kind, 5, seed + i, probabilities)
        truth = draws[200 + i]
        hits = [(len(set(map(int, p["red"])) & set(truth["red"])),
                 len(set(map(int, p["blue"])) & set(truth["blue"]))) for p in plans]
        results.append(hits)
    array = np.array(results)
    full = (array[:, :, 0] == rc) & (array[:, :, 1] == bc)
    return dict(draws=len(results), tickets_per_draw=5, cost_yuan_per_draw=10,
                jackpot_draws=int(full.any(axis=1).sum()), jackpot_tickets=int(full.sum()),
                mean_red_hits_per_ticket=float(array[:, :, 0].mean()),
                mean_blue_hits_per_ticket=float(array[:, :, 1].mean()),
                sampling="fixed_seed_sequential_weighted_without_replacement; marginal scores are NOT joint ticket probabilities")


def evaluation_slices(draws, reference=None):
    """Freeze the original holdout boundaries when daily data is appended."""
    n = len(draws) - 200
    if reference is None:
        train_end, val_end = int(n * .6), int(n * .8)
        return dict(train=slice(0, train_end), validation=slice(train_end, val_end), test=slice(val_end, n))
    lookup = {d["issue"]: i for i, d in enumerate(draws[200:])}
    result, end = {}, 0
    for name in ("train", "validation", "test"):
        split = reference["split"][name]
        start, stop = lookup[split["first_issue"]], lookup[split["last_issue"]] + 1
        if start != end or stop - start != split["count"]:
            raise ValueError("Frozen evaluation dataset changed; review required")
        result[name] = slice(start, stop)
        end = stop
    return result


def train_kind(draws, kind, seed, reference=None):
    if len(draws) < 800:
        raise ValueError("Need >=800 draws for a useful chronological holdout")
    rm, rc, bm, bc = CONFIG[kind]
    coverage = audit(draws)
    if coverage["missing_issues"]:
        raise ValueError("Cannot train with missing issue sequence")
    slices = evaluation_slices(draws, reference)
    pools = {}
    for pool, maximum, ball_count in (("red", rm, rc), ("blue", bm, bc)):
        print(f"{kind}/{pool}: building chronological features", flush=True)
        h, a, target, indices, y = make_features(draws, pool, maximum)
        base = np.full(target.shape, ball_count / maximum)
        predictions = {"uniform": base}
        models = {}
        for name, x in (("history_logistic", h), ("metadata_logistic", a)):
            candidates = []
            regularizations = [reference["logistic_regularization"][pool][name]] if reference else (.01, .1, 1.)
            for reg in regularizations:
                model = fit(x[slices["train"]], target[slices["train"]], reg)
                val_probs = predict(model, x[slices["validation"]], ball_count)
                candidates.append((scores(val_probs, target[slices["validation"]])[0].mean(), model))
            _, model = min(candidates, key=lambda pair: pair[0])
            models[name] = model
            predictions[name] = predict(model, x, ball_count)
        windows = [reference["frequency_windows"][pool]] if reference else (30, 100, 300)
        freq_candidates = [(scores(frequency_predictions(y, indices, w)[slices["validation"]], target[slices["validation"]])[0].mean(), w) for w in windows]
        _, best_window = min(freq_candidates)
        predictions["frequency"] = frequency_predictions(y, indices, best_window)
        # Refit the frozen hyperparameters on all history for research-only next-draw marginals.
        live_models = {name: fit(h if name == "history_logistic" else a, target, model["regularization"]) for name, model in models.items()}
        future_date = next_date(kind, draws[-1]["draw_date"])
        live_h, live_a, _ = feature_at(draws, y, len(draws), future_date)
        live = {name: predict(model, live_h if name == "history_logistic" else live_a, ball_count).tolist() for name, model in live_models.items()}
        live["frequency"] = frequency_predictions(y, [len(draws)], best_window)[0].tolist()
        live["uniform"] = [ball_count / maximum] * maximum
        pools[pool] = dict(target=target, predictions=predictions, models=models, live_models=live_models, live=live, frequency_window=best_window)
    names = ("uniform", "frequency", "history_logistic", "metadata_logistic")
    metrics = {}
    for name in names:
        p = np.column_stack([pools[pool]["predictions"][name] for pool in ("red", "blue")])
        y = np.column_stack([pools[pool]["target"] for pool in ("red", "blue")])
        baseline = np.column_stack([pools[pool]["predictions"]["uniform"] for pool in ("red", "blue")])
        metrics[name] = {split: metric(p[sl], y[sl], baseline[sl], seed) for split, sl in slices.items() if split != "train"}
    validation_winner = min(names, key=lambda name: metrics[name]["validation"]["brier"])
    same_budget = {name: ticket_evaluation(kind, draws, pools, slices["test"], name, seed) for name in names}
    # Prize geography coverage has no verified publication times, so remains exploratory.
    # Even a marginal scoring gain is not evidence of a better JOINT jackpot forecast.
    policy = dict(model="uniform", reason="尚无前瞻验证的整注一等奖概率优势，正式候选使用均匀随机去重；历史模型只用于实验比较。",
                  validation_winner=validation_winner, metadata_exploratory_only=True,
                  jackpot_advantage_established=False)
    boundaries = {}
    for name, sl in slices.items():
        selected = draws[200:][sl]
        boundaries[name] = dict(count=len(selected), first_issue=selected[0]["issue"], last_issue=selected[-1]["issue"], first_date=selected[0]["draw_date"], last_date=selected[-1]["draw_date"])
    report = dict(lottery_type=kind, coverage=coverage, warmup_draws=200, split=boundaries,
                  evaluation_protocol="frozen historical boundaries and hyperparameters; new evidence comes from server-published prospective forecasts",
                  metrics=metrics, same_budget_test=same_budget, production_policy=policy, frequency_windows={p: pools[p]["frequency_window"] for p in pools},
                  logistic_regularization={p: {name: m["regularization"] for name, m in pools[p]["models"].items()} for p in pools},
                  bootstrap=dict(confidence=.99, circular_block_length=10, samples=2000, seed=seed),
                  latest_draw={key: draws[-1].get(key) for key in ("issue", "draw_date", "red", "blue", "sales_cents", "pool_cents", "prize_tiers", "regions", "detail_url", "provider", "source_url", "verification")},
                  target_issue=None, target_date_estimate=next_date(kind, draws[-1]["draw_date"]),
                  combination_count=math.comb(rm, rc) * math.comb(bm, bc),
                  research_marginals={name: {p: pools[p]["live"][name] for p in pools} for name in names},
                  rule_notice="奖表保留原始奖级与金额。大乐透规则有变化，当前不计算未核实规则的奖金、ROI或回本率。")
    weights = {p: dict(frozen_evaluation=pools[p]["models"], live_refit=pools[p]["live_models"]) for p in pools}
    return report, weights


def markdown_report(artifact):
    lines = ["# 数据与训练结果", "", f"生成时间：{artifact['created_at']}", f"数据指纹：`{artifact['dataset_sha256']}`", "",
             "所有历史回测为事后重放；没有核实每个历史字段的真实发布时间。模型评分是单号码边际概率评分，不能解释为整注一等奖概率。", ""]
    for kind, report in artifact["lotteries"].items():
        c = report["coverage"]
        lines += [f"## {'双色球' if kind == 'ssq' else '大乐透'}", "", f"号码 {c['count']} 期（{c['first_issue']}—{c['last_issue']}），官方 {c['official_count']} 期；销量 {c['sales_count']} 期，奖池原始值 {c['pool_count']} 期（其中 {c['unverified_zero_pool_count']} 期为未核实的0值，训练按缺失处理），省级分布 {c['region_count']} 期，网点 {c['outlet_count']} 条。", "", "| 数据段 | 期数 | 起止日期 |", "|---|---:|---|"]
        for name, split in report["split"].items():
            lines.append(f"| {name} | {split['count']} | {split['first_date']}—{split['last_date']} |")
        lines += ["", "Brier 越低越好；差值 = 模型 − 均匀随机，负数才是改善。区间是逐期差值的 99% 分块 bootstrap 区间，不是中奖概率区间。", "", "| 模型 | 验证 Brier | 测试 Brier | 测试差值 | 99% 区间 |", "|---|---:|---:|---:|---|"]
        for name, m in report["metrics"].items():
            test = m["test"]
            ci = test["delta_99pct_block_bootstrap_ci"]
            lines.append(f"| {name} | {m['validation']['brier']:.8f} | {test['brier']:.8f} | {test['brier_delta_vs_uniform']:+.8f} | [{ci[0]:+.8f}, {ci[1]:+.8f}] |")
        lines += ["", f"验证集最佳：{report['production_policy']['validation_winner']}。", report["production_policy"]["reason"], "", f"下期日期估计 {report['target_date_estimate']}，期号待官方确认。5 注预算 10 元，一等奖覆盖概率 5/{report['combination_count']:,}（公平独立开奖假设）。", ""]
        for i, ticket in enumerate(report["candidate_run"]["plans"], 1):
            lines.append(f"{i}. {' '.join(ticket['red'])} + {' '.join(ticket['blue'])}")
        lines += ["", report["rule_notice"], ""]
    return "\n".join(lines)


def train_all(seed=20261026, reference=None, publish_generated=True):
    if (DATA / "conflicts.json").exists():
        raise ValueError("Unresolved source conflicts: review and archive data/conflicts.json before training")
    db = connect()
    dataset = {kind: load_draws(db, kind) for kind in CONFIG}
    if not all(dataset.values()):
        raise ValueError("Run collect first")
    # Retrieval timestamps don't alter the semantic dataset fingerprint.
    canonical = {kind: [{k: v for k, v in d.items() if k not in ("retrieved_at", "source_url", "source_sha256")} for d in draws] for kind, draws in dataset.items()}
    fingerprint = hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    run_dir = DATA / "runs" / run_id
    run_dir.mkdir(parents=True)
    code_hash = hashlib.sha256(b"".join((ROOT / name).read_bytes() for name in ("pipeline.py", "consensus.py", "baseline.py", "train.py"))).hexdigest()
    artifact = dict(version=VERSION, model_run_id=run_id, created_at=now(), dataset_sha256=fingerprint, seed=seed,
                    runtime=dict(python=sys.version.split()[0], numpy=np.__version__, training_code_sha256=code_hash),
                    feature_names=dict(history=HISTORY_NAMES, metadata=META_NAMES),
                    limitations=["公平独立开奖下，历史数据不提供下一期必然可用的选号优势", "官方接口限制云端访问；新增号码由新浪和500独立发布结果一致校验，未直接核验官网，周边元数据保留缺失", "双色球早期部分元数据缺失", "历史发布时间未核实；元数据使用至少滞后两期和48小时隔离，仅为探索性回测", "省级分布仅覆盖部分期次；大乐透新闻分布只接受合计与官方一等奖注数相符的记录，具体中奖网点未取得可核实样本", "未核实每期大乐透命中规则，不提供虚构奖金回测", "候选是未购买的方案，期号和开售状态以官方为准"], lotteries={})
    for offset, (kind, draws) in enumerate(dataset.items()):
        print(f"Training {kind}: {len(draws)} draws", flush=True)
        report, weights = train_kind(draws, kind, seed + offset, reference["lotteries"][kind] if reference else None)
        live_seed = (seed + offset + int(draws[-1]["issue"])) % (2 ** 32)
        candidate = dict(run_id=run_id + "-" + kind, created_at=artifact["created_at"], model_run_id=run_id,
                         seed=live_seed, rng="python-random-v1", lottery_type=kind, model="uniform", target_issue=None,
                         dataset_sha256=fingerprint,
                         target_date_estimate=report["target_date_estimate"], data_cutoff_issue=draws[-1]["issue"],
                         plans=tickets(kind, 5, live_seed), cost_yuan=10, purchased=False,
                         jackpot_probability=5 / report["combination_count"])
        report["candidate_run"] = candidate
        artifact["lotteries"][kind] = report
        (run_dir / f"{kind}-weights.json").write_text(json.dumps(weights, ensure_ascii=False, indent=2))
        (run_dir / f"{kind}-candidates.json").write_text(json.dumps(candidate, ensure_ascii=False, indent=2))
        db.execute("INSERT INTO prediction_runs VALUES (?,?,?,?)", (candidate["run_id"], candidate["created_at"], run_id, json.dumps(candidate, ensure_ascii=False)))
    report_file = run_dir / "report.json"
    report_file.write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    (run_dir / "report.md").write_text(markdown_report(artifact))
    db.execute("INSERT INTO model_runs VALUES (?,?,?,?)", (run_id, artifact["created_at"], fingerprint, str(report_file)))
    db.commit()
    # Deployable snapshot; no remote DB or deployment operation is performed here.
    if publish_generated:
        publish_snapshot(artifact)
    (DATA / "latest-report.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2))
    (DATA / "latest-report.md").write_text(markdown_report(artifact))
    print(f"Training complete: {report_file}", flush=True)
    return artifact


def publish_snapshot(artifact):
    generated = ROOT.parent / "vue-version" / "worker" / "src" / "generated"
    generated.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(artifact, ensure_ascii=False, indent=2)
    (generated / "research.json").write_text(payload)
    # Plain ESM also works with the project's older esbuild and native Node.
    (generated / "research-data.js").write_text("// Generated by lottery_lab/train.py; do not edit.\nexport default " + payload + ";\n")


if __name__ == "__main__":
    train_all()
