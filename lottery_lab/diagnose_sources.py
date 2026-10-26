"""Manual CI connectivity check for public draw sources; no credentials used."""
import concurrent.futures
import json
import subprocess
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
        data = json.loads(body)
        report.update(json=True, state=data.get("state"), count=len(data.get("result", [])) if isinstance(data.get("result"), list) else None)
    except (ValueError, TypeError):
        report["json"] = False
    return report


if __name__ == "__main__":
    base = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice?"
    cases = []
    for system, size, browser in [("PC", 100, False), ("PC", 100, True), ("PC", 30, True), ("H5", 30, True), (None, 30, True)]:
        params = dict(name="ssq", pageNo=1, pageSize=size)
        if system:
            params["systemType"] = system
        cases.append((f"cwl-{system}-{size}-browser-{browser}", base + urlencode(params), browser))
    cases.append(("sporttery", "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85&provinceId=0&pageSize=100&isVerify=1&pageNo=1", True))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(probe, cases):
            print(json.dumps(result), flush=True)
