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
        report["body_preview"] = body[:400].decode(errors="replace")
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
    from curl_cffi import requests
    for name, url, _ in (cases[0], cases[-1]):
        try:
            response = requests.get(url, impersonate="chrome", timeout=25,
                                    headers={"Referer": "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/"})
            report = dict(name=name, client="curl_cffi", http_status=response.status_code)
            try:
                data = response.json()
                report.update(json=True, state=data.get("state"))
            except ValueError:
                report.update(json=False, body_preview=response.text[:400])
            print(json.dumps(report), flush=True)
        except Exception as error:
            print(json.dumps(dict(name=name, client="curl_cffi", error_type=type(error).__name__)), flush=True)
