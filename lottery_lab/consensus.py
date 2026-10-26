"""Incremental, independently published number checks when official sites block CI."""
from __future__ import annotations

import html
import json
import re

from baseline import restore_baseline
from pipeline import (CONFIG, DATA, audit, connect, fetch_bytes, fetch_json, load_draws,
                      normalize, now, source_url, store, unpack)

FIELDS = ("issue", "draw_date", "red", "blue")


def chart_url(kind):
    return f"https://datachart.500.com/{kind}/history/newinc/history.php?limit=100&sort=0"


def parse_chart(kind, body):
    text = re.sub(r"<!--.*?-->", "", body.decode("utf-8", errors="replace"), flags=re.S)
    table = re.search(r'<tbody\b[^>]*\bid=[\"\']tdata[\"\'][^>]*>(.*?)</tbody>', text, re.S | re.I)
    if not table:
        raise ValueError(f"{kind}/500: draw table missing")
    result = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table[1], re.S | re.I):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", cell)).strip()
                 for cell in re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.S | re.I)]
        if not cells or not re.fullmatch(r"\d{5}", cells[0]):
            raise ValueError(f"{kind}/500: unexpected draw row")
        red_count, blue_count = CONFIG[kind][1], CONFIG[kind][3]
        if len(cells) < 1 + red_count + blue_count + 1 or not re.fullmatch(r"20\d\d-\d\d-\d\d", cells[-1]):
            raise ValueError(f"{kind}/500: malformed draw row")
        result.append(normalize(kind, dict(issueNo=cells[0], openTime=cells[-1],
            redResults=cells[1:1 + red_count], blueResults=cells[1 + red_count:1 + red_count + blue_count]), "500"))
    if not result or len({d["issue"] for d in result}) != len(result):
        raise ValueError(f"{kind}/500: empty or duplicate draws")
    return result


def agree(kind, sources):
    """Reject disagreements or a lagging latest draw; never silently trust one source."""
    maps = []
    for provider in ("sina", "500"):
        rows, _ = sources[provider]
        index = {d["issue"]: d for d in rows}
        if not index or len(index) != len(rows):
            raise ValueError(f"{kind}/{provider}: empty or duplicate draws")
        maps.append(index)
    if max(maps[0]) != max(maps[1]):
        raise ValueError(f"{kind}: public sources have different latest issues; retry after publication")
    shared = sorted(maps[0].keys() & maps[1].keys())
    oldest = max(min(index) for index in maps)
    if any({issue for issue in index if issue >= oldest} != set(shared) for index in maps):
        raise ValueError(f"{kind}: public source coverage gap")
    verified = []
    for issue in shared:
        a, b = (index[issue] for index in maps)
        if any(a[key] != b[key] for key in FIELDS):
            raise ValueError(f"{kind}/{issue}: public source conflict; publication stopped")
        draw = {**a, "provider": "consensus", "detail_url": None,
                "metadata_flags": ["official_metadata_unavailable"]}
        draw["verification"] = {"type": "two_public_sources", "sources": [
            {"provider": provider, "source_url": meta["url"], "source_sha256": meta["sha256"],
             "retrieved_at": meta["retrieved_at"], **{key: a[key] for key in FIELDS}}
            for provider, (_, meta) in sources.items()]}
        verified.append(draw)
    return verified


def collect_consensus(refresh=True):
    with connect() as db:
        restore_baseline(db)
        reports = []
        for kind in CONFIG:
            payload, sina_meta = fetch_json(source_url(kind, "sina", 1), refresh)
            rows, _, _ = unpack("sina", payload)
            sina = [normalize(kind, row, "sina") for row in rows]
            raw, chart_meta = fetch_bytes(chart_url(kind), refresh)
            chart = parse_chart(kind, raw)
            sources = {"sina": (sina, sina_meta), "500": (chart, chart_meta)}
            verified = agree(kind, sources)
            previous = load_draws(db, kind)
            if verified[-1]["issue"] < previous[-1]["issue"]:
                raise ValueError(f"{kind}: public sources regressed behind saved history")
            if verified[0]["issue"] > previous[-1]["issue"]:
                raise ValueError(f"{kind}: recent sources do not overlap saved history; backfill required")
            for provider, (observations, meta) in sources.items():
                db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?,?)", tuple(meta[k] for k in ("sha256", "url", "retrieved_at", "raw_path")))
                for draw in observations:
                    observation = {**draw, "source_url": meta["url"], "source_sha256": meta["sha256"], "retrieved_at": meta["retrieved_at"]}
                    db.execute("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?)", (kind, draw["issue"], provider, meta["sha256"], json.dumps(observation, ensure_ascii=False)))
            store(db, verified, sina_meta)
            reports.append(dict(lottery_type=kind, providers=["sina", "500"], verified=len(verified), last_issue=verified[-1]["issue"]))
            print(f"{kind}: {len(verified)} draws agree across Sina and 500; latest {verified[-1]['issue']}", flush=True)
        coverage = {kind: audit(load_draws(db, kind)) for kind in CONFIG}
        if any(value["missing_issues"] for value in coverage.values()):
            raise ValueError("Missing issue sequence; publication stopped")
        report = dict(created_at=now(), sources=reports, coverage=coverage,
            policy="Preserve verified official history; new numbers require Sina/500 agreement. Unverified official metadata stays missing.")
        (DATA / "coverage.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        for kind in CONFIG:
            (DATA / f"{kind}.jsonl").write_text("".join(json.dumps(draw, ensure_ascii=False) + "\n" for draw in load_draws(db, kind)))
        return report
