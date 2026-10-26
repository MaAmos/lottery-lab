import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from pipeline import canonical_issue, connect, money, normalize, parse_news_regions, parse_regions, store, validate
from train import evaluation_slices, feature_at, fit, labels, metadata, predict, tickets
from auto_update import API, ensure_not_regressed


class DataTests(unittest.TestCase):
    def test_money_precision_missing_and_promotions(self):
        self.assertEqual(money("825,893,883.63"), 82589388363)
        self.assertEqual(money("7.50"), 750)
        self.assertEqual(money("5490089（含派奖172413）"), 549008900)
        self.assertEqual(money("0"), 0)
        for value in (None, "", "---", "-1"):
            self.assertIsNone(money(value))
        for value in ("NaN", "1.001", "xyz", "-3"):
            with self.assertRaises(ValueError): money(value)

    def test_issue_normalization_and_number_contract(self):
        self.assertEqual(canonical_issue("dlt", "26121"), "2026121")
        row = dict(lottery_type="ssq", issue="2026001", draw_date="2026-01-01", red=[1, 2, 3, 4, 5, 6], blue=[16])
        validate(row)  # Low sums and long consecutive runs are valid lottery outcomes.
        row["red"] = [1, 1, 3, 4, 5, 6]
        with self.assertRaises(ValueError): validate(row)

    def test_promotion_does_not_overwrite_basic_prize(self):
        row = dict(lotteryDrawNum="26066", lotteryDrawTime="2026-06-15", lotteryDrawResult="01 02 03 04 05 01 02",
                   prizeLevelList=[dict(group="501", sort=501, awardType=0, prizeLevel="三等奖", stakeCount="1205", stakeAmountFormat="6666"),
                                   dict(group="501", sort=502, awardType=1, prizeLevel="三等奖派奖", stakeCount="846", stakeAmountFormat="3333")])
        normalized = normalize("dlt", row, "sporttery")
        self.assertEqual(len({p["tier"] for p in normalized["prize_tiers"]}), 2)
        self.assertEqual(normalized["prize_tiers"][0]["amount_cents"], 666600)
        row["poolBalanceAfterdraw"] = "0"
        uncertain = normalize("dlt", row, "sporttery")
        self.assertEqual(uncertain["pool_cents"], 0)
        self.assertIn("pool_zero_unverified", uncertain["metadata_flags"])

    def test_grouped_regions_are_stakes(self):
        rs = parse_regions("山西、江苏、山东、广东、重庆、宁夏各1注。")
        self.assertEqual(len(rs), 6)
        self.assertEqual(sum(r["first_prize_stakes"] for r in rs), 6)
        self.assertEqual(sum(r["first_prize_stakes"] for r in parse_regions("河北中出2注，北京、山东和河南各1注。")), 5)
        self.assertEqual(len(parse_news_regions("均未选择追加，6注头奖分落河北、辽宁、湖北、海南、陕西、甘肃。", 6)), 6)
        self.assertEqual(parse_news_regions("头奖全部未追加，3注基础头奖分落江苏和河南。", 3), [])

    def test_conflicting_sources_never_silently_replace_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = connect(Path(tmp) / "lottery.sqlite")
            row = dict(issueNo="2026001", openTime="2026-01-01 21:15:00", redResults=["01", "02", "03", "04", "05", "06"], blueResults=["01"])
            draw = normalize("ssq", row, "sina")
            meta = dict(sha256="a", url="https://example.org", retrieved_at="2026-01-02", raw_path="fixture.json")
            store(db, [draw], meta)
            # Official metadata upgrades preserve the independent source observation.
            official = copy.deepcopy(draw); official["provider"] = "cwl"; official["pool_cents"] = 0
            store(db, [official], {**meta, "sha256": "b"})
            store(db, [draw], meta)
            saved = json.loads(db.execute("SELECT payload FROM draws").fetchone()[0])
            self.assertEqual(saved["provider"], "cwl")
            self.assertEqual(saved["pool_cents"], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM observations").fetchone()[0], 2)
            wrong = copy.deepcopy(official); wrong["red"] = [7, 8, 9, 10, 11, 12]
            with patch("pipeline.DATA", Path(tmp)):
                with self.assertRaises(ValueError):
                    store(db, [wrong], {**meta, "sha256": "c"})
            saved = json.loads(db.execute("SELECT payload FROM draws").fetchone()[0])
            self.assertEqual(saved["red"], [1, 2, 3, 4, 5, 6])
            db.close()


class TrainingTests(unittest.TestCase):
    def test_daily_append_preserves_evaluation_boundaries(self):
        draws = [{"issue": str(i)} for i in range(1000)]
        original = evaluation_slices(draws)
        reference = {"split": {name: dict(first_issue=draws[200:][sl][0]["issue"], last_issue=draws[200:][sl][-1]["issue"], count=len(draws[200:][sl])) for name, sl in original.items()}}
        appended = draws + [{"issue": str(i)} for i in range(1000, 1020)]
        self.assertEqual(evaluation_slices(appended, reference), original)
        with self.assertRaises((ValueError, KeyError)):
            evaluation_slices(appended[:300] + appended[301:], reference)

    def test_automation_requires_safe_origin_and_unchanged_published_cutoff(self):
        for url in ("http://example.org", "https://user:password@example.org", "https://example.org/api", "https://example.org?key=x"):
            with self.assertRaises(ValueError): API(url, "x" * 32)
        API("https://example.org", "x" * 32)
        API("http://127.0.0.1:8791", "x" * 32, allow_local=True)
        reference = {"lotteries": {"ssq": {"coverage": {"count": 1, "last_issue": "2026001"}, "latest_draw": {"draw_date": "2026-01-01", "red": [1], "blue": [1]}}}}
        rows = {"ssq": [{"issue": "2026001", "draw_date": "2026-01-01", "red": [1], "blue": [1]}]}
        self.assertFalse(ensure_not_regressed(rows, reference))
        rows["ssq"].append({**rows["ssq"][0], "issue": "2026002"})
        self.assertTrue(ensure_not_regressed(rows, reference))
        rows["ssq"][0]["blue"] = [2]
        with self.assertRaises(ValueError): ensure_not_regressed(rows, reference)

    @staticmethod
    def dataset():
        start = dt.date(2020, 1, 1)
        draws = []
        for i in range(260):
            nums = sorted({(i + n) % 33 + 1 for n in range(6)})
            draws.append(dict(draw_date=(start + dt.timedelta(days=i * 2)).isoformat(), red=nums,
                              blue=[i % 16 + 1], sales_cents=i * 10000, pool_cents=i * 100000,
                              prize_tiers=[dict(label="1等奖", stakes=2, amount_cents=500000000)], regions=[]))
        return draws

    def test_future_and_current_outcomes_do_not_enter_features(self):
        draws = self.dataset()
        before = feature_at(draws, labels(draws, "red", 33), 220, draws[220]["draw_date"])
        for draw in draws[220:]:
            draw["red"] = [20, 21, 22, 23, 24, 25]
            draw["sales_cents"] = 10 ** 20
        after = feature_at(draws, labels(draws, "red", 33), 220, draws[220]["draw_date"])
        np.testing.assert_array_equal(before[0], after[0])
        np.testing.assert_array_equal(before[1], after[1])

    def test_metadata_obeys_two_draw_lag_and_48h_embargo(self):
        draws = self.dataset()
        before, idx = metadata(draws, 220, draws[220]["draw_date"])
        self.assertLessEqual(idx, 218)
        draws[219]["pool_cents"] = 10 ** 20
        draws[220]["pool_cents"] = 10 ** 20
        after, _ = metadata(draws, 220, draws[220]["draw_date"])
        np.testing.assert_array_equal(before, after)
        draws[idx]["metadata_flags"] = ["pool_zero_unverified"]
        draws[idx]["pool_cents"] = 0
        flagged, _ = metadata(draws, 220, draws[220]["draw_date"])
        self.assertEqual(flagged[6], 1)  # uncertain source zero is missing to the model
        self.assertLessEqual(dt.date.fromisoformat(draws[idx]["draw_date"]) + dt.timedelta(days=2), dt.date.fromisoformat(draws[220]["draw_date"]))

    def test_model_reproducibility_and_fixed_count_marginals(self):
        draws = self.dataset()
        y = labels(draws, "red", 33)
        x = np.array([feature_at(draws, y, i, draws[i]["draw_date"])[0] for i in range(200, 230)])
        a, b = fit(x, y[200:230], .1), fit(x, y[200:230], .1)
        self.assertEqual(a, b)
        p = predict(a, x, 6)
        np.testing.assert_allclose(p.sum(axis=1), 6, atol=1e-10)
        self.assertTrue(np.all((p > 0) & (p < 1)))

    def test_same_seed_unique_legal_tickets_and_budget(self):
        for kind, red_count, blue_count in (("ssq", 6, 1), ("dlt", 5, 2)):
            plans = tickets(kind, 20, 123)
            self.assertEqual(plans, tickets(kind, 20, 123))
            self.assertEqual(len({json.dumps(t) for t in plans}), 20)
            for t in plans:
                self.assertEqual(len(t["red"]), red_count)
                self.assertEqual(len(t["blue"]), blue_count)


if __name__ == "__main__":
    unittest.main()
