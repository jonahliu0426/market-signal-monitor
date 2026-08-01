/* 市场信号监测 — 前端逻辑
 * 数据由本地 server.py 代理（FRED / Cboe / Nasdaq），前端负责指标计算与展示。
 * 所有信号阈值仅为文献常用参考，不构成投资建议。
 */
"use strict";

/* ================= 主题色（dataviz 参考调色板 · 深/浅双档） =================
 * 状态色（红黄绿）两档通用；系列色与界面色按主题切换。
 * C 是可变引用：applyTheme 用 Object.assign 原地替换，所有图表在
 * 下一次渲染时自动读到新值。 */
const PALETTES = {
  dark: {
    surface: "#1a1a19", page: "#0d0d0d",
    ink: "#ffffff", ink2: "#c3c2b7", muted: "#898781",
    grid: "#2c2c2a", axis: "#383835", border: "rgba(255,255,255,0.10)",
    tipBg: "#232322",
    s1: "#3987e5", s2: "#d95926", s3: "#199e70",
    good: "#0ca30c", warn: "#fab219", serious: "#ec835a",
    crit: "#d03b3b", critSoft: "#e66767",
  },
  light: {
    surface: "#fcfcfb", page: "#f9f9f7",
    ink: "#0b0b0b", ink2: "#52514e", muted: "#898781",
    grid: "#e1e0d9", axis: "#c3c2b7", border: "rgba(11,11,11,0.10)",
    tipBg: "#ffffff",
    s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a",
    good: "#0ca30c", warn: "#fab219", serious: "#ec835a",
    crit: "#d03b3b", critSoft: "#e34948",
  },
};
const C = { ...PALETTES.dark };
const LEVEL = {
  good:    { color: C.good,     ico: "●" },
  warn:    { color: C.warn,     ico: "▲" },
  serious: { color: C.serious,  ico: "▲" },
  risk:    { color: C.critSoft, ico: "■" },
  info:    { color: C.muted,    ico: "◦" },
};
let themeMode = "dark";
try { themeMode = localStorage.getItem("msm-theme") === "light" ? "light" : "dark"; } catch (e) {}

/* ================= 双语支持 =================
 * 所有用户可见文案都写成 L(中文, English)；语言切换时重建指标注册表
 * 与全部视图（数据已缓存，重建为纯内存操作）。 */
let LANG = "zh";
try { LANG = localStorage.getItem("msm-lang") === "en" ? "en" : "zh"; } catch (e) {}
const L = (zh, en) => (LANG === "zh" ? zh : en);
const WEEKDAYS = () => (LANG === "zh"
  ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
  : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const FREQ_LABEL = {
  "每日更新": ["每日更新", "updated daily"],
  "每周更新": ["每周更新", "updated weekly"],
  "每月更新": ["每月更新", "updated monthly"],
};

function applyLang(lang) {
  LANG = lang;
  try { localStorage.setItem("msm-lang", lang); } catch (e) {}
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  INDICATORS = makeIndicators();
  updateStaticTexts();
  renderNav();
  renderStrip();
  renderCardShell();
  renderMetaLine();
  INDICATORS.forEach((ind) => buildIndicator(ind));
  if (currentDetail) { /* buildIndicator 完成后会自动刷新详情页 */ }
  else showOverview();
}

function updateStaticTexts() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  document.title = L("市场信号监测", "Market Signal Monitor");
  $("#topbar h1").textContent = L("市场信号监测", "Market Signal Monitor");
  $("#topbar .sub").textContent = L("宏观 & 市场 · 循证指标面板",
    "Macro & Markets · Evidence-based Dashboard");
  $(".nav-overview").innerHTML =
    `<span class="nav-dot" style="background:var(--muted)"></span>` +
    L("总览", "Overview");
  $("#back-btn").textContent = L("← 返回总览", "← Back to overview");
  $(".drag-hint").textContent = L(
    "提示：图内拖拽平移 · Ctrl+滚轮（触控板双指捏合）缩放 · 下方滑块可任意拖动时间窗口",
    "Tip: drag to pan · Ctrl+wheel (or pinch) to zoom · use the slider below to set any window");
  $(".disclaimer").innerHTML = L(
    "仅供研究参考，不构成投资建议。<br>数据可能延迟或含误差。",
    "For research only — not investment advice.<br>Data may be delayed or contain errors.");
  const lt = $("#lang-toggle");
  if (lt) lt.textContent = LANG === "zh" ? "EN · English" : "中 · 中文";
  const tt = $("#theme-toggle");
  if (tt) tt.textContent = themeMode === "dark"
    ? L("☀️ 浅色", "☀️ Light") : L("🌙 深色", "🌙 Dark");
}

let metaInfo = null; // {mode, meta?, manifest?}
function renderMetaLine() {
  if (!metaInfo) return;
  if (metaInfo.mode === "api") {
    $("#meta-line").innerHTML = metaInfo.meta.fred_key
      ? L("本地实时模式 · FRED API key 已配置", "Local live mode · FRED API key configured")
      : L("本地实时模式 · FRED key 未配置<br>（可免费申请写入 config.json，见 README）",
          "Local live mode · no FRED key<br>(free to obtain — see README)");
  } else if (metaInfo.mode === "bundle") {
    $("#meta-line").innerHTML =
      L("静态数据 · 版本 ", "Static data · version ") + esc(metaInfo.manifest.version) +
      "<br>" + L("生成于 ", "built ") +
      new Date(metaInfo.manifest.generated_at * 1000).toLocaleString(LANG === "zh" ? "zh-CN" : "en-US");
  } else {
    $("#meta-line").textContent = L("无法加载数据（api 与静态数据包均不可用）",
      "Failed to load data (neither API nor static bundle available)");
  }
}

function applyTheme(mode, rerender) {
  themeMode = mode;
  document.documentElement.dataset.theme = mode;
  Object.assign(C, PALETTES[mode]);
  LEVEL.good.color = C.good;
  LEVEL.warn.color = C.warn;
  LEVEL.serious.color = C.serious;
  LEVEL.risk.color = C.critSoft;
  LEVEL.info.color = C.muted;
  try { localStorage.setItem("msm-theme", mode); } catch (e) {}
  const btn = document.querySelector("#theme-toggle");
  if (btn) btn.textContent = mode === "dark"
    ? L("☀️ 浅色", "☀️ Light") : L("🌙 深色", "🌙 Dark");
  if (rerender) {
    INDICATORS.forEach((i) => { if (built[i.id]) updateCard(i); });
    if (currentDetail) showDetail(currentDetail);
  }
}

/* ================= 小工具 ================= */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const fmt = {
  pctS: (v, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d) + "%",
  pct: (v, d = 2) => v.toFixed(d) + "%",
  bpS: (v) => (v >= 0 ? "+" : "") + Math.round(v * 100) + " bp",
  wan: (v) => (LANG === "zh" ? (v / 1e4).toFixed(1) + "万" : (v / 1e3).toFixed(0) + "k"),
  num: (v, d = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }),
};
const pctOr = (v, d = 1) => (v == null ? "—" : fmt.pctS(v, d));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* 服务端返回的备注是中文固定文案，英文模式下按整句映射翻译（未知句子原样保留） */
const NOTE_I18N = [
  ["FRED 对 ICE BofA 系列只提供最近 3 年（ICE 授权限制，API 亦然）。本站每次刷新自动累积历史：运行越久，可回看的历史越长。",
   "FRED only distributes the trailing 3 years of ICE BofA series (an ICE licensing restriction that applies to the API as well). This site merges each refresh into a growing local archive."],
  ["未复权收盘价：含分红资产（债券/高股息 ETF）的长期动量会被略微低估。",
   "Unadjusted close prices: long-horizon momentum of dividend-paying assets (bond/high-yield ETFs) is slightly understated."],
  ["统计截至每周二，CFTC 于周五发布。",
   "Positions as of each Tuesday, published by the CFTC on Friday."],
  ["每周三统计，周四前后发布。",
   "Surveyed each Wednesday, published around Thursday."],
  ["月频，月末数据约有一个月发布滞后。",
   "Monthly; month-end figures are published with roughly a one-month lag."],
  ["IBKR 客户保证金贷款（十亿美元），次月 1-3 日发布，作为 FINRA 的前哨参考。",
   "IBKR client margin loans ($B), published on the 1st–3rd of the following month — a sentinel for FINRA."],
];
function translateNote(note) {
  if (LANG === "zh" || !note) return note;
  let out = note;
  for (const [zh, en] of NOTE_I18N) out = out.split(zh).join(en);
  return out
    .split("⚠ 本次刷新失败，展示的是缓存数据").join("⚠ refresh failed — showing cached data")
    .split("⚠ 上游暂时不可用，展示的是缓存数据").join("⚠ upstream temporarily unavailable — showing cached data");
}

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function rollingMax(values, n) {
  // 单调队列，O(N)
  const out = new Array(values.length).fill(null);
  const dq = [];
  for (let i = 0; i < values.length; i++) {
    while (dq.length && values[dq[dq.length - 1]] <= values[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = values[dq[0]];
  }
  return out;
}
function realizedVol(values, win = 20) {
  // 年化 %：过去 win 个交易日对数收益标准差 × sqrt(252)
  const out = new Array(values.length).fill(null);
  const rets = [0];
  for (let i = 1; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
  for (let i = win; i < values.length; i++) {
    let m = 0;
    for (let j = i - win + 1; j <= i; j++) m += rets[j];
    m /= win;
    let s2 = 0;
    for (let j = i - win + 1; j <= i; j++) s2 += (rets[j] - m) ** 2;
    out[i] = Math.sqrt(s2 / (win - 1)) * Math.sqrt(252) * 100;
  }
  return out;
}
function percentile(arr, x) {
  let c = 0;
  for (const v of arr) if (v <= x) c++;
  return (c / arr.length) * 100;
}
function alignTwo(a, b) {
  const mb = new Map(b.dates.map((d, i) => [d, b.values[i]]));
  const dates = [], va = [], vb = [];
  for (let i = 0; i < a.dates.length; i++) {
    if (mb.has(a.dates[i])) {
      dates.push(a.dates[i]);
      va.push(a.values[i]);
      vb.push(mb.get(a.dates[i]));
    }
  }
  return { dates, a: va, b: vb };
}
function spanYears(dates) {
  if (dates.length < 2) return 0;
  return (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 864e5);
}
function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 864e5);
}
function idxOffset(arr, k) {
  // 距末尾 k 个位置的值；不足返回 null
  return arr.length > k ? arr[arr.length - 1 - k] : null;
}
function runStartDate(dates, values, pred) {
  // 从末尾回溯，找当前状态（pred 为真）开始的日期
  let i = values.length - 1;
  if (!pred(values[i])) return null;
  while (i > 0 && pred(values[i - 1])) i--;
  return dates[i];
}

/* ================= 数据层 =================
 * 双模式：本地开发有 server.py 时走 /api（实时抓取+缓存）；
 * 全静态部署（GitHub Pages 等）时 api 不存在，改读预生成的 bundle。
 * 路径全部用相对形式，兼容子路径部署（如 user.github.io/repo/）。 */
const dataMode = fetch("api/meta")
  .then((r) => { if (!r.ok) throw new Error("no api"); return r.json(); })
  .then((meta) => ({ mode: "api", meta }))
  .catch(() =>
    fetch("data/manifest.json", { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error("no manifest"); return r.json(); })
      .then((manifest) =>
        // bundle 文件名含内容哈希，可被浏览器/CDN 永久缓存
        fetch("data/" + manifest.file)
          .then((r) => { if (!r.ok) throw new Error("bundle 加载失败"); return r.json(); })
          .then((bundle) => ({ mode: "bundle", manifest, bundle }))));

const seriesCache = {};
function loadSeries(key) {
  if (!seriesCache[key]) {
    seriesCache[key] = dataMode
      .then((d) => {
        if (d.mode === "bundle") {
          const s = d.bundle.series[key];
          if (!s) throw new Error("数据包中缺少序列 " + key);
          return s;
        }
        return fetch("api/series?key=" + key).then((r) => r.json()).then((j) => {
          if (j.error) throw new Error(j.error);
          return j;
        });
      })
      .catch((e) => {
        delete seriesCache[key]; // 允许重试
        throw e;
      });
  }
  return seriesCache[key];
}

/* ================= ECharts 公共配置 ================= */
const liveCharts = [];
window.addEventListener("resize", () => liveCharts.forEach((c) => c.resize()));
function disposeCharts() {
  while (liveCharts.length) liveCharts.pop().dispose();
}

function baseAxes(dates, opts = {}) {
  return {
    xAxis: {
      type: "category", boundaryGap: false, data: dates,
      axisLine: { lineStyle: { color: C.axis } },
      axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v.slice(0, 7) },
      ...opts.xAxis,
    },
    yAxis: {
      type: "value", scale: true,
      splitLine: { lineStyle: { color: C.grid, width: 1 } },
      axisLabel: { color: C.muted, fontSize: 11, formatter: opts.yFmt },
      ...opts.yAxis,
    },
  };
}
function baseTooltip(valueFormatter) {
  return {
    trigger: "axis",
    axisPointer: {
      type: "cross",
      label: { backgroundColor: C.axis, color: C.ink },
      crossStyle: { color: C.muted },
    },
    backgroundColor: C.tipBg, borderColor: C.border,
    textStyle: { color: C.ink2, fontSize: 12 },
    valueFormatter,
  };
}
function baseZoom(xAxisIndex = [0]) {
  return [
    // zoomOnMouseWheel:'ctrl' —— 普通滚轮留给页面滚动；Ctrl+滚轮（触控板捏合）缩放图表
    { type: "inside", xAxisIndex, filterMode: "filter", zoomOnMouseWheel: "ctrl", moveOnMouseMove: true },
    {
      type: "slider", xAxisIndex, height: 34, bottom: 10,
      borderColor: C.axis, fillerColor: "rgba(57,135,229,0.12)",
      handleStyle: { color: C.s1 }, moveHandleStyle: { color: C.muted },
      textStyle: { color: C.muted, fontSize: 10 },
      dataBackground: { lineStyle: { color: C.axis }, areaStyle: { color: "rgba(137,135,129,0.12)" } },
      selectedDataBackground: { lineStyle: { color: C.s1 }, areaStyle: { color: "rgba(57,135,229,0.15)" } },
      emphasis: { handleStyle: { color: C.s1 } },
    },
  ];
}
function lineSeries(name, data, color, extra = {}) {
  return {
    name, type: "line", data, showSymbol: false, sampling: "lttb",
    lineStyle: { width: 2, color }, itemStyle: { color },
    emphasis: { disabled: true },
    ...extra,
  };
}
/* 按阈值把序列拆成上/下两段（跨越点两侧共享，避免断口），
 * 用双系列替代 visualMap 分段着色 —— ECharts 5.5.1 中
 * visualMap + dataZoom 组合会触发内部渲染崩溃（已实测确认）。 */
function splitByThreshold(values, thr) {
  const above = new Array(values.length).fill(null);
  const below = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (v >= thr) {
      above[i] = v;
      if (i > 0 && values[i - 1] != null && values[i - 1] < thr) below[i] = v;
    } else {
      below[i] = v;
      if (i > 0 && values[i - 1] != null && values[i - 1] >= thr) above[i] = v;
    }
  }
  return { above, below };
}
function polarityPair(name, values, thr, colorAbove, colorBelow, firstExtra = {}) {
  const { above, below } = splitByThreshold(values, thr);
  // 拆分序列含内部 null 断口，禁用降采样——LTTB 会丢弃 null 把断口连成直线
  return [
    lineSeries(name, above, colorAbove, { ...firstExtra, sampling: undefined }),
    lineSeries(name, below, colorBelow, { sampling: undefined }),
  ];
}
/* 双系列拆分后的合并 tooltip：同一时点只显示非空的那条 */
function mergedTooltip(fmtV) {
  const t = baseTooltip();
  t.formatter = (params) => {
    const p = (params || []).find((x) => x.value != null && !Number.isNaN(x.value));
    if (!p) return "";
    return p.axisValue + '<br/>' + p.marker + " " + p.seriesName +
      ' &nbsp;<b style="color:' + C.ink + '">' + fmtV(p.value) + "</b>";
  };
  return t;
}
function markLineAt(vals, fmtLabel) {
  return {
    silent: true, symbol: "none",
    lineStyle: { color: C.muted, type: "dashed", width: 1 },
    label: { color: C.muted, fontSize: 10, formatter: fmtLabel || "{c}" },
    data: vals.map((v) => ({ yAxis: v })),
  };
}

/* 时间窗口按钮（月数；null = 全部） */
const RANGES = [
  { zh: "1月", en: "1M", m: 1 }, { zh: "3月", en: "3M", m: 3 },
  { zh: "6月", en: "6M", m: 6 }, { zh: "1年", en: "1Y", m: 12 },
  { zh: "3年", en: "3Y", m: 36 }, { zh: "5年", en: "5Y", m: 60 },
  { zh: "10年", en: "10Y", m: 120 }, { zh: "全部", en: "All", m: null },
];
function cutoffIndex(dates, months) {
  if (months == null) return 0;
  const last = new Date(dates[dates.length - 1] + "T00:00:00");
  const cut = new Date(last);
  // 先退到月初再减月份，最后夹紧到目标月天数，避免月末日期 setMonth 溢出到下月
  const dayOfMonth = cut.getDate();
  cut.setDate(1);
  cut.setMonth(cut.getMonth() - months);
  cut.setDate(Math.min(dayOfMonth, new Date(cut.getFullYear(), cut.getMonth() + 1, 0).getDate()));
  // 手动格式化本地日期——toISOString 按 UTC 输出，在东半球时区会偏移一天
  const pad = (n) => String(n).padStart(2, "0");
  const iso = cut.getFullYear() + "-" + pad(cut.getMonth() + 1) + "-" + pad(cut.getDate());
  // 二分查找第一个 >= iso 的日期
  let lo = 0, hi = dates.length - 1, ans = dates.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] >= iso) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}
function wireRanges(container, chart, dates, defaultMonths = 36) {
  container.innerHTML = "";
  let programmatic = false;
  const btns = RANGES.map((r) => {
    const b = el("button", "", LANG === "zh" ? r.zh : r.en);
    b.onclick = () => {
      programmatic = true;
      chart.dispatchAction({
        type: "dataZoom",
        startValue: cutoffIndex(dates, r.m),
        endValue: dates.length - 1,
      });
      btns.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      setTimeout(() => { programmatic = false; }, 0);
    };
    container.appendChild(b);
    return b;
  });
  chart.on("datazoom", () => {
    if (!programmatic) btns.forEach((x) => x.classList.remove("active"));
  });
  const def = RANGES.find((r) => r.m === defaultMonths) || RANGES[RANGES.length - 1];
  const idx = btns[RANGES.indexOf(def)];
  idx.click();
}

/* ================= 指标注册表 ================= */
const GROUPS = [
  { id: "g1", zh: "宏观 · 证据较扎实", en: "Macro · Solid evidence" },
  { id: "g2", zh: "宏观 · 参考价值 / 噪音大", en: "Macro · Useful but noisy" },
  { id: "g3", zh: "市场 · 动量（超额收益证据最强）", en: "Markets · Momentum (strongest evidence)" },
  { id: "g4", zh: "市场 · 风控工具", en: "Markets · Risk management" },
  { id: "g5", zh: "情绪与仓位 · 证据弱（仅参考）", en: "Sentiment & positioning · Weak evidence" },
];
const groupName = (g) => (LANG === "zh" ? g.zh : g.en);

const SECTORS = [
  ["xlk", "信息技术", "Info Tech"], ["xlf", "金融", "Financials"],
  ["xlv", "医疗保健", "Health Care"], ["xly", "可选消费", "Cons. Discretionary"],
  ["xlc", "通信服务", "Communication"], ["xli", "工业", "Industrials"],
  ["xlp", "必需消费", "Cons. Staples"], ["xle", "能源", "Energy"],
  ["xlu", "公用事业", "Utilities"], ["xlb", "材料", "Materials"],
  ["xlre", "房地产", "Real Estate"],
];
const ASSETS = [
  ["spy", "标普500 (SPY)", "S&P 500 (SPY)"], ["qqq", "纳指100 (QQQ)", "Nasdaq 100 (QQQ)"],
  ["tlt", "20年+美债 (TLT)", "20Y+ Treasuries (TLT)"], ["gld", "黄金 (GLD)", "Gold (GLD)"],
  ["eem", "新兴市场 (EEM)", "Emerging Mkts (EEM)"],
];
const nameOf = (row) => (LANG === "zh" ? row[1] : row[2]);

function makeIndicators() { return [
  /* ---------- 1. 高收益债 OAS ---------- */
  {
    id: "hy_oas", group: "g1",
    name: L("高收益债信用利差（OAS）", "High-Yield Credit Spread (OAS)"),
    short: L("信用利差", "Credit spread"),
    subtitle: L("ICE BofA 美国高收益指数期权调整利差 · 日频 · FRED: BAMLH0A0HYM2",
      "ICE BofA US High Yield Index option-adjusted spread · daily · FRED: BAMLH0A0HYM2"),
    deps: ["hy_oas"],
    build(S) {
      const { dates, values } = S.hy_oas;
      const last = values[values.length - 1];
      const d63 = idxOffset(values, 63);
      const chg = d63 == null ? null : last - d63;
      const pctl = percentile(values, last);
      const yrs = spanYears(dates);
      let level = "good", label = L("利差偏窄，融资环境平稳", "Spreads tight — funding conditions calm");
      if (last >= 6 || (chg != null && chg >= 1.5)) { level = "risk"; label = L("利差高位或快速走阔", "Spreads elevated or widening fast"); }
      else if (last >= 4.5 || (chg != null && chg >= 0.75)) { level = "warn"; label = L("利差抬升，需要留意", "Spreads rising — worth watching"); }
      return {
        value: fmt.pct(last) + " (" + Math.round(last * 100) + " bp)",
        delta: chg == null ? "" : L("3个月 ", "3-mo ") + fmt.bpS(chg),
        readings: [
          { label: L("当前 OAS", "Current OAS"), value: fmt.pct(last) },
          { label: L("3个月变化", "3-month change"), value: chg == null ? "—" : fmt.bpS(chg) },
          { label: L("近" + yrs.toFixed(0) + "年分位", yrs.toFixed(0) + "-yr percentile"), value: pctl.toFixed(0) + "%" },
          { label: L("数据日期", "As of"), value: dates[dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: values.slice(-252) },
        note: S.hy_oas.note,
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v + "%" }),
            tooltip: baseTooltip((v) => fmt.pct(v)),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: [{
              ...lineSeries(L("高收益 OAS", "High-yield OAS"), values, C.s1),
              areaStyle: { color: C.s1, opacity: 0.08 },
              markLine: markLineAt([4, 6], (p) => p.value + "%"),
            }],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("高收益（垃圾级）公司债相对国债的期权调整利差。信用市场对融资环境恶化的反应往往先于股票市场，是可能最有用的实时风险温度计。",
        "The option-adjusted spread of high-yield (junk) corporate bonds over Treasuries. Credit markets tend to react to deteriorating funding conditions before equities do — arguably the most useful real-time risk thermometer."),
      how: L("看两件事：<b>水平</b>（历史上 4% 以下偏平静，6% 以上多对应压力期，2008、2020 时超过 10%－20%）和<b>变化速度</b>（数周内快速走阔 +100bp 以上通常意味着融资环境在恶化，比绝对水平更值得警惕）。",
        "Watch two things: the <b>level</b> (below 4% is historically calm; above 6% usually marks stress; 2008 and 2020 exceeded 10–20%) and the <b>speed of change</b> (a widening of +100bp within weeks usually means funding conditions are deteriorating — more alarming than the absolute level)."),
      caveat: L("利差窄本身不是做空理由——它可以在低位停留数年。注意：FRED 对 ICE BofA 系列只发布最近 3 年的滚动窗口（ICE 数据授权限制，官方 API 同样受限），因此历史分位基于可得窗口计算；本站每次刷新会自动把旧数据累积进本地缓存，运行越久可回看的历史越长。",
        "Tight spreads alone are not a short signal — they can stay low for years. Note: FRED only distributes a rolling 3-year window of ICE BofA series (an ICE licensing restriction that also applies to the official API), so the percentile uses the available window; this site accumulates older data locally with each refresh."),
    },
    source: L("数据：FRED · ICE BofA US High Yield Index Option-Adjusted Spread（BAMLH0A0HYM2），日频。",
      "Data: FRED · ICE BofA US High Yield Index Option-Adjusted Spread (BAMLH0A0HYM2), daily."),
  },

  /* ---------- 2. 收益率曲线 ---------- */
  {
    id: "t10y3m", group: "g1",
    name: L("收益率曲线（10年 − 3个月）", "Yield Curve (10Y − 3M)"),
    short: L("收益率曲线", "Yield curve"),
    subtitle: L("10 年期与 3 个月期美债收益率之差 · 日频 · FRED: T10Y3M",
      "10-year minus 3-month Treasury yield · daily · FRED: T10Y3M"),
    deps: ["t10y3m"],
    build(S) {
      const { dates, values } = S.t10y3m;
      const last = values[values.length - 1];
      const inverted = last < 0;
      const start = runStartDate(dates, values, inverted ? (v) => v < 0 : (v) => v >= 0);
      const days = start ? daysBetween(start, dates[dates.length - 1]) : null;
      let level = "good", label = L("曲线正常（正斜率）", "Curve normal (positive slope)");
      if (inverted) { level = "risk"; label = L("曲线倒挂", "Curve inverted"); }
      else if (last < 0.5) { level = "warn"; label = L("曲线平坦，接近倒挂", "Curve flat — near inversion"); }
      return {
        value: (last >= 0 ? "+" : "") + last.toFixed(2) + " pp",
        delta: (inverted ? L("倒挂", "Inverted ") : L("正常", "Normal ")) +
          (days != null ? L("已持续 " + days + " 天", "for " + days + " days") : ""),
        readings: [
          { label: L("当前利差", "Current spread"), value: (last >= 0 ? "+" : "") + last.toFixed(2) + " pp" },
          { label: inverted ? L("倒挂开始于", "Inverted since") : L("转正开始于", "Normal since"), value: start || "—", small: true },
          { label: L("数据日期", "As of"), value: dates[dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: values.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v + "pp" }),
            tooltip: mergedTooltip((v) => Number(v).toFixed(2) + " pp"),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair(L("10Y−3M 利差", "10Y−3M spread"), values, 0, C.s1, C.critSoft,
              { markLine: markLineAt([0]) }),
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("Estrella–Mishkin 的经典衰退预测指标：10 年期收益率低于 3 个月期（倒挂）后，历史上多数情况在 12–24 个月内出现衰退。",
        "The classic Estrella–Mishkin recession predictor: after the 10-year yield falls below the 3-month (inversion), a recession has historically followed within 12–24 months in most cases."),
      how: L("倒挂 = 红色区间。注意它是<b>周期位置参考</b>：领先期极长且不稳定，2022–23 年那轮深度倒挂之后衰退迟迟未至。历史上有效的往往是「倒挂后再转正（re-steepening）」阶段更接近实际衰退。",
        "Inversion = red segments. Treat it as a <b>cycle-position reference</b>: the lead time is long and unstable — the deep 2022–23 inversion was followed by no timely recession. Historically the re-steepening phase after an inversion sits closer to actual recessions."),
      caveat: L("作为择时工具基本没用——从倒挂到股市顶部的间隔从几个月到两年以上不等。只用它判断自己在周期的大致位置。",
        "Nearly useless as a timing tool — the gap between inversion and equity-market peaks ranges from months to over two years. Use it only to gauge roughly where you are in the cycle."),
    },
    source: L("数据：FRED · 10-Year Treasury Constant Maturity Minus 3-Month Treasury（T10Y3M），日频，1982 年至今。",
      "Data: FRED · 10-Year Treasury Constant Maturity Minus 3-Month Treasury (T10Y3M), daily, since 1982."),
  },

  /* ---------- 3. 初请失业金 ---------- */
  {
    id: "icsa", group: "g1",
    name: L("初请失业金人数", "Initial Jobless Claims"),
    short: L("初请失业金", "Jobless claims"),
    subtitle: L("每周首次申领失业保险人数 · 周频 · FRED: ICSA",
      "Weekly first-time unemployment insurance claims · FRED: ICSA"),
    freq: "每周更新",
    deps: ["icsa"],
    build(S) {
      const { dates, values } = S.icsa;
      const ma4 = sma(values, 4);
      const last = values[values.length - 1];
      const ma4Last = ma4[ma4.length - 1];
      const win = ma4.slice(-52).filter((v) => v != null);
      const low52 = Math.min(...win);
      const above = (ma4Last / low52 - 1) * 100;
      let level = "good", label = L("初请处于低位区间", "Claims in low territory");
      if (above > 25) { level = "risk"; label = L("初请较年内低点大幅抬升", "Claims sharply above 52-week low"); }
      else if (above > 10) { level = "warn"; label = L("初请较年内低点明显抬升", "Claims notably above 52-week low"); }
      return {
        value: fmt.wan(last),
        delta: L("4周均线 ", "4-wk avg ") + fmt.wan(ma4Last) +
          L(" · 高于52周低点 ", " · above 52-wk low ") + fmt.pctS(above),
        readings: [
          { label: L("最新一周", "Latest week"), value: fmt.wan(last) },
          { label: L("4周移动均线", "4-week moving average"), value: fmt.wan(ma4Last) },
          { label: L("较52周低点", "vs 52-week low"), value: fmt.pctS(above) },
          { label: L("数据日期", "As of"), value: dates[dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: ma4.slice(-104).filter((v) => v != null) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v / 1e4 + "万" }),
            tooltip: baseTooltip((v) => (v == null ? "—" : fmt.wan(v))),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 64, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries(L("周度初请", "Weekly claims"), values, C.muted, { lineStyle: { width: 1.2, color: C.muted, opacity: 0.7 } }),
              lineSeries(L("4周均线", "4-week average"), ma4, C.s1),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("每周首次申领失业保险的人数。高频（周四发布）、修正极少、对经济拐点敏感，是就业市场最快的硬数据。",
        "The number of first-time unemployment insurance filings each week. High-frequency (published Thursdays), rarely revised, and sensitive to economic turning points — the fastest hard data on the labor market."),
      how: L("用 <b>4 周移动均线</b>过滤单周噪音。历史经验：4 周均线较过去 52 周低点抬升超过 15–25% 时，往往对应就业周期转弱；衰退开始前后初请通常已在快速上行。",
        "Use the <b>4-week moving average</b> to filter weekly noise. Historically, a 4-week average rising 15–25% above its 52-week low tends to mark a weakening employment cycle; claims are usually climbing fast around recession onsets."),
      caveat: L("假期、罢工、天气会造成单周大幅扰动（图中疫情初期的尖峰即极端例子）。看均线趋势，不看单周。",
        "Holidays, strikes and weather cause large single-week distortions (the pandemic spike on the chart is the extreme example). Follow the average's trend, not any single week."),
    },
    source: L("数据：FRED · Initial Claims（ICSA），周频（每周四更新），1980 年至今。此处 4 周均线由周度数据计算。",
      "Data: FRED · Initial Claims (ICSA), weekly (updated Thursdays), since 1980. The 4-week average is computed from the weekly data."),
  },

  /* ---------- 4. 市场宽度（代理） ---------- */
  {
    id: "breadth", group: "g2",
    name: L("市场宽度（等权/市值比值代理）", "Market Breadth (Equal/Cap-weight Proxy)"),
    short: L("市场宽度", "Breadth"),
    subtitle: L("RSP（标普等权）÷ SPY（标普市值加权）· 日频 · Nasdaq 行情",
      "RSP (equal-weight S&P) ÷ SPY (cap-weight) · daily · Nasdaq quotes"),
    deps: ["rsp", "spy", "spx"],
    build(S) {
      const al = alignTwo(S.rsp, S.spy);
      const ratio = al.dates.map((_, i) => al.a[i] / al.b[i]);
      const ma200 = sma(ratio, 200);
      const last = ratio[ratio.length - 1];
      const r63 = idxOffset(ratio, 63);
      const chg63 = r63 == null ? null : (last / r63 - 1) * 100;
      const r126 = idxOffset(ratio, 126);
      const chg126 = r126 == null ? null : (last / r126 - 1) * 100;
      // 背离检测：指数近3个月上涨而宽度代理下行
      const spxV = S.spx.values;
      const spxPrev = idxOffset(spxV, 63);
      const spx63 = spxPrev == null ? null : (spxV[spxV.length - 1] / spxPrev - 1) * 100;
      let level = "info", label = L("宽度中性", "Breadth neutral");
      if (spx63 != null && chg63 != null && spx63 > 2 && chg63 < -2) { level = "warn"; label = L("指数上涨但宽度走弱（背离）", "Index up but breadth weakening (divergence)"); }
      else if (chg63 != null && chg63 > 1) { level = "good"; label = L("宽度改善（等权跑赢）", "Breadth improving (equal-weight leading)"); }
      else if (chg63 != null && chg63 < -4) { level = "warn"; label = L("宽度持续走弱", "Breadth deteriorating"); }
      return {
        value: last.toFixed(4),
        delta: L("3个月 ", "3-mo ") + pctOr(chg63) + L(" · 6个月 ", " · 6-mo ") + pctOr(chg126),
        readings: [
          { label: L("RSP/SPY 比值", "RSP/SPY ratio"), value: last.toFixed(4) },
          { label: L("3个月变化", "3-month change"), value: pctOr(chg63) },
          { label: L("同期标普涨跌", "S&P over same span"), value: pctOr(spx63) },
          { label: L("数据日期", "As of"), value: al.dates[al.dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: ratio.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(al.dates, { yFmt: (v) => Number(v).toFixed(3) }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(4))),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 64, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries("RSP / SPY", ratio, C.s1),
              lineSeries(L("200日均线", "200-day MA"), ma200, C.s2, { lineStyle: { width: 1.5, color: C.s2 } }),
            ],
          });
          return { chart: c, dates: al.dates };
        },
      };
    },
    desc: {
      what: L("比值上行 = 等权指数跑赢市值加权 = 上涨由多数成分股驱动（宽度好）；比值下行 = 指数越来越靠少数权重股撑着（宽度差）。重大顶部前常出现「指数创新高、宽度背离」。",
        "Rising ratio = the equal-weight index beating cap-weight = gains driven by most constituents (healthy breadth); falling ratio = the index increasingly propped up by a few mega-caps. Major tops are often preceded by new index highs on diverging breadth."),
      how: L("关注比值的中期趋势（对比 200 日均线）以及与指数的背离：指数近 3 个月上涨而比值明显下行时亮黄灯。",
        "Watch the ratio's medium-term trend (vs its 200-day MA) and divergence against the index: a yellow flag lights when the S&P is up over 3 months while the ratio falls notably."),
      caveat: L("<b>这是代理指标</b>：真实的腾落线（A/D Line）、200 日均线上方个股占比等数据没有免费公开源，此处用 RSP/SPY 近似，只能反映标普 500 内部的集中度。背离经常无疾而终——用户原话：噪音大，仅供参考。RSP 数据始于 2016（本站保留最近 10 年）。",
        "<b>This is a proxy</b>: true breadth data (A/D line, % of stocks above their 200-day MA) has no free public source, so RSP/SPY approximates it and only reflects concentration within the S&P 500. Divergences frequently fizzle — noisy, reference only. RSP data here covers the last 10 years."),
    },
    source: L("数据：Nasdaq 官方行情 API · RSP 与 SPY 未复权收盘价（两者股息率接近，比值受分红影响很小），近 10 年。",
      "Data: official Nasdaq quote API · RSP and SPY unadjusted closes (similar dividend yields, so the ratio is barely affected), last 10 years."),
  },

  /* ---------- 5. VIX 期限结构 ---------- */
  {
    id: "vix_ts", group: "g2",
    name: L("VIX 期限结构（VIX / VIX3M）", "VIX Term Structure (VIX / VIX3M)"),
    short: L("VIX结构", "VIX structure"),
    subtitle: L("1个月隐含波动率 ÷ 3个月隐含波动率 · 日频 · FRED: VIXCLS / VXVCLS",
      "1-month ÷ 3-month implied volatility · daily · FRED: VIXCLS / VXVCLS"),
    deps: ["vix", "vix3m"],
    build(S) {
      const al = alignTwo(S.vix, S.vix3m);
      const ratio = al.dates.map((_, i) => al.a[i] / al.b[i]);
      const last = ratio[ratio.length - 1];
      const vixLast = al.a[al.a.length - 1];
      const vix3mLast = al.b[al.b.length - 1];
      let level = "good", label = L("期限结构正常（近月低于远月）", "Structure normal (front below back)");
      if (last >= 1) { level = "risk"; label = L("倒挂（backwardation）：即期恐慌", "Backwardation: spot panic"); }
      else if (last >= 0.95) { level = "warn"; label = L("接近倒挂，短期避险情绪升温", "Near inversion — short-term hedging demand rising"); }
      return {
        value: last.toFixed(3),
        delta: "VIX " + vixLast.toFixed(1) + " · VIX3M " + vix3mLast.toFixed(1),
        readings: [
          { label: "VIX / VIX3M", value: last.toFixed(3) },
          { label: L("VIX（1个月）", "VIX (1-month)"), value: vixLast.toFixed(2) },
          { label: L("VIX3M（3个月）", "VIX3M (3-month)"), value: vix3mLast.toFixed(2) },
          { label: L("数据日期", "As of"), value: al.dates[al.dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: ratio.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(al.dates, { yFmt: (v) => Number(v).toFixed(2) }),
            tooltip: mergedTooltip((v) => Number(v).toFixed(3)),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair("VIX / VIX3M", ratio, 1, C.critSoft, C.s1,
              { markLine: markLineAt([1]) }),
          });
          return { chart: c, dates: al.dates };
        },
      };
    },
    desc: {
      what: L("正常市况下近月波动率低于远月（比值 < 1，contango）。比值升破 1（backwardation）意味着市场愿意为「现在」的保护付出比「三个月后」更高的价格——即期恐慌。",
        "In normal markets, near-term implied volatility sits below longer-term (ratio < 1, contango). A ratio above 1 (backwardation) means the market pays more for protection now than three months out — spot panic."),
      how: L("≥ 1 为红灯。历史上比值破 1 的日子集中在 2008、2011、2015、2018、2020、2022 等压力时段。",
        "≥ 1 is the red line. Historically, days above 1 cluster in stress episodes: 2008, 2011, 2015, 2018, 2020, 2022."),
      caveat: L("它更多是<b>同步指标</b>而非领先指标：倒挂出现时下跌通常已经发生，价值在于确认市况状态与观察恐慌消退（比值回落）。",
        "It is largely a <b>coincident</b> indicator: by the time inversion appears the selloff has usually happened. Its value lies in confirming the regime and watching panic recede (ratio falling back)."),
    },
    source: L("数据：FRED · CBOE VIX（VIXCLS，1990 至今）与 3 个月波动率指数 VIX3M（VXVCLS，2007-12 至今），取两者共同交易日。",
      "Data: FRED · CBOE VIX (VIXCLS, since 1990) and 3-month volatility index VIX3M (VXVCLS, since Dec 2007), common trading days."),
  },

  /* ---------- 6. NFCI 金融条件 ---------- */
  {
    id: "nfci", group: "g2",
    name: L("金融条件指数（NFCI）", "Financial Conditions (NFCI)"),
    short: L("金融条件", "Fin. conditions"),
    subtitle: L("芝加哥联储全国金融条件指数 · 周频 · FRED: NFCI（替代 ISM/LEI 的免费综合指标）",
      "Chicago Fed National Financial Conditions Index · weekly · FRED: NFCI (free stand-in for ISM/LEI)"),
    freq: "每周更新",
    deps: ["nfci"],
    build(S) {
      const { dates, values } = S.nfci;
      const last = values[values.length - 1];
      const d13 = idxOffset(values, 13);
      const chg = d13 == null ? null : last - d13;
      const chgTxt = chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(3);
      let level = "good", label = L("金融条件宽松", "Financial conditions loose");
      if (last > 0) { level = "risk"; label = L("金融条件紧于历史均值", "Conditions tighter than historical average"); }
      else if (last > -0.3) { level = "warn"; label = L("金融条件偏紧", "Conditions on the tight side"); }
      return {
        value: last.toFixed(3),
        delta: L("13周变化 ", "13-wk change ") + chgTxt,
        readings: [
          { label: L("当前 NFCI", "Current NFCI"), value: last.toFixed(3) },
          { label: L("13周（一季度）变化", "13-week (quarterly) change"), value: chgTxt },
          { label: L("数据日期", "As of"), value: dates[dates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: values.slice(-104) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v }),
            tooltip: mergedTooltip((v) => Number(v).toFixed(3)),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair("NFCI", values, 0, C.critSoft, C.s1,
              { markLine: markLineAt([0]) }),
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("芝加哥联储用 105 个子指标（信用利差、杠杆、风险偏好、货币市场等）合成的金融条件综合指数。0 = 历史平均；正值 = 紧于均值；负值 = 松于均值。",
        "A composite of 105 sub-indicators (credit spreads, leverage, risk appetite, money markets) built by the Chicago Fed. 0 = historical average; positive = tighter than average; negative = looser."),
      how: L("水平破 0 或一个季度内快速上行，通常对应融资环境收紧、风险资产逆风。",
        "A break above 0, or a rapid quarterly rise, usually corresponds to tightening funding conditions and headwinds for risk assets."),
      caveat: L("<b>为什么是它</b>：你清单里的 ISM 新订单和 Conference Board LEI 都是付费专有数据，没有可靠的免费公开源；NFCI 是覆盖面最广的免费周频替代。与 ISM/LEI 一样归入「噪音大」一档——近几年这类综合指数假信号不少。",
        "<b>Why this series</b>: ISM New Orders and the Conference Board LEI are proprietary paid data with no reliable free source; NFCI is the broadest free weekly substitute. Like ISM/LEI it belongs in the noisy tier — composite indices of this kind have produced plenty of false signals in recent years."),
    },
    source: L("数据：FRED · Chicago Fed National Financial Conditions Index（NFCI），周频（每周三更新），1985 年至今。",
      "Data: FRED · Chicago Fed National Financial Conditions Index (NFCI), weekly (updated Wednesdays), since 1985."),
  },

  /* ---------- 7. 时间序列动量 ---------- */
  {
    id: "tsmom", group: "g3",
    name: L("时间序列动量（趋势跟踪）", "Time-Series Momentum (Trend Following)"),
    short: L("时序动量", "TS momentum"),
    subtitle: L("价格相对自身 12 个月前的位置 · 标普500（1975 至今）+ 多资产",
      "Price vs its own level 12 months ago · S&P 500 (since 1975) + multi-asset"),
    deps: ["spx", "spy", "qqq", "tlt", "gld", "eem"],
    build(S) {
      const { dates, values } = S.spx;
      const mom = values.map((v, i) => (i >= 252 ? (v / values[i - 252] - 1) * 100 : null));
      const momDates = dates.slice(252);
      const momVals = mom.slice(252);
      const last = momVals[momVals.length - 1];
      const positive = last > 0;
      const flip = runStartDate(momDates, momVals, positive ? (v) => v > 0 : (v) => v <= 0);
      const assets = ASSETS.map((row) => {
        const v = S[row[0]].values;
        const m = v.length > 252 ? (v[v.length - 1] / v[v.length - 253] - 1) * 100 : null;
        return { name: nameOf(row), mom: m };
      });
      return {
        value: fmt.pctS(last),
        delta: L("标普500 · 12个月动量" + (positive ? "为正" : "为负"),
          "S&P 500 12-month momentum " + (positive ? "positive" : "negative")),
        readings: [
          { label: L("标普500 · 12个月动量", "S&P 500 · 12-month momentum"), value: fmt.pctS(last) },
          { label: L("当前状态", "Current state"), value: positive
            ? L("高于12个月前（文献中的持有区）", "Above its 12-month-ago level (the literature's hold zone)")
            : L("低于12个月前（文献中的离场区）", "Below its 12-month-ago level (the literature's exit zone)"), small: true },
          { label: L("本状态开始于", "State began"), value: flip || "—", small: true },
        ],
        signal: positive
          ? { level: "good", label: L("趋势向上（12个月动量为正）", "Uptrend (12-month momentum positive)") }
          : { level: "risk", label: L("趋势向下（12个月动量为负）", "Downtrend (12-month momentum negative)") },
        spark: { values: momVals.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(momDates, { yFmt: (v) => v + "%" }),
            tooltip: mergedTooltip((v) => fmt.pctS(v)),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair(L("标普500 · 12个月动量", "S&P 500 12-mo momentum"), momVals, 0, C.s1, C.critSoft,
              { markLine: markLineAt([0], (p) => p.value + "%") }),
          });
          return { chart: c, dates: momDates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title",
            L("多资产 12 个月动量（未复权价格）", "Multi-asset 12-month momentum (unadjusted prices)")));
          const t = el("table", "aux-table",
            `<tr><th>${L("资产", "Asset")}</th><th>${L("12个月动量", "12-mo momentum")}</th><th>${L("状态", "State")}</th></tr>` +
            assets.map((a) => {
              if (a.mom == null) return `<tr><td>${a.name}</td><td class="num">—</td><td>—</td></tr>`;
              const pos = a.mom > 0;
              return `<tr><td>${a.name}</td><td class="num">${fmt.pctS(a.mom)}</td>` +
                `<td><span class="badge ${pos ? "good" : "risk"}"><span class="ico">${pos ? "●" : "■"}</span>${pos ? L("动量为正", "Positive") : L("动量为负", "Negative")}</span></td></tr>`;
            }).join(""));
          node.appendChild(t);
        },
      };
    },
    desc: {
      what: L("资产价格高于自己 12 个月前 → 文献规则为持有；低于 → 离场。Moskowitz–Ooi–Pedersen (2012) 与《A Century of Evidence on Trend-Following》用 1880 年以来几十个市场验证过，整个 CTA 行业建立在此之上。",
        "Price above its own level 12 months ago → the literature's rule says hold; below → exit. Validated by Moskowitz–Ooi–Pedersen (2012) and \"A Century of Evidence on Trend-Following\" across dozens of markets since 1880; the entire CTA industry is built on it."),
      how: L("主图为标普 500 的 12 个月滚动动量（此处以 252 个交易日近似 12 个月），零轴上下即信号切换。下表为多资产当前状态。",
        "The main chart shows the S&P 500's rolling 12-month momentum (approximated by 252 trading days); crossing the zero line flips the signal. The table below shows the current state across assets."),
      caveat: L("趋势跟踪的代价是震荡市反复止损、拐点处滞后。ETF 数据为未复权价格：TLT 这类高派息资产的动量被低估约一个股息率（当前约 4%/年），信号在零轴附近时尤其要注意。",
        "The cost of trend following: repeated whipsaws in choppy markets and lag at turning points. ETF data is unadjusted — momentum of high-payout assets like TLT is understated by roughly one dividend yield (~4%/yr currently); be careful when the signal hovers near zero."),
    },
    source: L("数据：Cboe · SPX 指数日线（1975 至今）；Nasdaq 行情 API · 各 ETF 未复权收盘价（近 10 年）。",
      "Data: Cboe · SPX daily (since 1975); Nasdaq quote API · unadjusted ETF closes (last 10 years)."),
  },

  /* ---------- 8. 横截面动量 ---------- */
  {
    id: "xsmom", group: "g3",
    name: L("横截面动量（强者恒强）", "Cross-Sectional Momentum"),
    short: L("截面动量", "XS momentum"),
    subtitle: L("行业 12-1 动量排名 + 动量因子（MTUM）相对大盘强度",
      "Sector 12-1 momentum ranking + momentum factor (MTUM) vs the market"),
    deps: ["mtum", "spy", ...SECTORS.map(([k]) => k)],
    build(S) {
      const al = alignTwo(S.mtum, S.spy);
      const base = al.a[0] / al.b[0];
      const rel = al.dates.map((_, i) => (al.a[i] / al.b[i]) / base * 100);
      const last = rel[rel.length - 1];
      const r252 = idxOffset(rel, 252);
      const chg = r252 == null ? null : (last / r252 - 1) * 100;
      const ranks = SECTORS.map((row) => {
        const v = S[row[0]].values;
        const n = v.length;
        const m = n > 252 ? (v[n - 1 - 21] / v[n - 1 - 252] - 1) * 100 : null;
        return { name: nameOf(row), mom: m };
      }).filter((r) => r.mom != null).sort((a, b) => b.mom - a.mom);
      const sep = L("、", ", ");
      const top3 = ranks.slice(0, 3).map((r) => r.name).join(sep);
      const bot3 = ranks.slice(-3).map((r) => r.name).join(sep);
      return {
        value: ranks.length ? ranks[0].name : "—",
        delta: L("领涨行业（12-1 动量）", "Leading sector (12-1 momentum)"),
        readings: [
          { label: L("领涨行业（前3）", "Top 3 sectors"), value: top3, small: true },
          { label: L("垫底行业（后3）", "Bottom 3 sectors"), value: bot3, small: true },
          { label: L("MTUM/SPY 12个月变化", "MTUM/SPY 12-month change"), value: pctOr(chg) },
        ],
        signal: { level: "info", label: L("信息性指标：观察轮动结构", "Informational: watch the rotation") },
        spark: { values: rel.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(al.dates, { yFmt: (v) => v }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1))),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: [lineSeries(L("MTUM / SPY 相对强度（期初=100）", "MTUM / SPY relative strength (start=100)"), rel, C.s1)],
          });
          return { chart: c, dates: al.dates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title",
            L("标普行业 ETF · 12-1 动量排名（过去12个月剔除最近1个月）",
              "S&P sector ETFs · 12-1 momentum ranking (past 12 months excluding the latest)")));
          const box = el("div", "aux-chart");
          box.style.height = Math.max(300, ranks.length * 34 + 70) + "px";
          node.appendChild(box);
          const c = echarts.init(box);
          const rev = [...ranks].reverse();
          c.setOption({
            tooltip: { ...baseTooltip((v) => fmt.pctS(v)), trigger: "item" },
            grid: { left: 90, right: 70, top: 16, bottom: 28 },
            xAxis: {
              type: "value",
              axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v + "%" },
              splitLine: { lineStyle: { color: C.grid } },
            },
            yAxis: {
              type: "category", data: rev.map((r) => r.name),
              axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
              axisLabel: { color: C.ink2, fontSize: 12 },
            },
            series: [{
              type: "bar", barWidth: 18,
              data: rev.map((r) => ({
                value: Number(r.mom.toFixed(1)),
                itemStyle: {
                  color: r.mom >= 0 ? C.s1 : C.critSoft,
                  borderRadius: r.mom >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4],
                },
                label: { position: r.mom >= 0 ? "right" : "left" },
              })),
              label: {
                show: true, color: C.ink2, fontSize: 11,
                formatter: (p) => fmt.pctS(p.value),
              },
            }],
          });
          liveCharts.push(c);
        },
      };
    },
    desc: {
      what: L("过去 3–12 个月的强势资产继续跑赢弱势资产。Jegadeesh & Titman (1993) 首次系统证明；Geczy & Samonov 把美股样本推到 1801 年依然成立；Asness 等《Value and Momentum Everywhere》验证其存在于全球股、债、商品、外汇。Fama 本人称动量为「最主要的异象」。",
        "Assets that led over the past 3–12 months keep beating the laggards. First documented systematically by Jegadeesh & Titman (1993); Geczy & Samonov extended the US sample back to 1801 and it still held; Asness et al.'s \"Value and Momentum Everywhere\" found it across global stocks, bonds, commodities and FX. Fama himself called momentum \"the premier anomaly\"."),
      how: L("上图：MTUM（动量因子 ETF）相对 SPY 的强度曲线，反映「买强势股」这件事本身近期是否有效。下图：行业 ETF 的 12-1 动量排名（业界标准口径：过去 12 个月收益、剔除最近 1 个月以避开短期反转）。",
        "Top chart: MTUM (momentum-factor ETF) relative to SPY — whether buying strength has itself been working lately. Bottom: sector ETF 12-1 momentum ranking (the standard definition: trailing 12-month return excluding the most recent month, to sidestep short-term reversal)."),
      caveat: L("动量有「崩溃」风险（如 2009 年3月反转时多空动量组合大幅回撤）。行业排名受股息率差异影响约 1–3 个百分点（未复权价格，公用事业等高息行业被低估）。MTUM 自 2013 年才成立，是因子的近似而非学术组合。",
        "Momentum is prone to crashes (the March 2009 reversal savaged long-short momentum books). Sector rankings are skewed 1–3pp by dividend-yield differences (unadjusted prices understate high-yield sectors like utilities). MTUM only launched in 2013 and is an approximation of the factor, not the academic portfolio."),
    },
    source: L("数据：Nasdaq 行情 API · MTUM、SPY 与 11 只 SPDR 行业 ETF（XLK/XLF/XLV/XLY/XLC/XLI/XLP/XLE/XLU/XLB/XLRE）未复权收盘价，近 10 年。",
      "Data: Nasdaq quote API · MTUM, SPY and 11 SPDR sector ETFs (XLK/XLF/XLV/XLY/XLC/XLI/XLP/XLE/XLU/XLB/XLRE), unadjusted closes, last 10 years."),
  },

  /* ---------- 9. 200 日均线 ---------- */
  {
    id: "ma200", group: "g4",
    name: L("200 日均线（趋势过滤器）", "200-Day Moving Average"),
    short: L("200日线", "200-day MA"),
    subtitle: L("标普500 与其 200 日移动均线 · Cboe SPX（1975 至今）",
      "S&P 500 vs its 200-day moving average · Cboe SPX (since 1975)"),
    deps: ["spx"],
    build(S) {
      const { dates, values } = S.spx;
      const ma = sma(values, 200);
      const last = values[values.length - 1];
      const maLast = ma[ma.length - 1];
      const dev = (last / maLast - 1) * 100;
      const above = last >= maLast;
      const state = dates.map((_, i) => (ma[i] == null ? null : values[i] >= ma[i] ? 1 : 0));
      const flip = runStartDate(dates, state, (v) => v === (above ? 1 : 0));
      let level = above ? "good" : "risk";
      let label = above ? L("价格在 200 日线上方", "Price above the 200-day MA")
        : L("价格在 200 日线下方", "Price below the 200-day MA");
      if (Math.abs(dev) < 1) { level = "warn"; label = L("紧贴 200 日线（易反复）", "Hugging the 200-day MA (whipsaw-prone)"); }
      return {
        value: fmt.num(last, 0),
        delta: L("距200日线 ", "vs 200-day MA ") + fmt.pctS(dev),
        readings: [
          { label: L("标普500", "S&P 500"), value: fmt.num(last, 0) },
          { label: L("200日均线", "200-day MA"), value: fmt.num(maLast, 0) },
          { label: L("偏离度", "Deviation"), value: fmt.pctS(dev) },
          { label: L("当前状态开始于", "State began"), value: flip || "—", small: true },
        ],
        signal: { level, label },
        spark: { values: values.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => fmt.num(v, 0) }),
            tooltip: baseTooltip((v) => (v == null ? "—" : fmt.num(v, 0))),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 70, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries(L("标普500", "S&P 500"), values, C.s1),
              lineSeries(L("200日均线", "200-day MA"), ma, C.s2, { lineStyle: { width: 1.5, color: C.s2 } }),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("Faber 那套 10 月均线择时的日线版本，本质是趋势跟踪的粗糙形态：长期收益与买入持有相近，但历史最大回撤大约砍半（躲过了 1974、2008 的大部分跌幅）。",
        "The daily version of Faber's 10-month moving-average timing rule — a crude form of trend following: long-run returns similar to buy-and-hold, but historical max drawdown roughly halved (it dodged most of 1974 and 2008)."),
      how: L("收盘价在 200 日线上方 = 趋势多头；下方 = 趋势空头。偏离度小于 ±1% 时信号极易反复。",
        "Close above the 200-day MA = trend up; below = trend down. Within ±1% of the line the signal whipsaws easily."),
      caveat: L("定位是<b>风控不是超额收益</b>：震荡市会反复被打脸（如 2011、2015–16），应税账户还有换手税务摩擦。",
        "Its role is <b>risk management, not excess return</b>: choppy markets punish it repeatedly (2011, 2015–16), and taxable accounts face turnover friction."),
    },
    source: L("数据：Cboe · SPX 指数日收盘（1975 至今），价格指数（不含股息）。",
      "Data: Cboe · SPX daily closes (since 1975), price index (excludes dividends)."),
  },

  /* ---------- 10. 波动率管理 ---------- */
  {
    id: "volmgmt", group: "g4",
    name: L("波动率管理（vol targeting）", "Volatility Management (Vol Targeting)"),
    short: L("波动率", "Volatility"),
    subtitle: L("标普500 · 20日实现波动率（年化）与目标波动率仓位系数",
      "S&P 500 · 20-day realized volatility (annualized) and vol-target position weight"),
    deps: ["spx"],
    build(S) {
      const { dates, values } = S.spx;
      const vol = realizedVol(values, 20);
      const start = 20;
      const vDates = dates.slice(start);
      const vVals = vol.slice(start);
      const weight = vVals.map((v) => (v == null ? null : Math.min(1, 15 / v)));
      const last = vVals[vVals.length - 1];
      const clean = vVals.filter((v) => v != null);
      const med = [...clean].sort((a, b) => a - b)[Math.floor(clean.length / 2)];
      const w = Math.min(1, 15 / last);
      let level = "good", label = L("低波动状态", "Low-volatility regime");
      if (last > 25) { level = "risk"; label = L("高波动状态", "High-volatility regime"); }
      else if (last > 15) { level = "warn"; label = L("中等波动状态", "Medium-volatility regime"); }
      return {
        value: fmt.pct(last, 1),
        delta: L("长期中位数 ", "Long-run median ") + fmt.pct(med, 1) +
          L(" · 示例仓位系数 ", " · example weight ") + (w * 100).toFixed(0) + "%",
        readings: [
          { label: L("20日实现波动率（年化）", "20-day realized vol (annualized)"), value: fmt.pct(last, 1) },
          { label: L("1975年以来中位数", "Median since 1975"), value: fmt.pct(med, 1) },
          { label: L("仓位系数（目标15%示例）", "Weight (15% target example)"), value: (w * 100).toFixed(0) + "%" },
        ],
        signal: { level, label },
        spark: { values: vVals.slice(-252) },
        tallChart: true,
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            title: [
              { text: L("20日实现波动率（年化，%）", "20-day realized volatility (annualized, %)"), top: 8, left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
              { text: L("目标波动率仓位系数 = min(1, 15% ÷ 波动率) · 公式演示", "Vol-target weight = min(1, 15% ÷ vol) · formula illustration"), top: "56%", left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
            ],
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1))),
            axisPointer: { link: [{ xAxisIndex: "all" }] },
            grid: [
              { left: 70, right: 20, top: 36, height: "38%" },
              { left: 70, right: 20, top: "63%", height: "20%" },
            ],
            xAxis: [
              { type: "category", boundaryGap: false, data: vDates, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
              { type: "category", boundaryGap: false, data: vDates, gridIndex: 1, axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v.slice(0, 7) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
            ],
            yAxis: [
              { type: "value", scale: true, gridIndex: 0, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v + "%" } },
              { type: "value", min: 0, max: 1, gridIndex: 1, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => (v * 100).toFixed(0) + "%" } },
            ],
            dataZoom: [
              { type: "inside", xAxisIndex: [0, 1], filterMode: "filter", zoomOnMouseWheel: "ctrl", moveOnMouseMove: true },
              { ...baseZoom([0, 1])[1] },
            ],
            series: [
              { ...lineSeries(L("实现波动率", "Realized vol"), vVals, C.s2), xAxisIndex: 0, yAxisIndex: 0, markLine: markLineAt([15, 25], (p) => p.value + "%") },
              { ...lineSeries(L("仓位系数", "Weight"), weight, C.s3), xAxisIndex: 1, yAxisIndex: 1, areaStyle: { color: C.s3, opacity: 0.08 } },
            ],
          });
          return { chart: c, dates: vDates };
        },
      };
    },
    desc: {
      what: L("Moreira & Muir (2017)：按波动率倒数调整仓位（波动率高 → 减仓，低 → 加仓），历史上能改善夏普比率。原理是波动率有聚集性（高波动跟随高波动），而高波动期的单位风险回报更差。",
        "Moreira & Muir (2017): scaling exposure inversely to volatility (cut when vol is high, add when low) has historically improved Sharpe ratios. It works because volatility clusters — high vol follows high vol — while return per unit of risk is worse in high-vol regimes."),
      how: L("上图为 20 日实现波动率（年化）；下图为以 15% 目标波动率为例的仓位系数 min(1, 15%÷σ)。目标值 15% 只是常见示例，非推荐参数。",
        "Top: 20-day realized volatility (annualized). Bottom: the weight min(1, 15%÷σ) using a 15% vol target as an example — a common illustration, not a recommended parameter."),
      caveat: L("改善的是<b>夏普，不是收益</b>——它是风控工具。快速崩盘时（如 2020-02）波动率信号天然滞后几天；频繁调仓有交易与税务成本。",
        "It improves <b>Sharpe, not returns</b> — a risk tool. In fast crashes (Feb 2020) the vol signal inherently lags by days; frequent rebalancing carries trading and tax costs."),
    },
    source: L("数据：Cboe · SPX 指数日收盘（1975 至今）；实现波动率为过去 20 个交易日对数收益标准差年化。",
      "Data: Cboe · SPX daily closes (since 1975); realized vol = annualized stdev of 20-day log returns."),
  },

  /* ---------- 11. 52 周新高 ---------- */
  {
    id: "high52", group: "g4",
    name: L("52 周新高距离", "Distance from 52-Week High"),
    short: L("52周新高", "52-wk high"),
    subtitle: L("标普500 距离滚动 52 周最高收盘的百分比 + 多资产状态",
      "S&P 500 % below its rolling 52-week closing high + multi-asset status"),
    deps: ["spx", "spy", "qqq", "tlt", "gld", "eem"],
    build(S) {
      const { dates, values } = S.spx;
      const hi = rollingMax(values, 252);
      const dist = values.map((v, i) => (hi[i] == null ? null : (v / hi[i] - 1) * 100));
      const dDates = dates.slice(252);
      const dVals = dist.slice(252);
      const last = dVals[dVals.length - 1];
      // 上一次触及新高（距离≥-0.01%）的日期
      let lastHighIdx = -1;
      for (let i = dVals.length - 1; i >= 0; i--) if (dVals[i] >= -0.01) { lastHighIdx = i; break; }
      const sinceHigh = lastHighIdx >= 0 ? daysBetween(dDates[lastHighIdx], dDates[dDates.length - 1]) : null;
      const assets = ASSETS.map((row) => {
        const v = S[row[0]].values;
        if (v.length < 252) return { name: nameOf(row), d: null };
        const mx = Math.max(...v.slice(-252));
        return { name: nameOf(row), d: (v[v.length - 1] / mx - 1) * 100 };
      });
      let level = "info", label = L("距新高中性区间", "Neutral distance from high");
      if (last >= -3) { level = "good"; label = L("接近 52 周新高（动量强）", "Near the 52-week high (strong momentum)"); }
      else if (last <= -20) { level = "risk"; label = L("深度回撤（熊市区域）", "Deep drawdown (bear territory)"); }
      else if (last <= -12) { level = "warn"; label = L("回撤加深", "Drawdown deepening"); }
      return {
        value: fmt.pctS(last),
        delta: sinceHigh != null ? L("距上次新高 " + sinceHigh + " 天", sinceHigh + " days since last high") : "",
        readings: [
          { label: L("距52周最高收盘", "vs 52-week closing high"), value: fmt.pctS(last) },
          { label: L("上次触及新高", "Last touched a high"), value: lastHighIdx >= 0 ? dDates[lastHighIdx] : "—", small: true },
          { label: L("数据日期", "As of"), value: dDates[dDates.length - 1], small: true },
        ],
        signal: { level, label },
        spark: { values: dVals.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dDates, { yFmt: (v) => v + "%", yAxis: { max: 0.5 } }),
            tooltip: baseTooltip((v) => (v == null ? "—" : fmt.pctS(v))),
            grid: { left: 64, right: 30, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: [{
              ...lineSeries(L("距52周高点", "vs 52-wk high"), dVals, C.s1),
              areaStyle: { color: C.s1, opacity: 0.08 },
              markLine: markLineAt([-10, -20], (p) => p.value + "%"),
            }],
          });
          return { chart: c, dates: dDates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title", L("多资产距 52 周高点", "Multi-asset distance from 52-week highs")));
          const t = el("table", "aux-table",
            `<tr><th>${L("资产", "Asset")}</th><th>${L("距52周高点", "vs 52-wk high")}</th><th>${L("状态", "State")}</th></tr>` +
            assets.map((a) => {
              if (a.d == null) return `<tr><td>${a.name}</td><td class="num">—</td><td>—</td></tr>`;
              const lv = a.d >= -3 ? "good" : a.d <= -20 ? "risk" : a.d <= -12 ? "warn" : "info";
              const tx = a.d >= -3 ? L("接近新高", "Near high") : a.d <= -20 ? L("深度回撤", "Deep drawdown")
                : a.d <= -12 ? L("回撤加深", "Deepening") : L("中性", "Neutral");
              return `<tr><td>${a.name}</td><td class="num">${fmt.pctS(a.d)}</td>` +
                `<td><span class="badge ${lv}"><span class="ico">${LEVEL[lv].ico}</span>${tx}</span></td></tr>`;
            }).join(""));
          node.appendChild(t);
        },
      };
    },
    desc: {
      what: L("George & Hwang (2004)：接近 52 周高点的股票后续表现更好，机制被归因于锚定心理——投资者不愿在「高位」追买，导致好消息被低估、价格调整变慢。",
        "George & Hwang (2004): stocks near their 52-week highs go on to perform better, attributed to anchoring — investors hesitate to chase \"expensive\" prices, so good news gets underpriced and adjustment is slow."),
      how: L("距高点 -3% 以内 = 动量强；跌破 -20% 是传统的熊市定义。此指标与时间序列动量高度相关，作为辅助确认使用。",
        "Within -3% of the high = strong momentum; below -20% is the traditional bear-market definition. Highly correlated with time-series momentum — use as secondary confirmation."),
      caveat: L("用户原话：「勉强算半个」——把它当作动量证据链里权重最低的一环，不要单独据此行动。",
        "In the owner's words: \"barely counts as half an indicator\" — treat it as the lowest-weight link in the momentum evidence chain, never act on it alone."),
    },
    source: L("数据：Cboe · SPX（1975 至今）；多资产为 Nasdaq 行情 API 的 ETF 未复权收盘价（近 10 年）。",
      "Data: Cboe · SPX (since 1975); multi-asset rows use Nasdaq API unadjusted ETF closes (last 10 years)."),
  },

  /* ---------- 12. AAII 散户情绪调查 ---------- */
  {
    id: "aaii", group: "g5",
    name: L("AAII 散户情绪调查", "AAII Investor Sentiment Survey"),
    short: L("AAII情绪", "AAII sentiment"),
    subtitle: L("美国个人投资者协会周度调查：未来六个月看多/中性/看空占比 · 1987 至今",
      "Weekly AAII survey: bullish / neutral / bearish on stocks over the next six months · since 1987"),
    freq: "每周更新",
    deps: ["aaii"],
    build(S) {
      const { dates, values: bull } = S.aaii;
      const neutral = S.aaii.neutral, bear = S.aaii.bearish;
      const n = dates.length;
      const spread = bull.map((b, i) => b - bear[i]);
      const last = { b: bull[n - 1], n: neutral[n - 1], br: bear[n - 1], s: spread[n - 1] };
      const pctl = percentile(spread, last.s);
      let label = L("情绪处于中性区间", "Sentiment in neutral range");
      if (last.s >= 20) label = L("极端乐观（反向读法偏谨慎，证据弱）", "Extreme optimism (contrarian caution — weak evidence)");
      else if (last.s <= -20) label = L("极端悲观（反向读法偏积极，证据弱）", "Extreme pessimism (contrarian positive — weak evidence)");
      return {
        value: (last.s >= 0 ? "+" : "") + last.s.toFixed(1) + " pp",
        delta: L("多空差 · 看多 ", "Bull−bear · bulls ") + last.b.toFixed(1) +
          L("% / 看空 ", "% / bears ") + last.br.toFixed(1) + "%",
        readings: [
          { label: L("看多", "Bullish"), value: fmt.pct(last.b, 1) },
          { label: L("中性", "Neutral"), value: fmt.pct(last.n, 1) },
          { label: L("看空", "Bearish"), value: fmt.pct(last.br, 1) },
          { label: L("多空差（历史分位）", "Bull−bear spread (percentile)"), value: (last.s >= 0 ? "+" : "") + last.s.toFixed(1) + " pp（" + pctl.toFixed(0) + "%）" },
        ],
        signal: { level: "info", label },
        spark: { values: spread.slice(-104) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v + "%" }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1) + "%")),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 64, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries(L("看多", "Bullish"), bull, C.good),
              lineSeries(L("中性", "Neutral"), neutral, C.muted),
              lineSeries(L("看空", "Bearish"), bear, C.critSoft),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("美国个人投资者协会（AAII）自 1987 年起每周询问会员：未来六个月股市看多、中性还是看空。是历史最长的散户情绪连续序列，每周四更新。",
        "Since 1987 the American Association of Individual Investors has asked members weekly whether they are bullish, neutral or bearish on stocks over the next six months — the longest continuous retail-sentiment series, updated Thursdays."),
      how: L("常见用法是<b>反向读法且只看极端</b>：多空差（看多% − 看空%）低于 −20pp 的极端悲观历史上多次出现在阶段性底部附近（2009-03-05 看空 70.3% 为历史纪录，恰在市场大底当周）；高于 +20pp 的极端乐观则提示后续回报中位数偏低。中间地带没有信息量。",
        "The common usage is <b>contrarian, extremes only</b>: a bull−bear spread below −20pp has repeatedly appeared near interim bottoms (the record 70.3% bearish on 2009-03-05 fell in the very week of the market low); above +20pp, subsequent median returns skew lower. The middle carries no information."),
      caveat: L("你自己的定位是对的：<b>散户情绪调查的反向指标用法，证据都很弱</b>——所以本指标归入单独分组、信号始终为灰色（信息性），不参与红绿灯。样本仅为 AAII 会员（偏年长、高净值美国散户），不能代表全体散户；周度噪音极大，请只看极端与趋势。",
        "The owner's original framing stands: <b>evidence for contrarian use of retail surveys is weak</b> — hence this indicator sits in its own group with a permanently grey (informational) badge. The sample is AAII members only (older, wealthier US retail), weekly noise is enormous; look only at extremes and trends."),
    },
    source: L("数据：AAII Investor Sentiment Survey 官方历史文件（sentiment.xls），周频（每周四更新），1987-07 至今。",
      "Data: official AAII Investor Sentiment Survey history file (sentiment.xls), weekly (updated Thursdays), since Jul 1987."),
  },

  /* ---------- 13. CFTC 期货持仓 ---------- */
  {
    id: "cot", group: "g5",
    name: L("标普期货投机者净头寸（COT）", "S&P Futures Speculator Positioning (COT)"),
    short: L("期货持仓", "COT positioning"),
    subtitle: L("CFTC 持仓报告 · E-mini 标普500 非商业净头寸 ÷ 未平仓量 · 1997 至今",
      "CFTC Commitments of Traders · E-mini S&P 500 non-commercial net position ÷ open interest · since 1997"),
    freq: "每周更新",
    deps: ["cot"],
    build(S) {
      const { dates, values } = S.cot;
      const last = values[values.length - 1];
      const pctl = percentile(values, last);
      const d13 = idxOffset(values, 13);
      const chg = d13 == null ? null : last - d13;
      let label = L((last >= 0 ? "投机者净多" : "投机者净空") + "，处于中性区间",
        (last >= 0 ? "Specs net long" : "Specs net short") + ", neutral range");
      if (pctl >= 90) label = L("投机净多处于历史高位（仅参考）", "Spec net long at historic highs (reference only)");
      else if (pctl <= 10) label = L("投机净空处于历史高位（仅参考）", "Spec net short at historic highs (reference only)");
      return {
        value: (last >= 0 ? "+" : "") + last.toFixed(2) + "% OI",
        delta: L("历史分位 ", "Percentile ") + pctl.toFixed(0) + L("% · 13周 ", "% · 13-wk ") +
          (chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "pp"),
        readings: [
          { label: L("净头寸（占未平仓量）", "Net position (% of OI)"), value: (last >= 0 ? "+" : "") + last.toFixed(2) + "%" },
          { label: L("1997年以来分位", "Percentile since 1997"), value: pctl.toFixed(0) + "%" },
          { label: L("13周（一季度）变化", "13-week (quarterly) change"), value: chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + " pp" },
        ],
        signal: { level: "info", label },
        spark: { values: values.slice(-104) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v + "%" }),
            tooltip: mergedTooltip((v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "%"),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair(L("投机者净头寸 %OI", "Spec net position %OI"), values, 0, C.s1, C.critSoft,
              { markLine: markLineAt([0]) }),
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("CFTC 每周五发布的持仓报告（COT），追踪投机性资金（非商业头寸）在 E-mini 标普 500 期货的净多空方向。它是少有的「看真实仓位、不问观点」的情绪代理。",
        "The CFTC's weekly Commitments of Traders report tracks speculative money (non-commercial positions) in E-mini S&P 500 futures. One of the few sentiment proxies that measures actual positions rather than stated opinions."),
      how: L("反向读法只看极端分位：净多拥挤（>90% 分位）提示多头出清风险，净空极端时空头回补可能助推反弹。绝对占比通常只有个位数百分点，方向与变化比水平更有意义。",
        "Contrarian at extremes only: crowded net longs (>90th percentile) flag liquidation risk, while extreme net shorts can fuel short-covering rallies. The absolute share is usually single-digit percent — direction and change matter more than level."),
      caveat: L("股指期货上的证据明显弱于商品/外汇——指数期货持仓被对冲需求与基差交易（basis trade）严重污染，近年投机净空常年偏大并非看空股市。数据每周二统计、周五发布，有三天滞后。",
        "Evidence in equity index futures is clearly weaker than in commodities/FX — index positioning is heavily polluted by hedging and basis trades; the persistent net short of recent years is not a bearish equity view. Positions are as of Tuesday, published Friday (3-day lag)."),
    },
    source: L("数据：CFTC Commitments of Traders（Legacy Futures Only）官方公开 API · E-mini S&P 500（代码 13874A），周频，1997 至今。",
      "Data: CFTC Commitments of Traders (Legacy Futures Only) public API · E-mini S&P 500 (code 13874A), weekly, since 1997."),
  },

  /* ---------- 14. 密歇根消费者信心 ---------- */
  {
    id: "umcsent", group: "g5",
    name: L("密歇根大学消费者信心指数", "U. Michigan Consumer Sentiment"),
    short: L("消费信心", "Consumer sent."),
    subtitle: L("University of Michigan Consumer Sentiment · 月频 · FRED: UMCSENT · 1952 至今",
      "University of Michigan Consumer Sentiment · monthly · FRED: UMCSENT · since 1952"),
    freq: "每月更新",
    deps: ["umcsent"],
    build(S) {
      const { dates, values } = S.umcsent;
      const last = values[values.length - 1];
      const pctl = percentile(values, last);
      const d12 = idxOffset(values, 12);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      let label = L("信心处于中性区间", "Sentiment in neutral range");
      if (pctl <= 15) label = L("信心极度低迷（历史上远期回报偏高的区域，弱证据）", "Deeply depressed (historically higher forward returns — weak evidence)");
      else if (pctl >= 85) label = L("信心高涨（历史上远期回报偏低的区域，弱证据）", "Elevated confidence (historically lower forward returns — weak evidence)");
      return {
        value: last.toFixed(1),
        delta: L("历史分位 ", "Percentile ") + pctl.toFixed(0) + L("% · 12个月前 ", "% · a year ago ") + (d12 == null ? "—" : d12.toFixed(1)),
        readings: [
          { label: L("当前指数", "Current index"), value: last.toFixed(1) },
          { label: L("1952年以来分位", "Percentile since 1952"), value: pctl.toFixed(0) + "%" },
          { label: L("长期均值", "Long-run mean"), value: mean.toFixed(1) },
        ],
        signal: { level: "info", label },
        spark: { values: values.slice(-60) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v }),
            tooltip: baseTooltip((v) => Number(v).toFixed(1)),
            grid: { left: 64, right: 30, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: [{
              ...lineSeries(L("消费者信心指数", "Consumer sentiment"), values, C.s1),
              areaStyle: { color: C.s1, opacity: 0.08 },
              markLine: markLineAt([Math.round(mean)], (p) => L("均值 ", "mean ") + p.value),
            }],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("1952 年至今最长的家庭部门情绪连续序列，每月由密歇根大学调查。反映消费者对自身财务与经济前景的感受，对通胀和油价冲击尤其敏感。",
        "The longest continuous household-sentiment series (since 1952), surveyed monthly by the University of Michigan. Reflects how consumers feel about their finances and the economy — especially sensitive to inflation and gasoline shocks."),
      how: L("对股市的用法同样是反向、只看极端：信心极端低迷的月份（1980、2008-09、2011、2022 等）之后，股市远期回报的历史中位数明显偏高——情绪冰点往往意味着坏消息已在价格里。高涨区域则相反但更弱。",
        "For equities the usage is again contrarian at extremes: months of deeply depressed confidence (1980, 2008-09, 2011, 2022) were followed by clearly above-median forward returns — sentiment troughs tend to mean the bad news is priced. Elevated readings work the other way, but more weakly."),
      caveat: L("它测的是家庭感受而非市场仓位，与股市的联动是间接的。FRED 只收录月度终值，比初值晚约一个月；月频序列对短窗口（1月/3月）几乎没有可看内容。",
        "It measures household mood, not market positioning — the link to equities is indirect. FRED carries only final monthly values (about a month behind the preliminary print); a monthly series has little to show in 1M/3M windows."),
    },
    source: L("数据：FRED · University of Michigan Consumer Sentiment（UMCSENT），月频，1952-11 至今（约一个月发布滞后）。",
      "Data: FRED · University of Michigan Consumer Sentiment (UMCSENT), monthly, since Nov 1952 (~1-month publication lag)."),
  },

  /* ---------- 15. NAAIM 管理人仓位 ---------- */
  {
    id: "naaim", group: "g5",
    name: L("NAAIM 主动管理人股票敞口", "NAAIM Manager Exposure Index"),
    short: L("管理人仓位", "Manager exposure"),
    subtitle: L("NAAIM Exposure Index · 会员实际组合的股票敞口（-200% ~ +200%）· 2006 至今",
      "NAAIM Exposure Index · members' actual portfolio equity exposure (−200% to +200%) · since 2006"),
    freq: "每周更新",
    deps: ["naaim"],
    build(S) {
      const { dates, values } = S.naaim;
      const last = values[values.length - 1];
      const pctl = percentile(values, last);
      const ma4arr = sma(values, 4);
      const ma4 = ma4arr[ma4arr.length - 1];
      let label = L("管理人仓位中性", "Manager exposure neutral");
      if (pctl >= 90) label = L("管理人仓位拥挤（高敞口，仅参考）", "Crowded exposure (reference only)");
      else if (pctl <= 10) label = L("管理人仓位极低（仅参考）", "Exposure near lows (reference only)");
      return {
        value: last.toFixed(0) + "%",
        delta: L("4周均线 ", "4-wk avg ") + (ma4 == null ? "—" : ma4.toFixed(0) + "%") +
          L(" · 历史分位 ", " · percentile ") + pctl.toFixed(0) + "%",
        readings: [
          { label: L("当前平均敞口", "Current average exposure"), value: last.toFixed(1) + "%" },
          { label: L("4周均线", "4-week average"), value: ma4 == null ? "—" : ma4.toFixed(1) + "%" },
          { label: L("2006年以来分位", "Percentile since 2006"), value: pctl.toFixed(0) + "%" },
        ],
        signal: { level: "info", label },
        spark: { values: values.slice(-104) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v + "%" }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1) + "%")),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 64, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries(L("周度敞口", "Weekly exposure"), values, C.muted, { lineStyle: { width: 1.2, color: C.muted, opacity: 0.7 } }),
              lineSeries(L("4周均线", "4-week average"), ma4arr, C.s1),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("全美主动投资管理人协会（NAAIM）每周三调查会员的<b>实际组合股票敞口</b>：0 = 空仓，100 = 满仓，200 = 两倍杠杆做多，负值 = 净做空。与 AAII 问「观点」不同，它问的是「仓位」。",
        "NAAIM surveys member managers each Wednesday on their <b>actual portfolio equity exposure</b>: 0 = flat, 100 = fully invested, 200 = 2x leveraged long, negative = net short. Unlike AAII, which asks opinions, this asks positions."),
      how: L("反向读法看极端：敞口挤到 100 上方（杠杆化乐观）后市场短期回报中位数偏低；敞口跌到 20 以下的恐慌区多次与阶段性底部重叠（2008-10、2020-03、2022-09）。周度噪音极大，看 4 周均线。",
        "Contrarian at extremes: readings crowding above 100 (leveraged optimism) precede below-median short-term returns; panic readings under 20 have repeatedly overlapped interim bottoms (Oct 2008, Mar 2020, Sep 2022). Weekly noise is huge — follow the 4-week average."),
      caveat: L("样本只有约 200 家中小型主动管理机构，2006 年才开始，未经历完整的长周期检验；学术层面没有可靠的预测力证据——与本组其他指标一样，只作情绪温度计。",
        "The sample is only ~200 small-to-mid active managers, the series starts in 2006, and there is no solid academic evidence of predictive power — like everything in this group, a sentiment thermometer only."),
    },
    source: L("数据：NAAIM Exposure Index 官方历史文件（每周更新，文件链接每期变化、自动从官网解析），周频，2006-07 至今。",
      "Data: official NAAIM Exposure Index history file (weekly; the file URL changes each week and is auto-resolved from their site), since Jul 2006."),
  },

  /* ---------- 16. Cboe SKEW ---------- */
  {
    id: "skew", group: "g5",
    name: L("Cboe SKEW 指数（尾部风险定价）", "Cboe SKEW Index (Tail-Risk Pricing)"),
    short: "SKEW",
    subtitle: L("由深虚值标普期权价格推算的隐含偏度 · 日频 · 1990 至今",
      "Implied skewness backed out of deep out-of-the-money S&P options · daily · since 1990"),
    freq: "每日更新",
    deps: ["skew"],
    build(S) {
      const { dates, values } = S.skew;
      const last = values[values.length - 1];
      const pctl = percentile(values, last);
      const ma20arr = sma(values, 20);
      const ma20 = ma20arr[ma20arr.length - 1];
      let label = L("尾部保护需求中性", "Tail-hedge demand neutral");
      if (pctl >= 90) label = L("尾部保护需求偏高（为暴跌付高溢价）", "Tail-hedge demand elevated (crash protection pricey)");
      else if (pctl <= 10) label = L("尾部保护需求偏低", "Tail-hedge demand low");
      return {
        value: last.toFixed(1),
        delta: L("20日均线 ", "20-day avg ") + (ma20 == null ? "—" : ma20.toFixed(1)) +
          L(" · 历史分位 ", " · percentile ") + pctl.toFixed(0) + "%",
        readings: [
          { label: L("当前 SKEW", "Current SKEW"), value: last.toFixed(2) },
          { label: L("20日均线", "20-day average"), value: ma20 == null ? "—" : ma20.toFixed(1) },
          { label: L("1990年以来分位", "Percentile since 1990"), value: pctl.toFixed(0) + "%" },
        ],
        signal: { level: "info", label },
        spark: { values: values.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(dates, { yFmt: (v) => v }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1))),
            legend: { top: 2, right: 10, textStyle: { color: C.ink2, fontSize: 12 } },
            grid: { left: 64, right: 20, top: 34, bottom: 62 },
            dataZoom: baseZoom(),
            series: [
              lineSeries("SKEW", values, C.muted, { lineStyle: { width: 1.2, color: C.muted, opacity: 0.7 } }),
              lineSeries(L("20日均线", "20-day average"), ma20arr, C.s1),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: L("Cboe 用深虚值标普期权价格反推的隐含偏度指数：100 = 收益分布无偏斜，数值越高表示市场为「暴跌保护」支付的相对溢价越高。典型区间约 110–160。",
        "Cboe's implied-skewness index backed out of deep OTM S&P option prices: 100 = no skew in the return distribution; higher readings mean the market pays a fatter relative premium for crash protection. Typical range ~110–160."),
      how: L("高 SKEW = 尾部对冲需求旺盛（未必看空，可能是仓位重所以买保险）；低 SKEW = 市场对崩盘定价便宜。与 VIX 期限结构互补：VIX 管「近期波动预期」，SKEW 管「极端下跌的相对定价」。",
        "High SKEW = strong tail-hedging demand (not necessarily bearish — heavy positioning buys insurance); low SKEW = crash risk priced cheaply. Complements the VIX term structure: VIX covers near-term volatility expectations, SKEW covers the relative pricing of extreme downside."),
      caveat: L("对后续收益或暴跌概率的预测力，学术检验结论基本是<b>无效或非常弱</b>——放在本组仅作观察。深虚值期权流动性差，读数本身噪音也大。",
        "Academic tests of its power to predict returns or crash probability come back mostly <b>null or very weak</b> — it sits in this group for observation only. Deep OTM options are illiquid, so the reading itself is noisy."),
    },
    source: L("数据：Cboe · SKEW Index 官方日线历史（1990 至今）。",
      "Data: Cboe · official SKEW Index daily history (since 1990)."),
  },

  /* ---------- 17. FINRA 融资余额 ---------- */
  {
    id: "finra_margin", group: "g5",
    name: L("融资余额（FINRA 保证金债务）", "Margin Debt (FINRA)"),
    short: L("融资余额", "Margin debt"),
    subtitle: L("经纪商客户保证金账户借款总额 · 月频 · 1997 至今",
      "Total customer margin-account borrowing at broker-dealers · monthly · since 1997"),
    freq: "每月更新",
    deps: ["finra_margin", "spx"],
    optionalDeps: ["ibkr_margin"],
    build(S) {
      const { dates, values } = S.finra_margin;
      const n = values.length;
      const last = values[n - 1];
      const yoyAll = values.map((v, i) => (i >= 12 ? (v / values[i - 12] - 1) * 100 : null));
      const yoy = yoyAll[n - 1];
      const yoyClean = yoyAll.filter((v) => v != null);
      const pctl = percentile(yoyClean, yoy);

      /* —— 现时预估（nowcast）——
       * 官方数据滞后约 1-2 个月。回测（1997-2026，样本外233个月）：
       * Δlog(余额) ≈ α + β×标普月度对数收益，月均误差 2.7%，优于"不变假设"的 3.5%；
       * 凸性/滞后修正项均无样本外增益，故弃用。可选叠加 IBKR 前哨
       * （次月1-3日发布，与 FINRA 月度变化相关性 0.77）对齐后各取一半权重。 */
      const ols1 = (oys, oxs) => {
        const mx = oxs.reduce((s, v) => s + v, 0) / oxs.length;
        const my = oys.reduce((s, v) => s + v, 0) / oys.length;
        let num = 0, den = 0;
        for (let i = 0; i < oxs.length; i++) { num += (oxs[i] - mx) * (oys[i] - my); den += (oxs[i] - mx) ** 2; }
        const bb = num / den;
        return { a: my - bb * mx, b: bb };
      };
      const nextM = (m) => { let yy = +m.slice(0, 4), mo = +m.slice(5, 7) + 1; if (mo > 12) { yy++; mo = 1; } return yy + "-" + String(mo).padStart(2, "0"); };
      const prevMo = (m) => { let yy = +m.slice(0, 4), mo = +m.slice(5, 7) - 1; if (mo < 1) { yy--; mo = 12; } return yy + "-" + String(mo).padStart(2, "0"); };
      const prevYr = (m) => (+m.slice(0, 4) - 1) + "-" + m.slice(5, 7);
      const meClose = {}, meDate = {}, tdCount = {};
      S.spx.dates.forEach((d, i) => { const m = d.slice(0, 7); meClose[m] = S.spx.values[i]; meDate[m] = d; tdCount[m] = (tdCount[m] || 0) + 1; });
      const mdMonths = dates.map((d) => d.slice(0, 7));
      const mdMap = {};
      mdMonths.forEach((m, i) => { mdMap[m] = values[i]; });
      const ys = [], xs = [];
      for (let i = 1; i < mdMonths.length; i++) {
        if (meClose[mdMonths[i]] && meClose[mdMonths[i - 1]]) {
          ys.push(Math.log(values[i] / values[i - 1]));
          xs.push(Math.log(meClose[mdMonths[i]] / meClose[mdMonths[i - 1]]));
        }
      }
      const fitB = ols1(ys.slice(-120), xs.slice(-120));
      let ibMap = null, ibFit = null;
      if (S.ibkr_margin) {
        ibMap = {};
        S.ibkr_margin.dates.forEach((d, i) => { ibMap[d.slice(0, 7)] = S.ibkr_margin.values[i]; });
        const ims = Object.keys(ibMap).sort(), oy = [], ox = [];
        for (let i = 1; i < ims.length; i++) {
          if (mdMap[ims[i]] && mdMap[ims[i - 1]]) {
            oy.push(Math.log(mdMap[ims[i]] / mdMap[ims[i - 1]]));
            ox.push(Math.log(ibMap[ims[i]] / ibMap[ims[i - 1]]));
          }
        }
        if (oy.length >= 8) ibFit = ols1(oy, ox);
      }
      const spxLastM = S.spx.dates[S.spx.dates.length - 1].slice(0, 7);
      const est = [];
      let lvl = last, prevClose = meClose[mdMonths[n - 1]], usedIbkr = false, crashRisk = false;
      let gm = nextM(mdMonths[n - 1]);
      while (prevClose && meClose[gm] && gm <= spxLastM && est.length < 4) {
        const complete = gm < spxLastM;
        const r = Math.log(meClose[gm] / prevClose);
        if (r < -0.08) crashRisk = true;
        const frac = complete ? 1 : Math.min(1, (tdCount[gm] || 0) / 21);
        let dhat = fitB.a * frac + fitB.b * r;
        if (complete && ibFit && ibMap[gm] != null && ibMap[prevMo(gm)] != null) {
          dhat = (dhat + ibFit.a + ibFit.b * Math.log(ibMap[gm] / ibMap[prevMo(gm)])) / 2;
          usedIbkr = true;
        }
        lvl *= Math.exp(dhat);
        est.push({ m: gm, date: meDate[gm], level: lvl });
        prevClose = meClose[gm];
        gm = nextM(gm);
      }
      const estLast = est.length ? est[est.length - 1] : null;
      const estYoyLast = estLast && mdMap[prevYr(estLast.m)]
        ? (estLast.level / mdMap[prevYr(estLast.m)] - 1) * 100 : null;
      let label = L("杠杆水平变化中性", "Leverage growth neutral");
      if (yoy >= 40) label = L("杠杆快速扩张（历史顶部前常见，弱证据）", "Rapid leveraging (common before past tops — weak evidence)");
      else if (yoy <= -20) label = L("去杠杆进行中（多与底部区域重叠，滞后）", "Deleveraging underway (tends to overlap bottoms, lagging)");
      return {
        value: L((last / 1e6).toFixed(2) + " 万亿$", "$" + (last / 1e6).toFixed(2) + "T"),
        delta: L("同比 ", "YoY ") + fmt.pctS(yoy) +
          (estLast ? L(" · 预估今 ≈$", " · est. now ≈$") + (estLast.level / 1e6).toFixed(2) + "T"
                   : L(" · 增速分位 ", " · growth pctile ") + pctl.toFixed(0) + "%"),
        readings: [
          { label: L("最新官方余额（" + mdMonths[n - 1] + "）", "Latest official (" + mdMonths[n - 1] + ")"),
            value: L((last / 1e6).toFixed(3) + " 万亿美元", "$" + (last / 1e6).toFixed(3) + " trillion") },
          { label: L("官方同比增速", "Official YoY growth"), value: fmt.pctS(yoy) + L("（分位 ", " (pctile ") + pctl.toFixed(0) + L("%）", "%)") },
          ...(estLast ? [{
            label: L("预估至 " + estLast.date + "（β模型" + (usedIbkr ? "×IBKR前哨" : "") + "外推，±4%）",
                     "Est. as of " + estLast.date + " (β-model" + (usedIbkr ? "×IBKR" : "") + ", ±4%)"),
            value: L("≈ " + (estLast.level / 1e6).toFixed(3) + " 万亿美元", "≈ $" + (estLast.level / 1e6).toFixed(3) + " trillion") +
              (estYoyLast != null ? L("（同比 ", " (YoY ") + fmt.pctS(estYoyLast) + L("）", ")") : ""),
          }] : []),
        ],
        signal: { level: "info", label },
        note: crashRisk
          ? L("⚠ 预估窗口内出现单月跌幅超8%：强制去杠杆情形下实际余额可能显著低于估算，请保守解读。",
              "⚠ A month in the estimation window fell over 8%: forced deleveraging may push the actual balance well below this estimate.")
          : undefined,
        spark: { values: values.slice(-60) },
        tallChart: true,
        renderChart(node) {
          const c = echarts.init(node);
          // 官方点对齐到真实月末交易日（FINRA 数值本就是月末余额；键值月初仅是存储约定）
          const dispDates = dates.map((d) => meDate[d.slice(0, 7)] || d);
          const allDates = dispDates.concat(est.map((e) => e.date));
          const lvlOff = values.map((v) => Number((v / 1e6).toFixed(4))).concat(est.map(() => null));
          // 预估虚线：从最后一个官方点接出，空心圆点标记
          const lvlEst = new Array(n - 1).fill(null)
            .concat([Number((last / 1e6).toFixed(4))], est.map((e) => Number((e.level / 1e6).toFixed(4))));
          const yoyOff = yoyAll.concat(est.map(() => null));
          const yoyEstArr = new Array(n - 1).fill(null).concat([yoyAll[n - 1]], est.map((e) => {
            const b0 = mdMap[prevYr(e.m)];
            return b0 ? Number(((e.level / b0 - 1) * 100).toFixed(1)) : null;
          }));
          const estStyle = (color) => ({
            sampling: undefined, showSymbol: true, symbolSize: 7,
            lineStyle: { width: 2, color, type: "dashed" },
            itemStyle: { color: C.surface, borderColor: color, borderWidth: 2 },
          });
          c.setOption({
            title: [
              { text: L("融资余额（万亿美元）· 虚线为预估", "Margin debt ($T) · dashed = estimate"), top: 8, left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
              { text: L("同比增速（%）· 顶部前的极端加杠杆更值得留意", "YoY growth (%) · extreme leveraging before tops is the tell"), top: "56%", left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
            ],
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(2))),
            axisPointer: { link: [{ xAxisIndex: "all" }] },
            legend: {
              top: 4, right: 10, textStyle: { color: C.ink2, fontSize: 12 },
              data: [L("官方", "Official"), L("预估", "Estimate")],
            },
            grid: [
              { left: 70, right: 20, top: 36, height: "38%" },
              { left: 70, right: 20, top: "63%", height: "20%" },
            ],
            xAxis: [
              { type: "category", boundaryGap: false, data: allDates, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
              { type: "category", boundaryGap: false, data: allDates, gridIndex: 1, axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v.slice(0, 7) }, axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false } },
            ],
            yAxis: [
              { type: "value", scale: true, gridIndex: 0, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.muted, fontSize: 11 } },
              { type: "value", scale: true, gridIndex: 1, splitLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.muted, fontSize: 11, formatter: (v) => v + "%" } },
            ],
            dataZoom: [
              { type: "inside", xAxisIndex: [0, 1], filterMode: "filter", zoomOnMouseWheel: "ctrl", moveOnMouseMove: true },
              { ...baseZoom([0, 1])[1] },
            ],
            series: [
              { ...lineSeries(L("官方", "Official"), lvlOff, C.s1), xAxisIndex: 0, yAxisIndex: 0, areaStyle: { color: C.s1, opacity: 0.08 } },
              { ...lineSeries(L("预估", "Estimate"), lvlEst, C.s1, estStyle(C.s1)), xAxisIndex: 0, yAxisIndex: 0 },
              { ...lineSeries(L("同比增速", "YoY growth"), yoyOff, C.s2), xAxisIndex: 1, yAxisIndex: 1, markLine: markLineAt([0], (p) => p.value + "%") },
              { ...lineSeries(L("预估同比", "Est. YoY"), yoyEstArr, C.s2, estStyle(C.s2)), xAxisIndex: 1, yAxisIndex: 1 },
            ],
          });
          return { chart: c, dates: allDates };
        },
      };
    },
    desc: {
      what: L("FINRA 汇总的经纪商客户保证金账户借款（margin debt），衡量美股市场的显性杠杆水平，1997 年至今月频。",
        "Customer margin-account borrowing aggregated by FINRA — the visible leverage in the US equity market, monthly since 1997."),
      how: L("绝对水平随市值自然增长，本身没有信息量；看<b>同比增速的极端</b>：1999-2000、2007、2021 的顶部之前都出现过 +40% 以上的加杠杆狂潮；深度去杠杆（-20% 以下）则多与熊市中后段重叠——偏同步略滞后，不是领先信号。<b>图表末端虚线为现时预估</b>：Δlog(余额) ≈ α + 0.68×标普月度收益（近120个月滚动拟合；1997 年以来严格样本外回测月均误差 ±2.7%，凸性与滞后修正项经检验无增益已弃用），缺口月若有 IBKR 前哨数据（其保证金贷款次月1-3日即发布，与 FINRA 月度变化相关性 0.77）则与 β 模型各取一半权重。",
        "The level grows with market cap and carries no signal by itself; watch <b>extremes in YoY growth</b>: leveraging sprees above +40% preceded the 1999-2000, 2007 and 2021 tops, while deep deleveraging (below −20%) overlaps mid-to-late bear markets — coincident-to-lagging, not leading. <b>The dashed tail is a nowcast</b>: Δlog(balance) ≈ α + 0.68×S&P monthly return (rolling 120-month fit; strict out-of-sample backtest since 1997 shows ±2.7%/month mean error; convexity and lag corrections tested and rejected for no OOS gain). When IBKR's sentinel data is available for a gap month (their margin loans publish on the 1st–3rd, 0.77 correlation with FINRA's monthly change), it gets half the weight alongside the β-model."),
      caveat: L("发布滞后约一个月（虚线预估正是为此而设）；只覆盖持牌经纪商的保证金借款，衍生品与场外杠杆不在其中，实际总杠杆被低估。预估的已知盲区：暴跌月的强制去杠杆会被显著低估（2008-10/11 实际 -20% vs 模型 -3~-6%）——越是危机时刻越要保守解读虚线。",
        "Published with ~1 month lag (which is exactly what the dashed nowcast addresses); covers only margin loans at registered broker-dealers — derivatives and off-exchange leverage are excluded, so total leverage is understated. Known blind spot of the estimate: forced deleveraging in crash months is badly underestimated (Oct/Nov 2008 actual −20% vs model −3 to −6%) — read the dashed line conservatively precisely when it matters most."),
    },
    source: L("数据：FINRA Margin Statistics 官方历史文件，月频，1997-01 至今（约一个月发布滞后）；预估基于 Cboe SPX 日线与 IBKR 月度经营指标（官方新闻稿 PDF，自动解析）。虚线预估为统计外推，非官方数据。",
      "Data: official FINRA Margin Statistics history file, monthly, since Jan 1997 (~1-month lag); nowcast uses Cboe SPX daily data and IBKR monthly brokerage metrics (official press-release PDFs, auto-parsed). The dashed estimate is a statistical extrapolation, not official data."),
  },
]; }
let INDICATORS = makeIndicators();

/* ================= 视图渲染 ================= */
const built = {};   // id → build() 结果
const failed = {};  // id → error

function badgeHTML(sig) {
  const lv = LEVEL[sig.level];
  // title 属性提供悬停显示完整文案；.badge-txt 负责超长省略号截断
  return `<span class="badge ${sig.level}" title="${esc(sig.label)}">` +
    `<span class="ico">${lv.ico}</span><span class="badge-txt">${sig.label}</span></span>`;
}
function sparkSVG(values, color) {
  const vs = values.filter((v) => v != null);
  if (vs.length < 2) return "";
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const W = 100, H = 42, P = 3;
  const pts = vs.map((v, i) => {
    const x = (i / (vs.length - 1)) * W;
    const y = P + (1 - (v - min) / span) * (H - 2 * P);
    return x.toFixed(1) + "," + y.toFixed(1);
  });
  const [lx, ly] = pts[pts.length - 1].split(",");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${C.muted}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${lx}" cy="${ly}" r="3" fill="${color}" stroke="${C.surface}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderNav() {
  const wrap = $("#nav-groups");
  wrap.innerHTML = "";
  GROUPS.forEach((g) => {
    wrap.appendChild(el("div", "nav-group-title", groupName(g)));
    INDICATORS.filter((x) => x.group === g.id).forEach((ind) => {
      const item = el("div", "nav-item", `<span class="nav-dot" id="dot-${ind.id}" style="background:${C.axis}"></span>${ind.short}`);
      item.dataset.id = ind.id;
      item.onclick = () => { if (built[ind.id]) showDetail(ind.id); else retryFailed(); };
      wrap.appendChild(item);
    });
  });
}
function renderStrip() {
  const strip = $("#signal-strip");
  strip.innerHTML = "";
  INDICATORS.forEach((ind) => {
    const chip = el("span", "chip", `<span class="ico" id="chip-${ind.id}" style="color:${C.axis}">●</span>${ind.short}`);
    chip.onclick = () => { if (built[ind.id]) showDetail(ind.id); else retryFailed(); };
    strip.appendChild(chip);
  });
}
function renderCardShell() {
  const cards = $("#cards");
  cards.innerHTML = "";
  // 按分组分区：每组先插一条占满整行的小副标题，其下排列该组卡片
  GROUPS.forEach((g) => {
    const members = INDICATORS.filter((x) => x.group === g.id);
    if (!members.length) return;
    cards.appendChild(el("div", "cards-group-head", groupName(g)));
    members.forEach((ind) => {
      const card = el("div", "card loading");
      card.id = "card-" + ind.id;
      card.innerHTML =
        `<div class="c-top"><span class="c-name">${ind.name}</span></div>` +
        `<div class="c-value">${L("加载中…", "Loading…")}</div><div class="c-delta"></div><div class="c-bottom"></div>`;
      card.onclick = () => { if (built[ind.id]) showDetail(ind.id); };
      cards.appendChild(card);
    });
  });
}
function updateCard(ind) {
  const card = $("#card-" + ind.id);
  if (!card) return;
  const b = built[ind.id];
  if (!b) {
    card.classList.add("loading");
    card.querySelector(".c-value").innerHTML =
      `<span class="c-err">${L("加载失败：", "Load failed: ")}${esc((failed[ind.id] || "").toString().slice(0, 80))}</span>`;
    const bot = card.querySelector(".c-bottom");
    bot.innerHTML = "";
    const btn = el("button", "retry", L("重试", "Retry"));
    btn.onclick = (e) => { e.stopPropagation(); retryFailed(); };
    bot.appendChild(btn);
    // 失败状态用暖色标记，与「加载中」的灰色区分
    $("#dot-" + ind.id).style.background = C.serious;
    $("#chip-" + ind.id).style.color = C.serious;
    return;
  }
  card.classList.remove("loading");
  card.querySelector(".c-value").textContent = b.value;
  card.querySelector(".c-delta").textContent =
    (b.delta || "") + (b.stale ? L(" · ⚠ 缓存数据", " · ⚠ cached") : "");
  card.querySelector(".c-bottom").innerHTML =
    sparkSVG(b.spark.values, LEVEL[b.signal.level].color) + badgeHTML(b.signal);
  $("#dot-" + ind.id).style.background = LEVEL[b.signal.level].color;
  $("#chip-" + ind.id).style.color = LEVEL[b.signal.level].color;
}

let currentDetail = null;
function showOverview() {
  currentDetail = null;
  disposeCharts();
  $("#detail").hidden = true;
  $("#overview").hidden = false;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.querySelector(".nav-overview").classList.add("active");
}
function showDetail(id) {
  const ind = INDICATORS.find((x) => x.id === id);
  const b = built[id];
  if (!b) return;
  currentDetail = id;
  disposeCharts();
  $("#overview").hidden = true;
  $("#detail").hidden = false;
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.id === id);
  });
  $("#d-title").textContent = ind.name;
  if (b.updated) {
    const wd = WEEKDAYS()[new Date(b.updated + "T00:00:00").getDay()];
    const freqPair = FREQ_LABEL[ind.freq || "每日更新"] || FREQ_LABEL["每日更新"];
    $("#d-updated").innerHTML =
      L("数据更新至 ", "Data through ") + esc(b.updated) +
      L("（" + wd + "）（" + freqPair[0] + "）", " (" + wd + ") (" + freqPair[1] + ")") +
      (b.stale ? ' <span class="warn-txt">' +
        L("· ⚠ 上游暂不可用，显示缓存数据", "· ⚠ upstream unavailable — showing cached data") +
        "</span>" : "");
  } else {
    $("#d-updated").textContent = "";
  }
  $("#d-subtitle").textContent = ind.subtitle;
  $("#d-badge").innerHTML = badgeHTML(b.signal);
  const rd = $("#d-readings");
  rd.innerHTML = "";
  b.readings.forEach((r) => {
    rd.appendChild(el("div", "reading",
      `<div class="r-label">${r.label}</div><div class="r-value${r.small ? " small" : ""}">${r.value}</div>`));
  });
  const chartNode = $("#d-chart");
  chartNode.classList.toggle("tall", !!b.tallChart);
  chartNode.innerHTML = "";
  // 防御：单个图表出错不应破坏详情页其余部分（说明、辅助表格等）
  let info = null;
  try {
    info = b.renderChart(chartNode);
  } catch (e) {
    console.error("chart render failed:", id, e);
    chartNode.innerHTML = '<div class="chart-err">' +
      L("图表渲染失败：", "Chart rendering failed: ") +
      String(e.message || e).slice(0, 120) + "</div>";
  }
  if (info) {
    liveCharts.push(info.chart);
    wireRanges($("#d-ranges"), info.chart, info.dates, 36);
  } else {
    $("#d-ranges").innerHTML = "";
  }
  const aux = $("#d-aux");
  aux.innerHTML = "";
  if (b.renderAux) b.renderAux(aux);
  $("#d-desc").innerHTML =
    `<h4>${L("是什么 · 证据", "What it is · Evidence")}</h4><p>${ind.desc.what}</p>` +
    `<h4>${L("怎么读", "How to read it")}</h4><p>${ind.desc.how}</p>` +
    `<h4>${L("局限与注意", "Limitations")}</h4><p>${ind.desc.caveat}</p>`;
  $("#d-source").innerHTML = ind.source +
    (b.note ? ` <span class="note-flag">⚠ ${esc(translateNote(b.note))}</span>` : "") +
    "<br>" + L("本页面仅为公开数据与学术文献的可视化整理，不构成任何投资建议。",
      "This page visualizes public data and academic findings for research purposes only — not investment advice.");
  window.scrollTo(0, 0);
}

/* ================= 启动 ================= */
function buildIndicator(ind) {
  const card = $("#card-" + ind.id);
  if (card) {
    card.classList.add("loading");
    card.querySelector(".c-value").textContent = L("加载中…", "Loading…");
  }
  const optional = ind.optionalDeps || [];
  return Promise.all([
    Promise.all(ind.deps.map(loadSeries)),
    Promise.allSettled(optional.map(loadSeries)),  // 可选依赖失败不拖垮指标
  ])
    .then(([list, optRes]) => {
      const S = {};
      ind.deps.forEach((k, i) => { S[k] = list[i]; });
      const optOk = [];
      optional.forEach((k, i) => {
        if (optRes[i].status === "fulfilled") { S[k] = optRes[i].value; optOk.push(optRes[i].value); }
      });
      const b = ind.build(S);
      // 汇总所有依赖序列的提示与 stale 标记（缓存回退时全部指标可见，而非仅 OAS）
      const all = list.concat(optOk);
      const notes = new Set(all.map((s) => s.note).filter(Boolean));
      if (b.note) notes.add(b.note);
      b.note = notes.size ? [...notes].join(" ") : undefined;
      b.stale = all.some((s) => s.stale);
      // 数据更新日：取必需依赖最后日期中最早的一个（最慢的组件截至哪天）
      b.updated = list.map((s) => s.dates[s.dates.length - 1]).sort()[0];
      built[ind.id] = b;
      delete failed[ind.id];
      updateCard(ind);
      if (currentDetail === ind.id) showDetail(ind.id);
    })
    .catch((e) => {
      console.error(ind.id, e);
      failed[ind.id] = e.message || e;
      delete built[ind.id];
      updateCard(ind);
    });
}

/* 重试所有失败的指标：失败常因同一上游序列，成功后一起恢复 */
function retryFailed() {
  const list = INDICATORS.filter((i) => failed[i.id]);
  list.forEach((i) => buildIndicator(i));
}

function boot() {
  applyTheme(themeMode, false); // 在渲染任何内容前先套用已保存的主题
  updateStaticTexts();          // 套用已保存的语言（INDICATORS 初始即按 LANG 构建）
  renderNav();
  renderStrip();
  renderCardShell();
  $("#back-btn").onclick = showOverview;
  document.querySelector(".nav-overview").onclick = showOverview;
  $("#theme-toggle").onclick = () =>
    applyTheme(themeMode === "dark" ? "light" : "dark", true);
  $("#lang-toggle").onclick = () => applyLang(LANG === "zh" ? "en" : "zh");

  dataMode.then((d) => { metaInfo = d; renderMetaLine(); })
    .catch(() => { metaInfo = { mode: "none" }; renderMetaLine(); });

  // 按依赖多寡排序加载：先渲染只依赖 FRED/Cboe 的指标（快），ETF 类随后
  const order = [...INDICATORS].sort((a, b) => a.deps.length - b.deps.length);
  order.forEach((ind) => buildIndicator(ind));
}
boot();
