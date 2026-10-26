"""Ship the audited public history and its original responses, with checked hashes."""
from __future__ import annotations

import base64
import collections
import gzip
import hashlib
import json
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent / "bootstrap"


def restore_baseline(db, directory=DIRECTORY):
    from pipeline import DATA, store, validate
    manifest = json.loads((directory / "manifest.json").read_text())
    if db.execute("SELECT count(*) FROM draws").fetchone()[0]:
        for kind, expected in manifest["coverage"].items():
            count = db.execute("SELECT count(*) FROM draws WHERE lottery_type=?", (kind,)).fetchone()[0]
            if count < expected["count"]:
                raise ValueError("Saved history is incomplete; restore a verified baseline before updating")
        return
    compressed = (directory / "history.json.gz").read_bytes()
    if hashlib.sha256(compressed).hexdigest() != manifest["sha256"]:
        raise ValueError("Baseline archive hash mismatch")
    archive = json.loads(gzip.decompress(compressed))
    groups = collections.defaultdict(list)
    for rows in archive["draws"].values():
        for draw in rows:
            validate(draw)
            groups[draw["source_sha256"]].append(draw)
    for source in archive["sources"]:
        raw = base64.b64decode(source["body_base64"], validate=True)
        if hashlib.sha256(raw).hexdigest() != source["sha256"]:
            raise ValueError("Baseline source hash mismatch")
        path = DATA / "raw" / Path(source["raw_path"]).name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        store(db, groups.pop(source["sha256"], []), source)
    if groups:
        raise ValueError("Baseline contains draws without original responses")
    for kind, expected in manifest["coverage"].items():
        count = db.execute("SELECT count(*) FROM draws WHERE lottery_type=?", (kind,)).fetchone()[0]
        if count != expected["count"]:
            raise ValueError("Baseline coverage mismatch")
    print("Restored audited history with original public source responses", flush=True)


def build_baseline(directory=DIRECTORY):
    from pipeline import CONFIG, ROOT, audit, connect, load_draws, now
    with connect() as db:
        draws = {kind: load_draws(db, kind) for kind in CONFIG}
        used = {draw["source_sha256"] for rows in draws.values() for draw in rows}
        used.update(source["sha256"] for rows in draws.values() for draw in rows for source in draw.get("enrichment_sources", []))
        sources = []
        for row in db.execute("SELECT * FROM sources ORDER BY sha256"):
            source = dict(zip(("sha256", "url", "retrieved_at", "raw_path"), row))
            if source["sha256"] not in used:
                continue
            raw = (ROOT.parent / source["raw_path"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != source["sha256"]:
                raise ValueError("Original source hash mismatch")
            source["body_base64"] = base64.b64encode(raw).decode()
            sources.append(source)
        if used != {source["sha256"] for source in sources}:
            raise ValueError("Original source response missing")
    archive = dict(version=1, created_at=now(), draws=draws, sources=sources)
    compressed = gzip.compress(json.dumps(archive, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "history.json.gz").write_bytes(compressed)
    manifest = dict(version=1, created_at=archive["created_at"], sha256=hashlib.sha256(compressed).hexdigest(),
        coverage={kind: audit(rows) for kind, rows in draws.items()}, original_responses=len(sources),
        notice="Public draw records and original responses; no credentials or private data.")
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(dict(archive_bytes=len(compressed), **manifest), ensure_ascii=False))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true", required=True)
    args = parser.parse_args()
    build_baseline()
