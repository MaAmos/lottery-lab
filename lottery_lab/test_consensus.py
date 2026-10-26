import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from baseline import DIRECTORY, restore_baseline
from consensus import agree, parse_chart
from pipeline import audit, connect, load_draws, normalize, store


class ConsensusTests(unittest.TestCase):
    def test_chart_parser_ignores_commented_cells_and_validates_numbers(self):
        cells = ["26122", "01", "02", "04", "17", "19", "30", "09", "", "100", "2026-10-25"]
        body = '<tbody id="tdata"><tr><!--<td>2</td>-->' + ''.join('<td>' + s + '</td>' for s in cells) + '</tr></tbody>'
        draw = parse_chart("ssq", body.encode())[0]
        self.assertEqual(draw["issue"], "2026122")
        self.assertEqual(draw["red"], [1, 2, 4, 17, 19, 30])
        for bad in (body.replace('>30<', '>40<'), body.replace('id="tdata"', 'id="other"'), body.replace('>26122<', '>oops<')):
            with self.assertRaises(ValueError): parse_chart("ssq", bad.encode())

    @staticmethod
    def sources():
        row = normalize("ssq", dict(issueNo="2026122", openTime="2026-10-25", redResults=[1, 2, 4, 17, 19, 30], blueResults=[9]), "sina")
        return {name: ([{**row, "provider": name}], dict(url="https://example.org/" + name, sha256=hashlib.sha256(name.encode()).hexdigest(), retrieved_at="2026-10-26T01:00:00Z")) for name in ("sina", "500")}

    def test_conflicting_numbers_dates_and_lagging_sources_stop_publication(self):
        for key, value in (("red", [1, 2, 4, 17, 19, 31]), ("blue", [10]), ("draw_date", "2026-10-24"), ("issue", "2026121")):
            sources = self.sources()
            sources["500"][0][0][key] = value
            with self.assertRaises(ValueError): agree("ssq", sources)
        result = agree("ssq", self.sources())[0]
        self.assertEqual(result["provider"], "consensus")
        self.assertIsNone(result["pool_cents"])
        self.assertEqual({s["provider"] for s in result["verification"]["sources"]}, {"sina", "500"})

    def test_consensus_does_not_replace_official_metadata_or_inflate_official_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            with connect(Path(tmp) / "db.sqlite") as db:
                sources = self.sources()
                draw = agree("ssq", sources)[0]
                meta = {**sources["sina"][1], "raw_path": "fixture.json"}
                official = {**draw, "provider": "cwl", "pool_cents": 12345}
                store(db, [official], meta)
                store(db, [draw], meta)
                saved = load_draws(db, "ssq")
                self.assertEqual(saved[0]["pool_cents"], 12345)
                self.assertEqual(audit(saved)["official_count"], 1)
                self.assertEqual(audit([draw])["official_count"], 0)
                self.assertEqual(audit([draw])["consensus_count"], 1)

    def test_shipped_history_restores_original_responses_and_hashes(self):
        with tempfile.TemporaryDirectory() as tmp, patch("pipeline.DATA", Path(tmp)):
            with connect(Path(tmp) / "db.sqlite") as db:
                restore_baseline(db)
                manifest = json.loads((DIRECTORY / "manifest.json").read_text())
                for kind, coverage in manifest["coverage"].items():
                    self.assertEqual(audit(load_draws(db, kind))["count"], coverage["count"])
                for sha, raw_path in db.execute("SELECT sha256,raw_path FROM sources"):
                    raw = (Path(tmp) / "raw" / Path(raw_path).name).read_bytes()
                    self.assertEqual(hashlib.sha256(raw).hexdigest(), sha)
                restore_baseline(db)  # Repeated restores preserve appended history.
