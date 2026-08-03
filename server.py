#!/usr/bin/env python3
"""市场信号监测 — 本地数据服务器（Python 标准库，零第三方依赖）

数据源（全部免密钥；FRED API key 可选，用于解锁 ICE BofA 系列的完整历史）：
  - FRED  fredgraph.csv     宏观序列（利差、收益率曲线、初请、VIX、NFCI）
  - Cboe  cdn.cboe.com      SPX 指数日线（1975 年至今）
  - Nasdaq api.nasdaq.com   ETF 日线（最近 10 年，未复权价格）

用法:  python3 server.py [端口]   （默认 8967）
可选:  export FRED_API_KEY=xxx   或在项目根目录 config.json 写 {"fred_api_key": "xxx"}
"""
import contextlib
import csv
import gzip
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
CACHE_DIR = os.path.join(ROOT, "data", "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# 缓存时长（秒）：这些数据每天只更新一次，长缓存也能显著降低被上游风控的概率
TTL_BY_SRC = {"fred": 12 * 3600, "cboe": 12 * 3600, "nasdaq": 6 * 3600,
              "aaii": 24 * 3600, "cot": 24 * 3600, "naaim": 24 * 3600,
              "finra": 24 * 3600, "ibkr": 24 * 3600}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def load_fred_key():
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        return key
    cfg = os.path.join(ROOT, "config.json")
    if os.path.exists(cfg):
        try:
            with open(cfg) as f:
                return (json.load(f).get("fred_api_key") or "").strip()
        except Exception:
            pass
    return ""


FRED_KEY = load_fred_key()

# ---------------------------------------------------------------- 序列注册表
# ICE BofA 授权系列（BAML*）走免密钥的 fredgraph.csv 时只返回最近 3 年，
# 配置了 FRED API key 后自动改走官方 API 拿完整历史。
SERIES = {
    # ---- FRED 宏观 ----
    # accumulate: FRED 对 ICE BofA 只提供最近 3 年滚动窗口（授权限制，API 同样受限），
    # 因此每次刷新做合并累积而非覆盖，随时间沉淀更长历史
    "hy_oas":  {"src": "fred", "id": "BAMLH0A0HYM2", "cosd": "1996-12-31",
                "accumulate": True},
    "t10y3m":  {"src": "fred", "id": "T10Y3M",       "cosd": "1982-01-01"},
    "icsa":    {"src": "fred", "id": "ICSA",         "cosd": "1980-01-01"},
    "vix":     {"src": "fred", "id": "VIXCLS",       "cosd": "1990-01-01"},
    "vix3m":   {"src": "fred", "id": "VXVCLS",       "cosd": "2007-12-01"},
    "nfci":    {"src": "fred", "id": "NFCI",         "cosd": "1985-01-01"},
    # ---- Cboe 指数 ----
    "spx":     {"src": "cboe", "id": "SPX"},
    # ---- AAII 散户情绪调查（周频，1987 至今；单 key 含三条分项序列） ----
    "aaii":    {"src": "aaii"},
    # ---- 其他情绪/仓位类 ----
    "skew":    {"src": "cboe", "id": "SKEW"},
    "umcsent": {"src": "fred", "id": "UMCSENT", "cosd": "1952-11-01"},
    "cot":     {"src": "cot"},     # CFTC E-mini 标普投机者净头寸
    "naaim":   {"src": "naaim"},   # NAAIM 主动管理人股票敞口
    "finra_margin": {"src": "finra"},  # FINRA 融资余额（月频）
    # IBKR 客户保证金贷款（月频，次月1-3日即发布，作为 FINRA 的前哨；
    # accumulate：官方仅稳定提供最新一期 PDF，历史靠逐月累积+首次回填）
    "ibkr_margin": {"src": "ibkr", "accumulate": True},
    # ---- Nasdaq ETF（近 10 年，未复权） ----
    **{k: {"src": "nasdaq", "id": k.upper()} for k in [
        "spy", "qqq", "rsp", "mtum", "tlt", "gld", "eem",
        "xlb", "xle", "xlf", "xli", "xlk", "xlp", "xlu", "xlv", "xly",
        "xlre", "xlc",
    ]},
}

_locks = {}
_locks_guard = threading.Lock()
_host_gates = {}


def _key_lock(key):
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


@contextlib.contextmanager
def _pace(host, interval):
    """对同一上游主机真正串行 + 最小间隔（整段请求持锁）。

    仅隔开“起始时刻”不够：抓取本身耗时数秒时仍会产生并发在途请求，
    并发突发正是最容易触发 CDN 风控的模式。
    """
    with _locks_guard:
        gate = _host_gates.setdefault(host, [threading.Lock(), 0.0])
    with gate[0]:
        wait = interval - (time.time() - gate[1])
        if wait > 0:
            time.sleep(wait)
        try:
            yield
        finally:
            gate[1] = time.time()


def http_get_bytes(url, headers=None, timeout=30, ua=None):
    """用系统 curl 抓取上游数据（原始字节）。

    重要教训：FRED 的 CDN（Akamai）会校验 TLS 指纹与 User-Agent 是否匹配——
    非浏览器客户端伪装 Chrome UA 会被直接拒绝（连接挂起或 HTTP/2 流错误），
    而用 curl 默认 UA 反而一切正常。所以默认不设置 UA；只有 Nasdaq 与
    AAII 的接口需要浏览器式头部（ua 参数显式传入）。
    """
    cmd = ["/usr/bin/curl", "-sS", "-f", "--compressed",
           "--max-time", str(int(timeout)), "--config", "-"]
    if ua:
        cmd += ["-A", ua]
    for k, v in (headers or {}).items():
        cmd += ["-H", "%s: %s" % (k, v)]
    try:
        # URL 经 stdin 传给 curl（--config -），避免 API key 出现在进程参数里被 ps 看到
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout + 15,
                              input=('url = "%s"\n' % url).encode())
    except subprocess.TimeoutExpired:
        raise RuntimeError("请求超时: " + url.split("?")[0])
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("抓取失败(exit %d): %s"
                           % (proc.returncode, err[-1] if err else url.split("?")[0]))
    return proc.stdout


def http_get(url, headers=None, timeout=30, ua=None):
    return http_get_bytes(url, headers, timeout, ua).decode("utf-8", errors="replace")


def http_get_retry(url, headers=None, timeout=30, pause=2.5, ua=None, binary=False):
    """失败后温和地重试一次（间隔 pause 秒），避免重试风暴加剧风控。"""
    fn = http_get_bytes if binary else http_get
    try:
        return fn(url, headers, timeout, ua)
    except RuntimeError:
        time.sleep(pause)
        return fn(url, headers, timeout, ua)


def mdy_to_iso(s):
    m, d, y = s.strip().split("/")
    return "%s-%02d-%02d" % (y, int(m), int(d))


# ---------------------------------------------------------------- 各数据源抓取
def fetch_fred(series_id, cosd):
    """返回 (dates, values, note)。有 API key 时走官方 API（更稳定）。

    注意：ICE BofA 系列（BAML*）无论走哪个通道都只有最近 3 年——
    这是 FRED 与 ICE 的数据授权限制，与 API key 无关。
    """
    note = ""
    if series_id.startswith("BAML"):
        note = ("FRED 对 ICE BofA 系列只提供最近 3 年（ICE 授权限制，API 亦然）。"
                "本站每次刷新自动累积历史：运行越久，可回看的历史越长。")
    if FRED_KEY:
        url = ("https://api.stlouisfed.org/fred/series/observations?"
               + urllib.parse.urlencode({
                   "series_id": series_id, "api_key": FRED_KEY,
                   "file_type": "json", "observation_start": cosd,
               }))
        with _pace("api.stlouisfed.org", 0.6):
            obj = json.loads(http_get_retry(url))
        dates, values = [], []
        for ob in obj.get("observations", []):
            v = ob.get("value", ".")
            if v in (".", "", None):
                continue
            dates.append(ob["date"])
            values.append(float(v))
        return dates, values, note

    url = ("https://fred.stlouisfed.org/graph/fredgraph.csv?"
           + urllib.parse.urlencode({"id": series_id, "cosd": cosd}))
    with _pace("fred.stlouisfed.org", 1.5):
        text = http_get_retry(url)
    if text.lstrip().startswith("<"):
        raise RuntimeError("FRED 返回了非 CSV 内容（%s）" % series_id)
    rows = list(csv.reader(io.StringIO(text)))
    dates, values = [], []
    for row in rows[1:]:
        if len(row) < 2 or row[1] in (".", ""):
            continue
        dates.append(row[0])
        values.append(float(row[1]))
    return dates, values, note


def fetch_cboe(index_id):
    url = ("https://cdn.cboe.com/api/global/us_indices/daily_prices/%s_History.csv"
           % index_id)
    with _pace("cdn.cboe.com", 0.3):
        text = http_get_retry(url)
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        raise RuntimeError("Cboe 返回空数据（%s）" % index_id)
    header = [h.strip().upper() for h in rows[0]]
    col = header.index("CLOSE") if "CLOSE" in header else len(header) - 1
    seen = {}
    for row in rows[1:]:
        if len(row) <= col or not row[col].strip():
            continue
        try:
            seen[mdy_to_iso(row[0])] = float(row[col])
        except ValueError:
            continue
    dates = sorted(seen)
    return dates, [seen[d] for d in dates], ""


def fetch_nasdaq(symbol):
    today = date.today()
    # 用 timedelta 而不是 replace(year=...)：后者在 2 月 29 日会抛 ValueError
    frm = today - timedelta(days=3653)
    url = ("https://api.nasdaq.com/api/quote/%s/historical?" % symbol
           + urllib.parse.urlencode({
               "assetclass": "etf", "limit": 9999,
               "fromdate": frm.isoformat(), "todate": today.isoformat(),
           }))
    with _pace("api.nasdaq.com", 0.45):
        text = http_get_retry(url, headers={
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        }, ua=UA)
    obj = json.loads(text)
    table = (obj.get("data") or {}).get("tradesTable") or {}
    rows = table.get("rows") or []
    if not rows:
        raise RuntimeError("Nasdaq 未返回 %s 的数据: %s"
                           % (symbol, (obj.get("status") or {})))
    seen = {}
    for r in rows:
        try:
            raw = str(r.get("close") or "").replace("$", "").replace(",", "").strip()
            if not raw:
                continue
            seen[mdy_to_iso(r["date"])] = float(raw)
        except (ValueError, KeyError, TypeError, AttributeError):
            continue  # 单行畸形数据跳过，不拖垮整个序列
    dates = sorted(seen)
    return dates, [seen[d] for d in dates],\
        "未复权收盘价：含分红资产（债券/高股息 ETF）的长期动量会被略微低估。"


def fetch_aaii():
    """AAII 官方 sentiment.xls：values=看多%，另附 neutral/bearish 两列。"""
    import aaii_xls
    with _pace("www.aaii.com", 1.0):
        raw = http_get_retry(
            "https://www.aaii.com/files/surveys/sentiment.xls",
            headers={
                "Accept": ("text/html,application/xhtml+xml,application/xml;"
                           "q=0.9,*/*;q=0.8"),
                "Accept-Language": "en-US,en;q=0.9",
            }, ua=UA, binary=True)
    dates, bull, neutral, bear = aaii_xls.parse_sentiment(raw)
    return dates, bull, {"neutral": neutral, "bearish": bear}


def fetch_cot():
    """CFTC COT（Legacy）：E-mini 标普 500 非商业净头寸占未平仓量 %。周频。"""
    url = ("https://publicreporting.cftc.gov/resource/6dca-aqww.json?"
           + urllib.parse.urlencode({
               "cftc_contract_market_code": "13874A",
               "$select": ("report_date_as_yyyy_mm_dd,noncomm_positions_long_all,"
                           "noncomm_positions_short_all,open_interest_all"),
               "$order": "report_date_as_yyyy_mm_dd",
               "$limit": "9000",
           }))
    with _pace("publicreporting.cftc.gov", 0.5):
        arr = json.loads(http_get_retry(url))
    if not isinstance(arr, list) or len(arr) < 500:
        raise RuntimeError("CFTC 返回异常（%s 条）" % (len(arr) if isinstance(arr, list) else "?"))
    dates, values = [], []
    for row in arr:
        try:
            oi = float(row["open_interest_all"])
            if oi <= 0:
                continue
            net = (float(row["noncomm_positions_long_all"])
                   - float(row["noncomm_positions_short_all"])) / oi * 100
            dates.append(row["report_date_as_yyyy_mm_dd"][:10])
            values.append(round(net, 2))
        except (KeyError, ValueError, TypeError):
            continue
    if (date.today() - date.fromisoformat(dates[-1])).days > 21:
        raise RuntimeError("CFTC 最新数据过旧: " + dates[-1])
    return dates, values, "统计截至每周二，CFTC 于周五发布。"


def fetch_naaim():
    """NAAIM 主动管理人股票敞口指数（周频，2006 至今）。

    数据文件 URL 每周变化，先抓页面正则出当期 xlsx 链接再下载解析。"""
    import xlsx_mini
    with _pace("naaim.org", 1.0):
        page = http_get_retry(
            "https://naaim.org/programs/naaim-exposure-index/",
            headers={"Accept": "text/html,*/*;q=0.8",
                     "Accept-Language": "en-US,en;q=0.9"}, ua=UA)
        import re as _re
        m = _re.search(r'href="(https://naaim\.org/wp-content/uploads/[^"]+?\.xlsx)"', page)
        if not m:
            raise RuntimeError("NAAIM 页面上找不到数据文件链接（页面结构可能已变）")
        raw = http_get_retry(m.group(1), headers={"Accept": "*/*"}, ua=UA, binary=True)
    epoch = date(1899, 12, 30)
    seen = {}
    for r in xlsx_mini.rows(raw):
        d, v = r.get("A"), r.get("B")
        if not isinstance(d, float) or not isinstance(v, float):
            continue  # 表头/杂项行
        if not (38000 < d < 60000 and -250 <= v <= 350):
            continue
        seen[(epoch + timedelta(days=int(d))).isoformat()] = round(v, 2)
    dates = sorted(seen)
    if len(dates) < 800:
        raise RuntimeError("NAAIM 解析行数异常（%d）" % len(dates))
    if (date.today() - date.fromisoformat(dates[-1])).days > 21:
        raise RuntimeError("NAAIM 最新数据过旧: " + dates[-1])
    return dates, [seen[d] for d in dates], "每周三统计，周四前后发布。"


def fetch_finra_margin():
    """FINRA 客户融资余额（月频，1997 至今，单位百万美元）。

    注意：finra.org 与 FRED 同一脾气——浏览器 UA + 非浏览器 TLS 会被拦，
    必须用 curl 默认 UA。"""
    import xlsx_mini
    with _pace("www.finra.org", 1.0):
        raw = http_get_retry(
            "https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx",
            binary=True)
    seen = {}
    for r in xlsx_mini.rows(raw):
        d, v = r.get("A"), r.get("B")
        if not isinstance(d, str) or not isinstance(v, float):
            continue
        d = d.strip()
        # 月份限 1-12、余额限 5万~2000万（百万美元）：双重防护标签/脚注行混入
        if (len(d) == 7 and d[4] == "-" and d[:4].isdigit() and d[5:7].isdigit()
                and 1 <= int(d[5:7]) <= 12 and 5e4 <= v <= 2e7):
            seen[d + "-01"] = v  # 记在当月月初
    dates = sorted(seen)
    if len(dates) < 300:
        raise RuntimeError("FINRA 解析行数异常（%d）" % len(dates))
    # 阈值 100 天：数据记在月初、代表月末余额、发布再滞后约一个月，
    # 最坏情形（下月数据发布前夕）距离戳记日期可达 ~85 天
    if (date.today() - date.fromisoformat(dates[-1])).days > 100:
        raise RuntimeError("FINRA 最新数据过旧: " + dates[-1])
    return dates, [seen[d] for d in dates], "月频，月末数据约有一个月发布滞后。"


def pdf_to_text(raw):
    """PDF → 文本：优先 pdftotext（CI 的 ubuntu 装 poppler-utils），
    退回 macOS 系统自带的 PDFKit（osascript/JXA），两个环境都零 pip 依赖。"""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(raw)
        path = f.name
    try:
        if shutil.which("pdftotext"):
            p = subprocess.run(["pdftotext", "-q", path, "-"],
                               capture_output=True, timeout=30)
            if p.returncode == 0 and p.stdout.strip():
                return p.stdout.decode("utf-8", "replace")
        if sys.platform == "darwin":
            jxa = ('ObjC.import("Quartz");'
                   'const d=$.PDFDocument.alloc.initWithURL('
                   '$.NSURL.fileURLWithPath("%s"));d.string.js' % path)
            p = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", jxa],
                               capture_output=True, timeout=30)
            if p.returncode == 0 and p.stdout.strip():
                return p.stdout.decode("utf-8", "replace")
        raise RuntimeError("无可用的 PDF 文本提取器（Linux 需 pdftotext，macOS 用系统 PDFKit）")
    finally:
        os.unlink(path)


_MONTHS_EN = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}


def _parse_ibkr_pdf(raw):
    """从 IBKR 月度指标新闻稿 PDF 提取 (数据月份YYYY-MM-01, 保证金贷款$B)。"""
    text = pdf_to_text(raw)
    mm = re.search(r"(?:Information\s+)?for\s+(%s)\s+(\d{4})" % "|".join(_MONTHS_EN), text)
    bal = re.search(r"margin loan balances of\s+\$([\d,.]+)\s+billion", text, re.I)
    if not mm or not bal:
        raise RuntimeError("IBKR PDF 解析失败（新闻稿格式可能已变）")
    key = "%04d-%02d-01" % (int(mm.group(2)), _MONTHS_EN[mm.group(1)])
    val = float(bal.group(1).replace(",", ""))
    if not 5 <= val <= 2000:
        raise RuntimeError("IBKR 保证金贷款数值可疑: %s" % val)
    return key, val


def fetch_ibkr():
    """IBKR 客户保证金贷款（$B）。总是抓最新一期；历史不足 13 个月时
    按 YYYYMMMetricsPressRelease.pdf 命名规律回填（发布月 = 数据月+1）。"""
    seen = {}
    with _pace("www.interactivebrokers.com", 1.2):
        raw = http_get_retry(
            "https://www.interactivebrokers.com/mkt/getFileNew.php?file=latestMetricPR",
            binary=True)
    k, v = _parse_ibkr_pdf(raw)
    seen[k] = v

    cache_path = os.path.join(CACHE_DIR, "ibkr_margin.json")
    have = 0
    if os.path.exists(cache_path):
        try:
            with open(cache_path) as f:
                have = len(json.load(f).get("dates", []))
        except Exception:
            pass
    if have < 13:  # 首次运行：回填最近约 14 个月供前端校准与 FINRA 的相关性
        y, m = int(k[:4]), int(k[5:7])
        for _ in range(14):
            m -= 1
            if m == 0:
                y, m = y - 1, 12
            rel_y, rel_m = (y, m + 1) if m < 12 else (y + 1, 1)
            url = ("https://www.interactivebrokers.com/mkt/getFileNew.php?"
                   "file=%04d%02dMetricsPressRelease.pdf" % (rel_y, rel_m))
            try:
                with _pace("www.interactivebrokers.com", 1.2):
                    kk, vv = _parse_ibkr_pdf(http_get_retry(url, binary=True))
                seen[kk] = vv
            except Exception as e:
                sys.stderr.write("IBKR 回填 %04d-%02d 失败: %s\n" % (y, m, e))
    dates = sorted(seen)
    return dates, [seen[d] for d in dates], \
        "IBKR 客户保证金贷款（十亿美元），次月 1-3 日发布，作为 FINRA 的前哨参考。"


def fetch_series(key):
    spec = SERIES[key]
    extra = {}
    if spec["src"] == "fred":
        dates, values, note = fetch_fred(spec["id"], spec["cosd"])
    elif spec["src"] == "cboe":
        dates, values, note = fetch_cboe(spec["id"])
    elif spec["src"] == "aaii":
        dates, values, extra = fetch_aaii()
        note = ""
    elif spec["src"] == "cot":
        dates, values, note = fetch_cot()
    elif spec["src"] == "naaim":
        dates, values, note = fetch_naaim()
    elif spec["src"] == "finra":
        dates, values, note = fetch_finra_margin()
    elif spec["src"] == "ibkr":
        dates, values, note = fetch_ibkr()
    else:
        dates, values, note = fetch_nasdaq(spec["id"])
    if not dates:
        raise RuntimeError("空数据: " + key)
    return {
        "key": key, "source": spec["src"], "source_id": spec.get("id", key),
        "dates": dates, "values": values, "note": note,
        "fetched_at": int(time.time()), **extra,
    }


FAIL_BACKOFF = 180  # 秒：某序列刚失败过就先不再打上游，直接回退缓存/快速报错
_last_fail = {}


def merge_accumulated(old, new):
    """滚动窗口序列的累积合并：旧缓存中超出当前窗口的早期数据永久保留，
    重叠日期以新抓取的数据为准（覆盖上游修正值）。"""
    m = dict(zip(old.get("dates", []), old.get("values", [])))
    m.update(zip(new["dates"], new["values"]))
    dates = sorted(m)
    out = dict(new)
    out["dates"] = dates
    out["values"] = [m[d] for d in dates]
    return out


def get_series(key):
    """磁盘缓存 + 失败退避 + 失败时回退旧缓存。"""
    ttl = TTL_BY_SRC.get(SERIES[key]["src"], 6 * 3600)
    path = os.path.join(CACHE_DIR, key + ".json")
    cached = None
    if os.path.exists(path):
        try:
            with open(path) as f:
                cached = json.load(f)
        except Exception:
            cached = None
    if cached and time.time() - cached.get("fetched_at", 0) < ttl:
        return cached

    with _key_lock(key):
        # 双重检查：等锁期间可能已被其他请求刷新
        if os.path.exists(path):
            try:
                with open(path) as f:
                    cached = json.load(f)
                if time.time() - cached.get("fetched_at", 0) < ttl:
                    return cached
            except Exception:
                pass
        # 失败退避：退避窗口内不再重复慢速失败、也不再轰击上游
        if time.time() - _last_fail.get(key, 0) < FAIL_BACKOFF:
            if cached:
                stale = dict(cached)
                stale["stale"] = True
                stale["note"] = ((stale.get("note") or "")
                                 + " ⚠ 上游暂时不可用，展示的是缓存数据")
                return stale
            raise RuntimeError("上游数据源暂时不可用，请约 %d 秒后重试" % FAIL_BACKOFF)
        try:
            data = fetch_series(key)
            _last_fail.pop(key, None)
            if SERIES[key].get("accumulate") and cached and cached.get("dates"):
                data = merge_accumulated(cached, data)
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
            os.replace(tmp, path)
            return data
        except Exception as e:
            _last_fail[key] = time.time()
            if cached:
                stale = dict(cached)
                stale["stale"] = True
                stale["note"] = ((stale.get("note") or "")
                                 + " ⚠ 本次刷新失败，展示的是缓存数据（%s）" % e)
                return stale
            raise


# ---------------------------------------------------------------- HTTP 服务
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, code, body, ctype, cache="no-cache"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        use_gzip = ("gzip" in (self.headers.get("Accept-Encoding") or "")
                    and len(raw) > 1024)
        if use_gzip:
            raw = gzip.compress(raw, 6)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", cache)
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(raw)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), MIME[".json"])

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/series":
                q = urllib.parse.parse_qs(parsed.query)
                key = (q.get("key") or [""])[0]
                if key not in SERIES:
                    return self._json({"error": "未知序列: %s" % key}, 404)
                try:
                    return self._json(get_series(key))
                except Exception as e:
                    return self._json({"error": str(e), "key": key}, 502)
            if parsed.path == "/api/meta":
                return self._json({
                    "fred_key": bool(FRED_KEY),
                    "series": sorted(SERIES),
                    "cache_ttl": TTL_BY_SRC,
                })
            return self._static(parsed.path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._json({"error": "服务器错误: %s" % e}, 500)
            except Exception:
                pass

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        fp = os.path.realpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not fp.startswith(os.path.realpath(PUBLIC) + os.sep):
            return self._send(403, "forbidden", "text/plain")
        if os.path.isdir(fp):  # 目录索引（与 GitHub Pages 行为对齐）
            fp = os.path.join(fp, "index.html")
        if not os.path.isfile(fp):
            return self._send(404, "not found", "text/plain")
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, "rb") as f:
            body = f.read()
        cache = "max-age=86400" if ext == ".js" and "vendor" in fp else "no-cache"
        self._send(200, body, MIME.get(ext, "application/octet-stream"), cache)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8967
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("市场信号监测 → http://127.0.0.1:%d  (FRED key: %s)"
          % (port, "已配置" if FRED_KEY else "未配置，OAS 仅最近3年"))
    srv.serve_forever()


if __name__ == "__main__":
    main()
