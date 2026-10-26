"""Public lottery data: auditable sources, independent SQLite dataset, CLI."""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import html
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CONFIG = {"ssq": (33, 6, 16, 1), "dlt": (35, 5, 12, 2)}
PROVINCES = "北京 天津 河北 山西 内蒙古 辽宁 吉林 黑龙江 上海 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 广西 海南 重庆 四川 贵州 云南 西藏 陕西 甘肃 青海 宁夏 新疆 深圳".split()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def money(value):
    """Source yuan -> exact integer cents. Unknown is never zero."""
    if value is None or str(value).strip() in ("", "---", "--", "-", "-1"):
        return None
    try:
        text = str(value).replace(",", "").strip()
        # Official historic SSQ amounts sometimes include a promotion annotation.
        if re.fullmatch(r"\d+(?:\.\d+)?[（(]含(?:派|加)奖\d+(?:\.\d+)?[）)]", text):
            text = re.split(r"[（(]", text)[0]
        number = Decimal(text)
        if not number.is_finite() or number < 0:
            raise ValueError(f"Invalid money: {value!r}")
        cents = number * 100
        if cents != cents.to_integral_value():
            raise ValueError(f"Unexpected sub-cent amount: {value!r}")
        return int(cents)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid money: {value!r}") from exc


def integer(value):
    if value is None or str(value).strip() in ("", "---", "--", "-", "-1"):
        return None
    parsed = int(str(value).replace(",", ""))
    if parsed < 0:
        raise ValueError(f"Negative stake count: {value!r}")
    return parsed


def canonical_issue(kind, issue):
    text = str(issue)
    if re.fullmatch(r"\d{5}", text):
        text = "20" + text
    if not re.fullmatch(r"20\d{5}", text):
        raise ValueError(f"Unrecognized issue {kind}: {issue}")
    return text


def validate(draw):
    rm, rc, bm, bc = CONFIG[draw["lottery_type"]]
    for key, maximum, count in (("red", rm, rc), ("blue", bm, bc)):
        nums = draw[key]
        if len(nums) != count or len(set(nums)) != count or any(type(n) is not int or not 1 <= n <= maximum for n in nums):
            raise ValueError(f"Invalid {key} numbers: {draw}")
    dt.date.fromisoformat(draw["draw_date"])
    if draw["issue"][:4] != draw["draw_date"][:4]:
        raise ValueError(f"Issue/date year mismatch: {draw['issue']}")
    return draw


def parse_regions(text):
    # These are winning STAKES, not people, and provincial coverage is partial.
    regions = {}
    pattern = "(?:" + "|".join(PROVINCES) + ")"
    for region, count in re.findall("(" + "|".join(PROVINCES) + r")\s*(?:中出)?(\d+)注", text or ""):
        regions[region] = regions.get(region, 0) + int(count)
    for names, count in re.findall(r"((?:" + pattern + r"[、和及])+" + pattern + r")各(?:中出)?(\d+)注", text or ""):
        for region in re.split("[、和及]", names):
            regions[region] = regions.get(region, 0) + int(count)
    return [dict(region=name, first_prize_stakes=count) for name, count in regions.items()]


def parse_news_regions(text, stakes):
    regions = parse_regions(text)
    if regions and sum(r["first_prize_stakes"] for r in regions) == stakes:
        return regions
    # An unqualified list is only unambiguous if every listed province accounts
    # for exactly one stake and all official first-prize stakes are accounted for.
    if not re.search(r"均未|均没有追加|全部未|并未选择追加|未追加", text):
        return []
    for clause in re.findall(r"(?:分落|分别出自|出自)([^。；]+)", text):
        if "注" in clause or "中出" in clause:
            continue
        names = re.findall("|".join(PROVINCES), clause)
        if len(names) == stakes and len(set(names)) == stakes:
            return [dict(region=name, first_prize_stakes=1) for name in names]
    return []


def normalize(kind, row, provider):
    if provider == "cwl":
        draw = dict(lottery_type=kind, issue=canonical_issue(kind, row["code"]),
                    source_issue=row["code"], draw_date=row["date"][:10],
                    red=sorted(map(int, row["red"].split(","))), blue=sorted(map(int, row["blue"].split(","))),
                    sales_cents=money(row.get("sales")), pool_cents=money(row.get("poolmoney")),
                    distribution_text=row.get("content", ""),
                    detail_url="https://www.cwl.gov.cn" + row.get("detailsLink", ""),
                    prize_tiers=[dict(tier=str(p["type"]), label=f"{p['type']}等奖", stakes=integer(p.get("typenum")),
                                      amount_cents=money(p.get("typemoney")), amount_raw=p.get("typemoney")) for p in row.get("prizegrades", [])],
                    regions=parse_regions(row.get("content", "")))
    elif provider == "sporttery":
        nums = list(map(int, row["lotteryDrawResult"].split()))
        draw = dict(lottery_type=kind, issue=canonical_issue(kind, row["lotteryDrawNum"]),
                    source_issue=row["lotteryDrawNum"], draw_date=row["lotteryDrawTime"][:10],
                    red=sorted(nums[:5]), blue=sorted(nums[5:]),
                    sales_cents=money(row.get("totalSaleAmount")), pool_cents=money(row.get("poolBalanceAfterdraw")),
                    distribution_text="", detail_url=row.get("drawPdfUrl"), regions=[],
                    prize_tiers=[dict(tier=f"{p.get('group')}:{p.get('sort')}:{p.get('awardType', 0)}", label=p["prizeLevel"],
                                      group=p.get("group"), sort=p.get("sort"), award_type=p.get("awardType"),
                                      stakes=integer(p.get("stakeCount")), amount_cents=money(p.get("stakeAmountFormat", p.get("stakeAmount"))))
                                 for p in row.get("prizeLevelList", [])])
    else:
        draw = dict(lottery_type=kind, issue=canonical_issue(kind, row["issueNo"]), source_issue=row["issueNo"],
                    draw_date=row["openTime"][:10], red=sorted(map(int, row["redResults"])),
                    blue=sorted(map(int, row["blueResults"])), sales_cents=None, pool_cents=None,
                    distribution_text="", detail_url=(row.get("newsUrls") or [None])[0], prize_tiers=[], regions=[])
    draw["provider"] = provider
    draw["metadata_flags"] = (["pool_zero_unverified"]
                              if provider == "sporttery" and draw["pool_cents"] == 0 and draw["sales_cents"] is None else [])
    # A schema signature, NOT an assertion that the hit-to-tier rule is verified.
    labels = [(p["tier"], p["label"]) for p in draw["prize_tiers"] if p["amount_cents"] is not None or p["stakes"] is not None]
    draw["prize_schema"] = hashlib.sha256(json.dumps(labels, ensure_ascii=False).encode()).hexdigest()[:12] if labels else None
    draw["published_at"] = None  # historical source does not supply a verified release timestamp
    return validate(draw)


def connect(path=DATA / "lottery.sqlite"):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS sources (
      sha256 TEXT PRIMARY KEY, url TEXT NOT NULL, retrieved_at TEXT NOT NULL, raw_path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS draws (
      lottery_type TEXT NOT NULL, issue TEXT NOT NULL, draw_date TEXT NOT NULL,
      provider TEXT NOT NULL, source_sha256 TEXT NOT NULL REFERENCES sources(sha256), payload TEXT NOT NULL,
      PRIMARY KEY(lottery_type, issue));
    CREATE TABLE IF NOT EXISTS observations (
      lottery_type TEXT NOT NULL, issue TEXT NOT NULL, provider TEXT NOT NULL,
      source_sha256 TEXT NOT NULL REFERENCES sources(sha256), payload TEXT NOT NULL,
      PRIMARY KEY(lottery_type, issue, provider, source_sha256));
    CREATE TABLE IF NOT EXISTS prize_tiers (
      lottery_type TEXT NOT NULL, issue TEXT NOT NULL, tier TEXT NOT NULL, label TEXT NOT NULL,
      stakes INTEGER, amount_cents INTEGER, PRIMARY KEY(lottery_type,issue,tier));
    CREATE TABLE IF NOT EXISTS winner_regions (
      lottery_type TEXT NOT NULL, issue TEXT NOT NULL, region TEXT NOT NULL, first_prize_stakes INTEGER,
      PRIMARY KEY(lottery_type,issue,region));
    CREATE TABLE IF NOT EXISTS winner_outlets (
      lottery_type TEXT NOT NULL, issue TEXT NOT NULL, outlet_code TEXT NOT NULL, address TEXT,
      source_url TEXT NOT NULL, published_at TEXT, PRIMARY KEY(lottery_type,issue,outlet_code));
    CREATE TABLE IF NOT EXISTS model_runs (
      run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, dataset_sha256 TEXT NOT NULL, report_path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prediction_runs (
      run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, model_run_id TEXT NOT NULL,
      payload TEXT NOT NULL);
    """)
    return db


def fetch_bytes(url, refresh=False):
    raw_dir = DATA / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    pointer = raw_dir / f"request-{key}.json"
    if pointer.exists() and not refresh:
        meta = json.loads(pointer.read_text())
        body = (raw_dir / f"{meta['sha256']}.json").read_bytes()
        return body, meta
    error = None
    for attempt in range(4):
        try:
            # curl works with both official sites' TLS/client filtering; shell is never used.
            response = subprocess.run(["curl", "--location", "--silent", "--show-error", "--max-time", "40",
                                       "-A", "Mozilla/5.0", "-H", "Accept: application/json, text/plain, */*",
                                       "-H", "Referer: https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/",
                                       "--write-out", "\n%{http_code}", url], capture_output=True)
            body, _, status = response.stdout.rpartition(b"\n")
            if response.returncode or status != b"200":
                raise RuntimeError(f"HTTP {status.decode(errors='replace')}; curl exit {response.returncode}")
            sha = hashlib.sha256(body).hexdigest()
            path = raw_dir / f"{sha}.json"
            path.write_bytes(body)
            meta = dict(sha256=sha, url=url, retrieved_at=now(), raw_path=str(path.relative_to(ROOT.parent)))
            pointer.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            return body, meta
        except (subprocess.SubprocessError, RuntimeError) as exc:
            error = exc
            time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"Source failed: {url}: {error}")


def fetch_json(url, refresh=False):
    body, meta = fetch_bytes(url, refresh)
    try:
        return json.loads(body), meta
    except (ValueError, UnicodeError):
        raise RuntimeError(f"Source returned invalid JSON: {url}") from None


def source_url(kind, provider, page):
    if provider == "cwl":
        return "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?" + urlencode(dict(name="ssq", pageNo=page, pageSize=100, systemType="PC"))
    if provider == "sporttery":
        return "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?" + urlencode(dict(gameNo=85, provinceId=0, pageSize=100, isVerify=1, pageNo=page))
    return "https://alpha.lottery.sina.com.cn/gateway/index/entry?" + urlencode(dict(format="json", __caller__="wap", __version__="1.0.0", __verno__=10000, cat1="gameOpenList", lottoType=101 if kind == "ssq" else 201, paginationType=1, page=page, pageSize=100, dpc=1))


def unpack(provider, payload):
    if provider == "cwl":
        if payload.get("state") != 0:
            raise ValueError(f"CWL error: {payload.get('message')}")
        return payload["result"], int(payload["total"]), int(payload["pageNum"])
    if provider == "sporttery":
        if not payload.get("success"):
            raise ValueError(f"Sporttery error: {payload.get('errorMessage')}")
        value = payload["value"]
        return value["list"], int(value["total"]), int(value["pages"])
    if payload.get("result", {}).get("status", {}).get("code", 0) not in (0, "0"):
        raise ValueError("Sina error")
    result = payload["result"]
    return result["data"], int(result["pagination"]["totalCount"]), int(result["pagination"]["totalPage"])


def store(db, draws, meta):
    db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?,?)", tuple(meta[k] for k in ("sha256", "url", "retrieved_at", "raw_path")))
    conflicts = []
    for draw in draws:
        kind, issue = draw["lottery_type"], draw["issue"]
        draw["retrieved_at"] = meta["retrieved_at"]
        draw["source_url"] = meta["url"]
        draw["source_sha256"] = meta["sha256"]
        payload = json.dumps(draw, ensure_ascii=False, sort_keys=True)
        db.execute("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?)", (kind, issue, draw["provider"], meta["sha256"], payload))
        old_row = db.execute("SELECT payload FROM draws WHERE lottery_type=? AND issue=?", (kind, issue)).fetchone()
        if old_row:
            old = json.loads(old_row[0])
            if any(old[k] != draw[k] for k in ("red", "blue", "draw_date")):
                conflicts.append(dict(issue=issue, old=old, new=draw))
                continue
            if draw["provider"] in ("sina", "consensus") and old["provider"] in ("cwl", "sporttery"):
                continue
            if draw["provider"] == "sina" and old["provider"] == "consensus":
                continue
            if not draw["regions"] and old.get("enrichment_sources"):
                draw["regions"] = old["regions"]
                draw["enrichment_sources"] = old["enrichment_sources"]
                payload = json.dumps(draw, ensure_ascii=False, sort_keys=True)
        db.execute("INSERT OR REPLACE INTO draws VALUES (?,?,?,?,?,?)", (kind, issue, draw["draw_date"], draw["provider"], meta["sha256"], payload))
        db.execute("DELETE FROM prize_tiers WHERE lottery_type=? AND issue=?", (kind, issue))
        db.execute("DELETE FROM winner_regions WHERE lottery_type=? AND issue=?", (kind, issue))
        db.executemany("INSERT INTO prize_tiers VALUES (?,?,?,?,?,?)", [(kind, issue, p["tier"], p["label"], p["stakes"], p["amount_cents"]) for p in draw["prize_tiers"]])
        db.executemany("INSERT OR REPLACE INTO winner_regions VALUES (?,?,?,?)", [(kind, issue, r["region"], r["first_prize_stakes"]) for r in draw["regions"]])
    db.commit()
    if conflicts:
        path = DATA / "conflicts.json"
        path.write_text(json.dumps(conflicts, ensure_ascii=False, indent=2))
        raise ValueError(f"Conflicting draw sources: review {path}; training aborted")


def load_draws(db, kind):
    return [json.loads(row[0]) for row in db.execute("SELECT payload FROM draws WHERE lottery_type=? ORDER BY draw_date,issue", (kind,))]


def audit(draws):
    issues = {d["issue"] for d in draws}
    missing = []
    for year in sorted({i[:4] for i in issues}):
        seq = sorted(int(i[4:]) for i in issues if i[:4] == year)
        missing.extend(year + f"{n:03d}" for n in range(1, max(seq) + 1) if year + f"{n:03d}" not in issues)
    dates = [d["draw_date"] for d in draws]
    return dict(count=len(draws), first_issue=draws[0]["issue"], last_issue=draws[-1]["issue"],
                first_date=dates[0], last_date=dates[-1], missing_issues=missing,
                official_count=sum(d["provider"] in ("cwl", "sporttery") for d in draws),
                consensus_count=sum(d["provider"] == "consensus" for d in draws),
                sales_count=sum(d["sales_cents"] is not None for d in draws),
                pool_count=sum(d["pool_cents"] is not None for d in draws),
                usable_pool_count=sum(d["pool_cents"] is not None and "pool_zero_unverified" not in d.get("metadata_flags", []) for d in draws),
                unverified_zero_pool_count=sum("pool_zero_unverified" in d.get("metadata_flags", []) for d in draws),
                prize_count=sum(bool(d["prize_tiers"]) for d in draws),
                region_count=sum(bool(d["regions"]) for d in draws), outlet_count=0,
                prize_schemas=sorted({d["prize_schema"] for d in draws if d["prize_schema"]}),
                publication_timestamp_verified=False)


def enrich_regions(limit=20, refresh=False):
    """Conservative secondary-source enrichment; refuses totals inconsistent with official stakes."""
    if not 1 <= limit <= 100:
        raise ValueError("enrich limit must be 1..100")
    db = connect()
    draws = load_draws(db, "dlt")[-limit:]
    added, rejected = 0, []
    for draw in reversed(draws):
        observation = db.execute("SELECT payload FROM observations WHERE lottery_type='dlt' AND issue=? AND provider='sina' ORDER BY rowid DESC LIMIT 1", (draw["issue"],)).fetchone()
        if not observation:
            continue
        url = json.loads(observation[0]).get("detail_url")
        if not url or not url.startswith("https://sports.sina.com.cn/"):
            continue
        key = hashlib.sha256(url.encode()).hexdigest()
        pointer = DATA / "raw" / f"news-{key}.json"
        try:
            if pointer.exists() and not refresh:
                meta = json.loads(pointer.read_text())
                body = (ROOT.parent / meta["raw_path"]).read_bytes()
            else:
                fetched = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", "30", url], capture_output=True, check=True)
                body = fetched.stdout
                sha = hashlib.sha256(body).hexdigest()
                path = DATA / "raw" / f"{sha}.html"
                path.write_bytes(body)
                meta = dict(sha256=sha, url=url, retrieved_at=now(), raw_path=str(path.relative_to(ROOT.parent)))
                pointer.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            text = body.decode("utf-8", errors="replace")
            text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", text, flags=re.I | re.S)
            text = html.unescape(re.sub(r"<[^>]+>", " ", text))
            text = re.sub(r"\s+", " ", text)
            # Scope to this issue's first-prize paragraph; other draws appear in page sidebars.
            match = re.search(r"第" + re.escape(draw["source_issue"]) + r"期开奖.{0,1500}?(?=二等奖)", text)
            if not match:
                rejected.append(dict(issue=draw["issue"], reason="未找到本期一等奖段落"))
                continue
            first = next((p for p in draw["prize_tiers"] if p["label"] == "一等奖"), {})
            regions = parse_news_regions(match[0], first.get("stakes"))
            if not regions or sum(r["first_prize_stakes"] for r in regions) != first.get("stakes"):
                rejected.append(dict(issue=draw["issue"], reason="分布无法完整解析或与官方一等奖注数不符"))
                continue
            draw["regions"] = regions
            draw["enrichment_sources"] = [dict(**meta, evidence_excerpt=match[0], published_at=None)]
            payload = json.dumps(draw, ensure_ascii=False, sort_keys=True)
            db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?,?)", tuple(meta[k] for k in ("sha256", "url", "retrieved_at", "raw_path")))
            db.execute("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?)", ("dlt", draw["issue"], "sina-news", meta["sha256"], payload))
            db.execute("UPDATE draws SET payload=? WHERE lottery_type='dlt' AND issue=?", (payload, draw["issue"]))
            db.execute("DELETE FROM winner_regions WHERE lottery_type='dlt' AND issue=?", (draw["issue"],))
            db.executemany("INSERT INTO winner_regions VALUES (?,?,?,?)", [("dlt", draw["issue"], r["region"], r["first_prize_stakes"]) for r in regions])
            db.commit()
            added += 1
        except (subprocess.SubprocessError, ValueError) as exc:
            rejected.append(dict(issue=draw["issue"], reason=str(exc)))
        print(f"dlt/regions {draw['issue']}: {added} verified distributions so far", flush=True)
    report = dict(created_at=now(), requested=limit, accepted=added, rejected=rejected, outlet_samples=0)
    (DATA / "region-enrichment.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    # Refresh exports and coverage without refetching the draw sources.
    coverage = json.loads((DATA / "coverage.json").read_text())
    coverage["coverage"]["dlt"] = audit(load_draws(db, "dlt"))
    (DATA / "coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2))
    (DATA / "dlt.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in load_draws(db, "dlt")))
    print(json.dumps(report, ensure_ascii=False, indent=2))


def collect(refresh=False):
    db = connect()
    source_reports = []
    for kind, provider in (("ssq", "sina"), ("ssq", "cwl"), ("dlt", "sporttery"), ("dlt", "sina")):
        first, meta = fetch_json(source_url(kind, provider, 1), refresh)
        rows, total, pages = unpack(provider, first)
        all_issues = set()
        def ingest(rows, meta):
            normalized = [normalize(kind, r, provider) for r in rows]
            for d in normalized:
                if d["issue"] in all_issues:
                    raise ValueError(f"Repeated issue in pagination {kind}/{provider}: {d['issue']}; rerun --refresh")
                all_issues.add(d["issue"])
            store(db, normalized, meta)
        ingest(rows, meta)
        # A small bounded pool keeps collection practical without hammering the providers.
        def get_page(page):
            body, m = fetch_json(source_url(kind, provider, page), refresh)
            rs, current_total, _ = unpack(provider, body)
            if current_total != total:
                raise ValueError("Source changed during pagination; retry --refresh after draw publication")
            return rs, m
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for number, (rs, m) in enumerate(pool.map(get_page, range(2, pages + 1)), 2):
                ingest(rs, m)
                if number % 5 == 0 or number == pages:
                    print(f"{kind}/{provider} {number}/{pages} pages, {len(all_issues)}/{total} issues", flush=True)
        if len(all_issues) != total:
            raise ValueError(f"Incomplete {kind}/{provider}: {len(all_issues)} != {total}")
        source_reports.append(dict(lottery_type=kind, provider=provider, reported_total=total, collected=len(all_issues)))
    coverage = {kind: audit(load_draws(db, kind)) for kind in CONFIG}
    for kind in CONFIG:
        if coverage[kind]["missing_issues"]:
            raise ValueError(f"Missing issue sequence: {coverage[kind]['missing_issues']}")
    report = dict(created_at=now(), sources=source_reports, coverage=coverage,
                  limitations=["历史发布时间未核实；回测属于事后历史重放", "双色球早期元数据缺失，使用新浪补齐开奖号码", "省级中奖分布仅有部分样本，两种彩票的具体中奖网点尚未取得可核实样本", "中奖注数不等于中奖人数；奖表签名不等于已核实的中奖规则版本"])
    (DATA / "coverage.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for kind in CONFIG:
        (DATA / f"{kind}.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in load_draws(db, kind)))
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("collect", "enrich", "train", "serve"))
    parser.add_argument("--refresh", action="store_true", help="Refresh all request caches")
    parser.add_argument("--seed", type=int, default=20261026)
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    if args.command == "collect":
        collect(args.refresh)
    elif args.command == "enrich":
        enrich_regions(args.limit, args.refresh)
    elif args.command == "train":
        from train import train_all
        train_all(args.seed)
    else:
        from serve import serve
        serve()


if __name__ == "__main__":
    main()
