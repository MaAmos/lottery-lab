"""Daily CI collection, settlement, frozen-protocol refit and authenticated publish.

No Cloudflare account token or repository write permission is needed here.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

from pipeline import CONFIG, DATA, ROOT, connect, enrich_regions, load_draws
from train import train_all
from consensus import collect_consensus


class API:
    def __init__(self, base, token, allow_local=False):
        parsed = urllib.parse.urlsplit(base)
        local = allow_local and parsed.hostname in ("127.0.0.1", "localhost")
        if (parsed.scheme != "https" and not (local and parsed.scheme == "http")) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("LOTTERY_API_URL must be the HTTPS site origin")
        if len(token) < 32:
            raise ValueError("LOTTERY_AUTO_UPDATE_TOKEN must contain at least 32 characters")
        self.base, self.token = base.rstrip("/"), token

    def call(self, route, body=None):
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(self.base + route, data=payload, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
            "User-Agent": "lottery-lab-update/1"})
        # Never forward the bearer credential to an HTTP redirect target.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=90) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            # Do not print response HTML/headers that could echo request credentials.
            raise RuntimeError(f"Worker {route}: HTTP {error.code}") from None
        if not result.get("success"):
            raise RuntimeError(f"Worker {route} rejected the operation")
        return result


def recent_verified(dataset):
    result = []
    for kind, draws in dataset.items():
        # Preserve source evidence for settlement and the published cutoff.
        for draw in [d for d in draws if d["provider"] in ("cwl", "sporttery", "consensus")][-30:]:
            result.append({"lottery_type": kind, **{key: draw[key] for key in ("issue", "draw_date", "red", "blue", "source_url")},
                           **({"verification": draw["verification"]} if draw.get("verification") else {})})
    return result


def ensure_not_regressed(dataset, reference):
    advanced = False
    for kind, draws in dataset.items():
        previous = reference["lotteries"][kind]
        if len(draws) < previous["coverage"]["count"] or draws[-1]["issue"] < previous["coverage"]["last_issue"]:
            raise ValueError(f"{kind}: source coverage regressed")
        cutoff = next((d for d in draws if d["issue"] == previous["coverage"]["last_issue"]), None)
        if cutoff is None or any(cutoff[k] != previous["latest_draw"][k] for k in ("draw_date", "red", "blue")):
            raise ValueError(f"{kind}: published draw changed; manual review required")
        advanced |= draws[-1]["issue"] > previous["coverage"]["last_issue"]
    return advanced


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Train from local reference; no remote calls/writes")
    parser.add_argument("--cached", action="store_true", help="Use existing local data (only allowed with --dry-run)")
    parser.add_argument("--force", action="store_true", help="Refit even without new draws; never extend the target date")
    parser.add_argument("--enrich", action="store_true", help="Best-effort recent news metadata enrichment")
    parser.add_argument("--allow-local", action="store_true", help="Permit localhost Worker integration tests")
    args = parser.parse_args()
    if args.cached and not args.dry_run:
        parser.error("--cached requires --dry-run")
    api = None
    first_activation = False
    run_id = "gha-" + os.environ.get("GITHUB_RUN_ID", uuid.uuid4().hex) + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    stage = "setup"
    def status(state, detail=""):
        if api:
            api.call("/api/admin/run", dict(run_id=run_id, status=state, stage=stage, detail=detail))
    try:
        if args.dry_run:
            reference = json.loads((ROOT.parent / "vue-version/worker/src/generated/research.json").read_text())
        else:
            api = API(os.environ["LOTTERY_API_URL"], os.environ["LOTTERY_AUTO_UPDATE_TOKEN"], args.allow_local)
            snapshot = api.call("/api/admin/snapshot")["data"]
            reference = snapshot["artifact"]
            first_activation = snapshot["source"] == "bundled"
        stage = "collect"; status("running")
        if not args.cached:
            collect_consensus(refresh=True)
        if args.enrich and not args.cached:
            try:
                enrich_regions(limit=20, refresh=True)
            except Exception:
                print("Optional region enrichment unavailable; retaining only verified metadata", flush=True)
        with connect() as db:
            dataset = {kind: load_draws(db, kind) for kind in CONFIG}
        advanced = ensure_not_regressed(dataset, reference)
        stage = "settle"; status("running")
        if api:
            # Upload one lottery per request: <=30 draw lookups plus settlement stays
            # below the Workers free-plan subrequest allowance in ordinary use.
            rows = recent_verified(dataset)
            for kind in CONFIG:
                api.call("/api/admin/draws", {"draws": [d for d in rows if d["lottery_type"] == kind]})
        if not advanced and not args.force and not first_activation:
            status("no_change", "No new verified draw; existing expiry retained")
            print("No new verified draw; skipped training and retained the published snapshot", flush=True)
            return
        stage = "train"; status("running")
        artifact = train_all(seed=reference["seed"], reference=reference, publish_generated=False)
        stage = "publish"; status("running")
        if api:
            api.call("/api/admin/publish", {"expected_model_run_id": reference["model_run_id"], "artifact": artifact})
        stage = "complete"; status("succeeded", f"Published {artifact['model_run_id']}")
        print(json.dumps({"success": True, "dry_run": args.dry_run, "model_run_id": artifact["model_run_id"],
                          "cutoffs": {k: r["coverage"]["last_issue"] for k, r in artifact["lotteries"].items()}}, ensure_ascii=False), flush=True)
    except Exception as error:
        # Keep messages bounded and free of credentials. Stage and exception type
        # identify the failure; the active model remains untouched before publish.
        try:
            status("failed", f"{type(error).__name__} at {stage}; inspect the Actions log")
        except Exception:
            pass
        print(f"Update failed at {stage}: {type(error).__name__}", file=sys.stderr)
        # Errors generated by this code have no secrets; network response bodies
        # are intentionally excluded by API.call.
        if isinstance(error, (ValueError, RuntimeError)):
            print(str(error), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
