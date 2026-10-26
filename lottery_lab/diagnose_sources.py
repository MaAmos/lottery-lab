"""Manual CI connectivity check for public draw sources; no credentials used."""
import concurrent.futures
import json
import subprocess
import re
from urllib.parse import urlencode


def probe(item):
    name, url, browser = item
    command = ["curl", "--silent", "--show-error", "--location", "--max-time", "25",
               "--write-out", "\n%{http_code}", "-H", "Referer: https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/"]
    if browser:
        command += ["-A", "Mozilla/5.0", "-H", "Accept: application/json, text/plain, */*"]
    result = subprocess.run(command + [url], capture_output=True)
    body, _, status = result.stdout.rpartition(b"\n")
    report = dict(name=name, url=url, http_status=status.decode(errors="replace"), curl_exit=result.returncode)
    try:
        text = body.decode()
        if text.startswith("lotteryCallback("):
            text = text[len("lotteryCallback("):].removesuffix(";").removesuffix(")")
        data = json.loads(text)
        report.update(json=True, state=data.get("state"), count=len(data.get("result", [])) if isinstance(data.get("result"), list) else None)
    except (ValueError, TypeError):
        report["json"] = False
        report["body_preview"] = body[:400].decode(errors="replace")
    return report


if __name__ == "__main__":
    cases = [
        ("zhcw-ssq", "https://jc.zhcw.com/port/client_json.php?callback=lotteryCallback&transactionType=10001001&lotteryId=1&issueCount=100&startIssue=&endIssue=&startDate=&endDate=&type=0&pageNum=1&pageSize=100&tt=0.5", True),
        ("zhcw-dlt", "https://jc.zhcw.com/port/client_json.php?callback=lotteryCallback&transactionType=10001001&lotteryId=281&issueCount=100&startIssue=&endIssue=&startDate=&endDate=&type=0&pageNum=1&pageSize=100&tt=0.5", True),
        ("500-ssq", "https://datachart.500.com/ssq/history/newinc/history.php?limit=30&sort=0", True),
        ("500-dlt", "https://datachart.500.com/dlt/history/newinc/history.php?limit=30&sort=0", True),
        ("500-xml", "https://kaijiang.500.com/static/info/kaijiang/xml/ssq/list.xml", True),
        ("17500-ssq", "https://www.17500.cn/getData/ssq.TXT", True),
        ("17500-dlt", "https://www.17500.cn/getData/dlt.TXT", True),
        ("zhcw-html", "https://kaijiang.zhcw.com/zhcw/html/ssq/list_1.html", True),
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(probe, cases):
            print(json.dumps(result), flush=True)
