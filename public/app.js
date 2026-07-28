/* 市场信号监测 — 前端逻辑
 * 数据由本地 server.py 代理（FRED / Cboe / Nasdaq），前端负责指标计算与展示。
 * 所有信号阈值仅为文献常用参考，不构成投资建议。
 */
"use strict";

/* ================= 主题色（dataviz 参考调色板 · 深色） ================= */
const C = {
  surface: "#1a1a19", page: "#0d0d0d",
  ink: "#ffffff", ink2: "#c3c2b7", muted: "#898781",
  grid: "#2c2c2a", axis: "#383835", border: "rgba(255,255,255,0.10)",
  s1: "#3987e5", s2: "#d95926", s3: "#199e70",
  good: "#0ca30c", warn: "#fab219", serious: "#ec835a",
  crit: "#d03b3b", critSoft: "#e66767",
};
const LEVEL = {
  good:    { color: C.good,     ico: "●" },
  warn:    { color: C.warn,     ico: "▲" },
  serious: { color: C.serious,  ico: "▲" },
  risk:    { color: C.critSoft, ico: "■" },
  info:    { color: C.muted,    ico: "◦" },
};

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
  wan: (v) => (v / 1e4).toFixed(1) + "万",
  num: (v, d = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }),
};
const pctOr = (v, d = 1) => (v == null ? "—" : fmt.pctS(v, d));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    axisPointer: { type: "cross", label: { backgroundColor: "#333" }, crossStyle: { color: C.muted } },
    backgroundColor: "#232322", borderColor: "rgba(255,255,255,0.14)",
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
      ' &nbsp;<b style="color:#fff">' + fmtV(p.value) + "</b>";
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
  { label: "1月", m: 1 }, { label: "3月", m: 3 }, { label: "6月", m: 6 },
  { label: "1年", m: 12 }, { label: "3年", m: 36 }, { label: "5年", m: 60 },
  { label: "10年", m: 120 }, { label: "全部", m: null },
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
    const b = el("button", "", r.label);
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
  { id: "g1", name: "宏观 · 证据较扎实" },
  { id: "g2", name: "宏观 · 参考价值 / 噪音大" },
  { id: "g3", name: "市场 · 动量（超额收益证据最强）" },
  { id: "g4", name: "市场 · 风控工具" },
];

const SECTORS = [
  ["xlk", "信息技术"], ["xlf", "金融"], ["xlv", "医疗保健"], ["xly", "可选消费"],
  ["xlc", "通信服务"], ["xli", "工业"], ["xlp", "必需消费"], ["xle", "能源"],
  ["xlu", "公用事业"], ["xlb", "材料"], ["xlre", "房地产"],
];
const ASSETS = [
  ["spy", "标普500 (SPY)"], ["qqq", "纳指100 (QQQ)"], ["tlt", "20年+美债 (TLT)"],
  ["gld", "黄金 (GLD)"], ["eem", "新兴市场 (EEM)"],
];

const INDICATORS = [
  /* ---------- 1. 高收益债 OAS ---------- */
  {
    id: "hy_oas", group: "g1", name: "高收益债信用利差（OAS）", short: "信用利差",
    subtitle: "ICE BofA 美国高收益指数期权调整利差 · 日频 · FRED: BAMLH0A0HYM2",
    deps: ["hy_oas"],
    build(S) {
      const { dates, values } = S.hy_oas;
      const last = values[values.length - 1];
      const d63 = idxOffset(values, 63);
      const chg = d63 == null ? null : last - d63;
      const pctl = percentile(values, last);
      const yrs = spanYears(dates);
      let level = "good", label = "利差偏窄，融资环境平稳";
      if (last >= 6 || (chg != null && chg >= 1.5)) { level = "risk"; label = "利差高位或快速走阔"; }
      else if (last >= 4.5 || (chg != null && chg >= 0.75)) { level = "warn"; label = "利差抬升，需要留意"; }
      return {
        value: fmt.pct(last) + " (" + Math.round(last * 100) + " bp)",
        delta: chg == null ? "" : "3个月 " + fmt.bpS(chg),
        readings: [
          { label: "当前 OAS", value: fmt.pct(last) },
          { label: "3个月变化", value: chg == null ? "—" : fmt.bpS(chg) },
          { label: "近" + yrs.toFixed(0) + "年分位", value: pctl.toFixed(0) + "%" },
          { label: "数据日期", value: dates[dates.length - 1], small: true },
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
              ...lineSeries("高收益 OAS", values, C.s1),
              areaStyle: { color: C.s1, opacity: 0.08 },
              markLine: markLineAt([4, 6], (p) => p.value + "%"),
            }],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: "高收益（垃圾级）公司债相对国债的期权调整利差。信用市场对融资环境恶化的反应往往先于股票市场，是可能最有用的实时风险温度计。",
      how: "看两件事：<b>水平</b>（历史上 4% 以下偏平静，6% 以上多对应压力期，2008、2020 时超过 10%－20%）和<b>变化速度</b>（数周内快速走阔 +100bp 以上通常意味着融资环境在恶化，比绝对水平更值得警惕）。",
      caveat: "利差窄本身不是做空理由——它可以在低位停留数年。注意：FRED 对 ICE BofA 系列只发布最近 3 年的滚动窗口（ICE 数据授权限制，官方 API 同样受限），因此历史分位基于可得窗口计算；本站每次刷新会自动把旧数据累积进本地缓存，运行越久可回看的历史越长。",
    },
    source: "数据：FRED · ICE BofA US High Yield Index Option-Adjusted Spread（BAMLH0A0HYM2），日频。",
  },

  /* ---------- 2. 收益率曲线 ---------- */
  {
    id: "t10y3m", group: "g1", name: "收益率曲线（10年 − 3个月）", short: "收益率曲线",
    subtitle: "10 年期与 3 个月期美债收益率之差 · 日频 · FRED: T10Y3M",
    deps: ["t10y3m"],
    build(S) {
      const { dates, values } = S.t10y3m;
      const last = values[values.length - 1];
      const inverted = last < 0;
      const start = runStartDate(dates, values, inverted ? (v) => v < 0 : (v) => v >= 0);
      const days = start ? daysBetween(start, dates[dates.length - 1]) : null;
      let level = "good", label = "曲线正常（正斜率）";
      if (inverted) { level = "risk"; label = "曲线倒挂"; }
      else if (last < 0.5) { level = "warn"; label = "曲线平坦，接近倒挂"; }
      return {
        value: (last >= 0 ? "+" : "") + last.toFixed(2) + " pp",
        delta: (inverted ? "倒挂" : "正常") + (days != null ? "已持续 " + days + " 天" : ""),
        readings: [
          { label: "当前利差", value: (last >= 0 ? "+" : "") + last.toFixed(2) + " pp" },
          { label: inverted ? "倒挂开始于" : "转正开始于", value: start || "—", small: true },
          { label: "数据日期", value: dates[dates.length - 1], small: true },
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
            series: polarityPair("10Y−3M 利差", values, 0, C.s1, C.critSoft,
              { markLine: markLineAt([0]) }),
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: "Estrella–Mishkin 的经典衰退预测指标：10 年期收益率低于 3 个月期（倒挂）后，历史上多数情况在 12–24 个月内出现衰退。",
      how: "倒挂 = 红色区间。注意它是<b>周期位置参考</b>：领先期极长且不稳定，2022–23 年那轮深度倒挂之后衰退迟迟未至。历史上有效的往往是「倒挂后再转正（re-steepening）」阶段更接近实际衰退。",
      caveat: "作为择时工具基本没用——从倒挂到股市顶部的间隔从几个月到两年以上不等。只用它判断自己在周期的大致位置。",
    },
    source: "数据：FRED · 10-Year Treasury Constant Maturity Minus 3-Month Treasury（T10Y3M），日频，1982 年至今。",
  },

  /* ---------- 3. 初请失业金 ---------- */
  {
    id: "icsa", group: "g1", name: "初请失业金人数", short: "初请失业金",
    subtitle: "每周首次申领失业保险人数 · 周频 · FRED: ICSA",
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
      let level = "good", label = "初请处于低位区间";
      if (above > 25) { level = "risk"; label = "初请较年内低点大幅抬升"; }
      else if (above > 10) { level = "warn"; label = "初请较年内低点明显抬升"; }
      return {
        value: fmt.wan(last),
        delta: "4周均线 " + fmt.wan(ma4Last) + " · 高于52周低点 " + fmt.pctS(above),
        readings: [
          { label: "最新一周", value: fmt.wan(last) },
          { label: "4周移动均线", value: fmt.wan(ma4Last) },
          { label: "较52周低点", value: fmt.pctS(above) },
          { label: "数据日期", value: dates[dates.length - 1], small: true },
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
              lineSeries("周度初请", values, C.muted, { lineStyle: { width: 1.2, color: C.muted, opacity: 0.7 } }),
              lineSeries("4周均线", ma4, C.s1),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: "每周首次申领失业保险的人数。高频（周四发布）、修正极少、对经济拐点敏感，是就业市场最快的硬数据。",
      how: "用 <b>4 周移动均线</b>过滤单周噪音。历史经验：4 周均线较过去 52 周低点抬升超过 15–25% 时，往往对应就业周期转弱；衰退开始前后初请通常已在快速上行。",
      caveat: "假期、罢工、天气会造成单周大幅扰动（图中疫情初期的尖峰即极端例子）。看均线趋势，不看单周。",
    },
    source: "数据：FRED · Initial Claims（ICSA），周频（每周四更新），1980 年至今。此处 4 周均线由周度数据计算。",
  },

  /* ---------- 4. 市场宽度（代理） ---------- */
  {
    id: "breadth", group: "g2", name: "市场宽度（等权/市值比值代理）", short: "市场宽度",
    subtitle: "RSP（标普等权）÷ SPY（标普市值加权）· 日频 · Nasdaq 行情",
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
      let level = "info", label = "宽度中性";
      if (spx63 != null && chg63 != null && spx63 > 2 && chg63 < -2) { level = "warn"; label = "指数上涨但宽度走弱（背离）"; }
      else if (chg63 != null && chg63 > 1) { level = "good"; label = "宽度改善（等权跑赢）"; }
      else if (chg63 != null && chg63 < -4) { level = "warn"; label = "宽度持续走弱"; }
      return {
        value: last.toFixed(4),
        delta: "3个月 " + pctOr(chg63) + " · 6个月 " + pctOr(chg126),
        readings: [
          { label: "RSP/SPY 比值", value: last.toFixed(4) },
          { label: "3个月变化", value: pctOr(chg63) },
          { label: "同期标普涨跌", value: pctOr(spx63) },
          { label: "数据日期", value: al.dates[al.dates.length - 1], small: true },
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
              lineSeries("200日均线", ma200, C.s2, { lineStyle: { width: 1.5, color: C.s2 } }),
            ],
          });
          return { chart: c, dates: al.dates };
        },
      };
    },
    desc: {
      what: "比值上行 = 等权指数跑赢市值加权 = 上涨由多数成分股驱动（宽度好）；比值下行 = 指数越来越靠少数权重股撑着（宽度差）。重大顶部前常出现「指数创新高、宽度背离」。",
      how: "关注比值的中期趋势（对比 200 日均线）以及与指数的背离：指数近 3 个月上涨而比值明显下行时亮黄灯。",
      caveat: "<b>这是代理指标</b>：真实的腾落线（A/D Line）、200 日均线上方个股占比等数据没有免费公开源，此处用 RSP/SPY 近似，只能反映标普 500 内部的集中度。背离经常无疾而终——用户原话：噪音大，仅供参考。RSP 数据始于 2016（本站保留最近 10 年）。",
    },
    source: "数据：Nasdaq 官方行情 API · RSP 与 SPY 未复权收盘价（两者股息率接近，比值受分红影响很小），近 10 年。",
  },

  /* ---------- 5. VIX 期限结构 ---------- */
  {
    id: "vix_ts", group: "g2", name: "VIX 期限结构（VIX / VIX3M）", short: "VIX结构",
    subtitle: "1个月隐含波动率 ÷ 3个月隐含波动率 · 日频 · FRED: VIXCLS / VXVCLS",
    deps: ["vix", "vix3m"],
    build(S) {
      const al = alignTwo(S.vix, S.vix3m);
      const ratio = al.dates.map((_, i) => al.a[i] / al.b[i]);
      const last = ratio[ratio.length - 1];
      const vixLast = al.a[al.a.length - 1];
      const vix3mLast = al.b[al.b.length - 1];
      let level = "good", label = "期限结构正常（近月低于远月）";
      if (last >= 1) { level = "risk"; label = "倒挂（backwardation）：即期恐慌"; }
      else if (last >= 0.95) { level = "warn"; label = "接近倒挂，短期避险情绪升温"; }
      return {
        value: last.toFixed(3),
        delta: "VIX " + vixLast.toFixed(1) + " · VIX3M " + vix3mLast.toFixed(1),
        readings: [
          { label: "VIX / VIX3M", value: last.toFixed(3) },
          { label: "VIX（1个月）", value: vixLast.toFixed(2) },
          { label: "VIX3M（3个月）", value: vix3mLast.toFixed(2) },
          { label: "数据日期", value: al.dates[al.dates.length - 1], small: true },
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
      what: "正常市况下近月波动率低于远月（比值 < 1，contango）。比值升破 1（backwardation）意味着市场愿意为「现在」的保护付出比「三个月后」更高的价格——即期恐慌。",
      how: "≥ 1 为红灯。历史上比值破 1 的日子集中在 2008、2011、2015、2018、2020、2022 等压力时段。",
      caveat: "它更多是<b>同步指标</b>而非领先指标：倒挂出现时下跌通常已经发生，价值在于确认市况状态与观察恐慌消退（比值回落）。",
    },
    source: "数据：FRED · CBOE VIX（VIXCLS，1990 至今）与 3 个月波动率指数 VIX3M（VXVCLS，2007-12 至今），取两者共同交易日。",
  },

  /* ---------- 6. NFCI 金融条件 ---------- */
  {
    id: "nfci", group: "g2", name: "金融条件指数（NFCI）", short: "金融条件",
    subtitle: "芝加哥联储全国金融条件指数 · 周频 · FRED: NFCI（替代 ISM/LEI 的免费综合指标）",
    freq: "每周更新",
    deps: ["nfci"],
    build(S) {
      const { dates, values } = S.nfci;
      const last = values[values.length - 1];
      const d13 = idxOffset(values, 13);
      const chg = d13 == null ? null : last - d13;
      const chgTxt = chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(3);
      let level = "good", label = "金融条件宽松";
      if (last > 0) { level = "risk"; label = "金融条件紧于历史均值"; }
      else if (last > -0.3) { level = "warn"; label = "金融条件偏紧"; }
      return {
        value: last.toFixed(3),
        delta: "13周变化 " + chgTxt,
        readings: [
          { label: "当前 NFCI", value: last.toFixed(3) },
          { label: "13周（一季度）变化", value: chgTxt },
          { label: "数据日期", value: dates[dates.length - 1], small: true },
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
      what: "芝加哥联储用 105 个子指标（信用利差、杠杆、风险偏好、货币市场等）合成的金融条件综合指数。0 = 历史平均；正值 = 紧于均值；负值 = 松于均值。",
      how: "水平破 0 或一个季度内快速上行，通常对应融资环境收紧、风险资产逆风。",
      caveat: "<b>为什么是它</b>：你清单里的 ISM 新订单和 Conference Board LEI 都是付费专有数据，没有可靠的免费公开源；NFCI 是覆盖面最广的免费周频替代。与 ISM/LEI 一样归入「噪音大」一档——近几年这类综合指数假信号不少。",
    },
    source: "数据：FRED · Chicago Fed National Financial Conditions Index（NFCI），周频（每周三更新），1985 年至今。",
  },

  /* ---------- 7. 时间序列动量 ---------- */
  {
    id: "tsmom", group: "g3", name: "时间序列动量（趋势跟踪）", short: "时序动量",
    subtitle: "价格相对自身 12 个月前的位置 · 标普500（1975 至今）+ 多资产",
    deps: ["spx", "spy", "qqq", "tlt", "gld", "eem"],
    build(S) {
      const { dates, values } = S.spx;
      const mom = values.map((v, i) => (i >= 252 ? (v / values[i - 252] - 1) * 100 : null));
      const momDates = dates.slice(252);
      const momVals = mom.slice(252);
      const last = momVals[momVals.length - 1];
      const positive = last > 0;
      const flip = runStartDate(momDates, momVals, positive ? (v) => v > 0 : (v) => v <= 0);
      const assets = ASSETS.map(([k, name]) => {
        const v = S[k].values;
        const m = v.length > 252 ? (v[v.length - 1] / v[v.length - 253] - 1) * 100 : null;
        return { name, mom: m };
      });
      return {
        value: fmt.pctS(last),
        delta: "标普500 · 12个月动量" + (positive ? "为正" : "为负"),
        readings: [
          { label: "标普500 · 12个月动量", value: fmt.pctS(last) },
          { label: "当前状态", value: positive ? "高于12个月前（文献中的持有区）" : "低于12个月前（文献中的离场区）", small: true },
          { label: "本状态开始于", value: flip || "—", small: true },
        ],
        signal: positive
          ? { level: "good", label: "趋势向上（12个月动量为正）" }
          : { level: "risk", label: "趋势向下（12个月动量为负）" },
        spark: { values: momVals.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(momDates, { yFmt: (v) => v + "%" }),
            tooltip: mergedTooltip((v) => fmt.pctS(v)),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: polarityPair("标普500 · 12个月动量", momVals, 0, C.s1, C.critSoft,
              { markLine: markLineAt([0], (p) => p.value + "%") }),
          });
          return { chart: c, dates: momDates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title", "多资产 12 个月动量（未复权价格）"));
          const t = el("table", "aux-table",
            "<tr><th>资产</th><th>12个月动量</th><th>状态</th></tr>" +
            assets.map((a) => {
              if (a.mom == null) return `<tr><td>${a.name}</td><td class="num">—</td><td>—</td></tr>`;
              const pos = a.mom > 0;
              return `<tr><td>${a.name}</td><td class="num">${fmt.pctS(a.mom)}</td>` +
                `<td><span class="badge ${pos ? "good" : "risk"}"><span class="ico">${pos ? "●" : "■"}</span>${pos ? "动量为正" : "动量为负"}</span></td></tr>`;
            }).join(""));
          node.appendChild(t);
        },
      };
    },
    desc: {
      what: "资产价格高于自己 12 个月前 → 文献规则为持有；低于 → 离场。Moskowitz–Ooi–Pedersen (2012) 与《A Century of Evidence on Trend-Following》用 1880 年以来几十个市场验证过，整个 CTA 行业建立在此之上。",
      how: "主图为标普 500 的 12 个月滚动动量（此处以 252 个交易日近似 12 个月），零轴上下即信号切换。下表为多资产当前状态。",
      caveat: "趋势跟踪的代价是震荡市反复止损、拐点处滞后。ETF 数据为未复权价格：TLT 这类高派息资产的动量被低估约一个股息率（当前约 4%/年），信号在零轴附近时尤其要注意。",
    },
    source: "数据：Cboe · SPX 指数日线（1975 至今）；Nasdaq 行情 API · 各 ETF 未复权收盘价（近 10 年）。",
  },

  /* ---------- 8. 横截面动量 ---------- */
  {
    id: "xsmom", group: "g3", name: "横截面动量（强者恒强）", short: "截面动量",
    subtitle: "行业 12-1 动量排名 + 动量因子（MTUM）相对大盘强度",
    deps: ["mtum", "spy", ...SECTORS.map(([k]) => k)],
    build(S) {
      const al = alignTwo(S.mtum, S.spy);
      const base = al.a[0] / al.b[0];
      const rel = al.dates.map((_, i) => (al.a[i] / al.b[i]) / base * 100);
      const last = rel[rel.length - 1];
      const r252 = idxOffset(rel, 252);
      const chg = r252 == null ? null : (last / r252 - 1) * 100;
      const ranks = SECTORS.map(([k, name]) => {
        const v = S[k].values;
        const n = v.length;
        const m = n > 252 ? (v[n - 1 - 21] / v[n - 1 - 252] - 1) * 100 : null;
        return { name, mom: m };
      }).filter((r) => r.mom != null).sort((a, b) => b.mom - a.mom);
      const top3 = ranks.slice(0, 3).map((r) => r.name).join("、");
      const bot3 = ranks.slice(-3).map((r) => r.name).join("、");
      return {
        value: ranks.length ? ranks[0].name : "—",
        delta: "领涨行业（12-1 动量）",
        readings: [
          { label: "领涨行业（前3）", value: top3, small: true },
          { label: "垫底行业（后3）", value: bot3, small: true },
          { label: "MTUM/SPY 12个月变化", value: pctOr(chg) },
        ],
        signal: { level: "info", label: "信息性指标：观察轮动结构" },
        spark: { values: rel.slice(-252) },
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            ...baseAxes(al.dates, { yFmt: (v) => v }),
            tooltip: baseTooltip((v) => (v == null ? "—" : Number(v).toFixed(1))),
            grid: { left: 64, right: 20, top: 26, bottom: 62 },
            dataZoom: baseZoom(),
            series: [lineSeries("MTUM / SPY 相对强度（期初=100）", rel, C.s1)],
          });
          return { chart: c, dates: al.dates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title", "标普行业 ETF · 12-1 动量排名（过去12个月剔除最近1个月）"));
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
      what: "过去 3–12 个月的强势资产继续跑赢弱势资产。Jegadeesh & Titman (1993) 首次系统证明；Geczy & Samonov 把美股样本推到 1801 年依然成立；Asness 等《Value and Momentum Everywhere》验证其存在于全球股、债、商品、外汇。Fama 本人称动量为「最主要的异象」。",
      how: "上图：MTUM（动量因子 ETF）相对 SPY 的强度曲线，反映「买强势股」这件事本身近期是否有效。下图：行业 ETF 的 12-1 动量排名（业界标准口径：过去 12 个月收益、剔除最近 1 个月以避开短期反转）。",
      caveat: "动量有「崩溃」风险（如 2009 年3月反转时多空动量组合大幅回撤）。行业排名受股息率差异影响约 1–3 个百分点（未复权价格，公用事业等高息行业被低估）。MTUM 自 2013 年才成立，是因子的近似而非学术组合。",
    },
    source: "数据：Nasdaq 行情 API · MTUM、SPY 与 11 只 SPDR 行业 ETF（XLK/XLF/XLV/XLY/XLC/XLI/XLP/XLE/XLU/XLB/XLRE）未复权收盘价，近 10 年。",
  },

  /* ---------- 9. 200 日均线 ---------- */
  {
    id: "ma200", group: "g4", name: "200 日均线（趋势过滤器）", short: "200日线",
    subtitle: "标普500 与其 200 日移动均线 · Cboe SPX（1975 至今）",
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
      let label = above ? "价格在 200 日线上方" : "价格在 200 日线下方";
      if (Math.abs(dev) < 1) { level = "warn"; label = "紧贴 200 日线（易反复）"; }
      return {
        value: fmt.num(last, 0),
        delta: "距200日线 " + fmt.pctS(dev),
        readings: [
          { label: "标普500", value: fmt.num(last, 0) },
          { label: "200日均线", value: fmt.num(maLast, 0) },
          { label: "偏离度", value: fmt.pctS(dev) },
          { label: "当前状态开始于", value: flip || "—", small: true },
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
              lineSeries("标普500", values, C.s1),
              lineSeries("200日均线", ma, C.s2, { lineStyle: { width: 1.5, color: C.s2 } }),
            ],
          });
          return { chart: c, dates };
        },
      };
    },
    desc: {
      what: "Faber 那套 10 月均线择时的日线版本，本质是趋势跟踪的粗糙形态：长期收益与买入持有相近，但历史最大回撤大约砍半（躲过了 1974、2008 的大部分跌幅）。",
      how: "收盘价在 200 日线上方 = 趋势多头；下方 = 趋势空头。偏离度小于 ±1% 时信号极易反复。",
      caveat: "定位是<b>风控不是超额收益</b>：震荡市会反复被打脸（如 2011、2015–16），应税账户还有换手税务摩擦。",
    },
    source: "数据：Cboe · SPX 指数日收盘（1975 至今），价格指数（不含股息）。",
  },

  /* ---------- 10. 波动率管理 ---------- */
  {
    id: "volmgmt", group: "g4", name: "波动率管理（vol targeting）", short: "波动率",
    subtitle: "标普500 · 20日实现波动率（年化）与目标波动率仓位系数",
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
      let level = "good", label = "低波动状态";
      if (last > 25) { level = "risk"; label = "高波动状态"; }
      else if (last > 15) { level = "warn"; label = "中等波动状态"; }
      return {
        value: fmt.pct(last, 1),
        delta: "长期中位数 " + fmt.pct(med, 1) + " · 示例仓位系数 " + (w * 100).toFixed(0) + "%",
        readings: [
          { label: "20日实现波动率（年化）", value: fmt.pct(last, 1) },
          { label: "1975年以来中位数", value: fmt.pct(med, 1) },
          { label: "仓位系数（目标15%示例）", value: (w * 100).toFixed(0) + "%" },
        ],
        signal: { level, label },
        spark: { values: vVals.slice(-252) },
        tallChart: true,
        renderChart(node) {
          const c = echarts.init(node);
          c.setOption({
            title: [
              { text: "20日实现波动率（年化，%）", top: 8, left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
              { text: "目标波动率仓位系数 = min(1, 15% ÷ 波动率) · 公式演示", top: "56%", left: 70, textStyle: { fontSize: 12, color: C.ink2, fontWeight: 600 } },
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
              { ...lineSeries("实现波动率", vVals, C.s2), xAxisIndex: 0, yAxisIndex: 0, markLine: markLineAt([15, 25], (p) => p.value + "%") },
              { ...lineSeries("仓位系数", weight, C.s3), xAxisIndex: 1, yAxisIndex: 1, areaStyle: { color: C.s3, opacity: 0.08 } },
            ],
          });
          return { chart: c, dates: vDates };
        },
      };
    },
    desc: {
      what: "Moreira & Muir (2017)：按波动率倒数调整仓位（波动率高 → 减仓，低 → 加仓），历史上能改善夏普比率。原理是波动率有聚集性（高波动跟随高波动），而高波动期的单位风险回报更差。",
      how: "上图为 20 日实现波动率（年化）；下图为以 15% 目标波动率为例的仓位系数 min(1, 15%÷σ)。目标值 15% 只是常见示例，非推荐参数。",
      caveat: "改善的是<b>夏普，不是收益</b>——它是风控工具。快速崩盘时（如 2020-02）波动率信号天然滞后几天；频繁调仓有交易与税务成本。",
    },
    source: "数据：Cboe · SPX 指数日收盘（1975 至今）；实现波动率为过去 20 个交易日对数收益标准差年化。",
  },

  /* ---------- 11. 52 周新高 ---------- */
  {
    id: "high52", group: "g4", name: "52 周新高距离", short: "52周新高",
    subtitle: "标普500 距离滚动 52 周最高收盘的百分比 + 多资产状态",
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
      const assets = ASSETS.map(([k, name]) => {
        const v = S[k].values;
        if (v.length < 252) return { name, d: null };
        const mx = Math.max(...v.slice(-252));
        return { name, d: (v[v.length - 1] / mx - 1) * 100 };
      });
      let level = "info", label = "距新高中性区间";
      if (last >= -3) { level = "good"; label = "接近 52 周新高（动量强）"; }
      else if (last <= -20) { level = "risk"; label = "深度回撤（熊市区域）"; }
      else if (last <= -12) { level = "warn"; label = "回撤加深"; }
      return {
        value: fmt.pctS(last),
        delta: sinceHigh != null ? "距上次新高 " + sinceHigh + " 天" : "",
        readings: [
          { label: "距52周最高收盘", value: fmt.pctS(last) },
          { label: "上次触及新高", value: lastHighIdx >= 0 ? dDates[lastHighIdx] : "—", small: true },
          { label: "数据日期", value: dDates[dDates.length - 1], small: true },
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
              ...lineSeries("距52周高点", dVals, C.s1),
              areaStyle: { color: C.s1, opacity: 0.08 },
              markLine: markLineAt([-10, -20], (p) => p.value + "%"),
            }],
          });
          return { chart: c, dates: dDates };
        },
        renderAux(node) {
          node.appendChild(el("div", "aux-title", "多资产距 52 周高点"));
          const t = el("table", "aux-table",
            "<tr><th>资产</th><th>距52周高点</th><th>状态</th></tr>" +
            assets.map((a) => {
              if (a.d == null) return `<tr><td>${a.name}</td><td class="num">—</td><td>—</td></tr>`;
              const lv = a.d >= -3 ? "good" : a.d <= -20 ? "risk" : a.d <= -12 ? "warn" : "info";
              const tx = a.d >= -3 ? "接近新高" : a.d <= -20 ? "深度回撤" : a.d <= -12 ? "回撤加深" : "中性";
              return `<tr><td>${a.name}</td><td class="num">${fmt.pctS(a.d)}</td>` +
                `<td><span class="badge ${lv}"><span class="ico">${LEVEL[lv].ico}</span>${tx}</span></td></tr>`;
            }).join(""));
          node.appendChild(t);
        },
      };
    },
    desc: {
      what: "George & Hwang (2004)：接近 52 周高点的股票后续表现更好，机制被归因于锚定心理——投资者不愿在「高位」追买，导致好消息被低估、价格调整变慢。",
      how: "距高点 -3% 以内 = 动量强；跌破 -20% 是传统的熊市定义。此指标与时间序列动量高度相关，作为辅助确认使用。",
      caveat: "用户原话：「勉强算半个」——把它当作动量证据链里权重最低的一环，不要单独据此行动。",
    },
    source: "数据：Cboe · SPX（1975 至今）；多资产为 Nasdaq 行情 API 的 ETF 未复权收盘价（近 10 年）。",
  },
];

/* ================= 视图渲染 ================= */
const built = {};   // id → build() 结果
const failed = {};  // id → error

function badgeHTML(sig) {
  const L = LEVEL[sig.level];
  return `<span class="badge ${sig.level}"><span class="ico">${L.ico}</span>${sig.label}</span>`;
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
    wrap.appendChild(el("div", "nav-group-title", g.name));
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
  INDICATORS.forEach((ind) => {
    const g = GROUPS.find((x) => x.id === ind.group).name;
    const card = el("div", "card loading");
    card.id = "card-" + ind.id;
    card.innerHTML =
      `<div class="c-top"><span class="c-name">${ind.name}</span><span class="c-group">${g}</span></div>` +
      `<div class="c-value">加载中…</div><div class="c-delta"></div><div class="c-bottom"></div>`;
    card.onclick = () => { if (built[ind.id]) showDetail(ind.id); };
    cards.appendChild(card);
  });
}
function updateCard(ind) {
  const card = $("#card-" + ind.id);
  if (!card) return;
  const b = built[ind.id];
  if (!b) {
    card.classList.add("loading");
    card.querySelector(".c-value").innerHTML =
      `<span class="c-err">加载失败：${esc((failed[ind.id] || "").toString().slice(0, 80))}</span>`;
    const bot = card.querySelector(".c-bottom");
    bot.innerHTML = "";
    const btn = el("button", "retry", "重试");
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
    (b.delta || "") + (b.stale ? " · ⚠ 缓存数据" : "");
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
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
      new Date(b.updated + "T00:00:00").getDay()];
    $("#d-updated").innerHTML = "数据更新至 " + esc(b.updated) + "（" + wd + "）" +
      "（" + (ind.freq || "每日更新") + "）" +
      (b.stale ? ' <span class="warn-txt">· ⚠ 上游暂不可用，显示缓存数据</span>' : "");
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
    chartNode.innerHTML = '<div class="chart-err">图表渲染失败：' +
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
    `<h4>是什么 · 证据</h4><p>${ind.desc.what}</p>` +
    `<h4>怎么读</h4><p>${ind.desc.how}</p>` +
    `<h4>局限与注意</h4><p>${ind.desc.caveat}</p>`;
  $("#d-source").innerHTML = ind.source +
    (b.note ? ` <span class="note-flag">⚠ ${esc(b.note)}</span>` : "") +
    "<br>本页面仅为公开数据与学术文献的可视化整理，不构成任何投资建议。";
  window.scrollTo(0, 0);
}

/* ================= 启动 ================= */
function buildIndicator(ind) {
  const card = $("#card-" + ind.id);
  if (card) {
    card.classList.add("loading");
    card.querySelector(".c-value").textContent = "加载中…";
  }
  return Promise.all(ind.deps.map(loadSeries))
    .then((list) => {
      const S = {};
      ind.deps.forEach((k, i) => { S[k] = list[i]; });
      const b = ind.build(S);
      // 汇总所有依赖序列的提示与 stale 标记（缓存回退时全部指标可见，而非仅 OAS）
      const notes = new Set(list.map((s) => s.note).filter(Boolean));
      if (b.note) notes.add(b.note);
      b.note = notes.size ? [...notes].join(" ") : undefined;
      b.stale = list.some((s) => s.stale);
      // 数据更新日：取各依赖序列最后日期中最早的一个（最慢的组件截至哪天）
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
  renderNav();
  renderStrip();
  renderCardShell();
  $("#back-btn").onclick = showOverview;
  document.querySelector(".nav-overview").onclick = showOverview;

  dataMode.then((d) => {
    if (d.mode === "api") {
      $("#meta-line").innerHTML = d.meta.fred_key
        ? "本地实时模式 · FRED API key 已配置"
        : "本地实时模式 · FRED key 未配置<br>（可免费申请写入 config.json，见 README）";
    } else {
      $("#meta-line").innerHTML = "静态数据 · 版本 " + esc(d.manifest.version) +
        "<br>生成于 " + new Date(d.manifest.generated_at * 1000).toLocaleString("zh-CN");
    }
  }).catch(() => { $("#meta-line").textContent = "无法加载数据（api 与静态数据包均不可用）"; });

  // 按依赖多寡排序加载：先渲染只依赖 FRED/Cboe 的指标（快），ETF 类随后
  const order = [...INDICATORS].sort((a, b) => a.deps.length - b.deps.length);
  order.forEach((ind) => buildIndicator(ind));
}
boot();
