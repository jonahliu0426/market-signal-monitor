# 市场信号监测（Market Signal Monitor）

本地运行的宏观 & 市场信号面板：17 个指标（11 个有实证文献支持 + 6 个明示
"证据弱、仅参考"的情绪/仓位温度计），每个指标都有
趋势图（1月 / 3月 / 6月 / 1年 / 3年 / 5年 / 10年 / 全部，支持任意拖拽缩放时间窗口）、
当前读数、红黄绿信号与「证据 · 怎么读 · 局限」说明。

## 运行

零第三方依赖（Python 标准库 + 本地 ECharts），直接启动：

```bash
python3 server.py
```

打开 http://127.0.0.1:8967 即可。首次加载需抓取远端数据（约 10 秒），
之后走本地磁盘缓存（`data/cache/`，6 小时过期；刷新失败时自动回退旧缓存）。

## 指标清单

| 分组 | 指标 | 数据源 | 历史深度 |
|---|---|---|---|
| 宏观 · 证据较扎实 | 高收益债信用利差 OAS | FRED `BAMLH0A0HYM2` | 3 年（配 key 后 1996 至今） |
| | 收益率曲线 10Y−3M | FRED `T10Y3M` | 1982 至今 |
| | 初请失业金（含4周均线） | FRED `ICSA` | 1980 至今 |
| 宏观 · 噪音大 | 市场宽度代理 RSP/SPY | Nasdaq 行情 API | 近 10 年 |
| | VIX 期限结构 VIX/VIX3M | FRED `VIXCLS`/`VXVCLS` | 2007-12 至今 |
| | 金融条件指数 NFCI | FRED `NFCI` | 1985 至今 |
| 市场 · 动量 | 时间序列动量（12个月） | Cboe SPX + Nasdaq ETF | 1975 至今 |
| | 横截面动量（行业12-1 + MTUM/SPY） | Nasdaq 行情 API | 近 10 年 |
| 市场 · 风控 | 200 日均线 | Cboe SPX | 1975 至今 |
| | 波动率管理（20日实现波动率） | Cboe SPX | 1975 至今 |
| | 52 周新高距离 | Cboe SPX + Nasdaq ETF | 1975 至今 |
| 情绪与仓位 · 仅参考 | AAII 散户情绪调查（看多/中性/看空） | AAII 官方 sentiment.xls | 1987 至今 |
| | 标普期货投机者净头寸（COT） | CFTC 官方公开 API | 1997 至今 |
| | 密歇根消费者信心 | FRED `UMCSENT` | 1952 至今 |
| | NAAIM 主动管理人股票敞口 | NAAIM 官方周度文件 | 2006 至今 |
| | Cboe SKEW（尾部风险定价） | Cboe 官方日线 CSV | 1990 至今 |
| | FINRA 融资余额（含同比增速） | FINRA 官方月度文件 | 1997 至今 |

## 关于数据源的三点说明（重要）

1. **信用利差只有 3 年历史？** 这是 FRED 与 ICE 的数据授权限制：ICE BofA 系列
   （BAML*）只发布最近 3 年的滚动窗口，**官方 API 同样受限**（系列元数据的
   observation_start 即为 3 年前）。作为补救，本站对该序列做**滚动累积**：每次
   刷新把新窗口合并进 `data/cache/hy_oas.json` 而非覆盖，超出窗口的早期数据永久
   保留——运行越久，可回看的历史越长（请勿删除该缓存文件，它就是你的积累）。

   仍建议配置一个免费的 FRED API key（https://fredaccount.stlouisfed.org/apikeys）：
   所有 FRED 序列会改走更稳定的官方接口，绕开网页 CSV 通道容易误伤的 CDN 风控。
   二选一：
   ```bash
   export FRED_API_KEY=你的key && python3 server.py
   ```
   或在项目根目录建 `config.json`：
   ```json
   { "fred_api_key": "你的key" }
   ```

2. **为什么没有 ISM 新订单 / Conference Board LEI？** 两者均为付费专有数据，
   无可靠免费源。面板用芝加哥联储 NFCI（105 个子指标的周频金融条件综合指数）
   作为同档（噪音大、仅参考）的免费替代。

3. **ETF 价格未复权。** Nasdaq 行情 API 提供的是未复权收盘价：高派息资产
   （TLT 等）的 12 个月动量会被低估约一个股息率；行业动量排名同样受股息率差异
   影响 1–3 个百分点。涉及页面均有标注。真实的市场宽度数据（腾落线、200日均线
   上方个股占比）无免费源，面板用 RSP/SPY 等权比值近似并明确标注为代理。

## 图表交互

- 预设窗口：1月 / 3月 / 6月 / 1年 / 3年 / 5年 / 10年 / 全部
- 图内**拖拽**平移时间窗口；**Ctrl+滚轮**（或触控板双指捏合）缩放
- 图下方的缩略滑块可任意拖动两端手柄或整段窗口
- 十字光标 + 悬浮提示显示任意时点的精确数值

## 故障排查

- **个别指标显示「加载失败」**：多为上游临时限流，点卡片上的「重试」即可
  （会一并重试所有失败项）。服务器对上游做了串行限速 + 失败退避（3 分钟），
  且刷新失败时自动回退到上次成功的缓存（卡片会标注「⚠ 缓存数据」）。
- **FRED 全部失败**：FRED 的 CDN 风控偶尔会封 IP 约 10–20 分钟，等待后重试。
- 缓存位于 `data/cache/`，删除对应 json 文件可强制重新抓取。

## 部署到 HTTPS（全静态方案）

架构：GitHub Actions 每天定时（北京 07:30 / 09:30）运行 `build_data.py` 抓取
全部序列 → 生成 `public/data/bundle-<哈希>.json`（约 1.9MB，gzip 后约 410KB）
和 100 字节的 `manifest.json` → 部署 `public/` 到 GitHub Pages。

前端自动识别模式：本地有 server.py 就走实时 API；部署环境无 API 则读静态
bundle。manifest 不缓存（每次打开都检查是否有新版本），bundle 文件名含内容
哈希、被浏览器永久缓存——**数据没更新时回头客零下载，秒开**。

首次部署步骤：

1. 建一个 GitHub 仓库并推送本项目（`config.json` 已被 .gitignore 排除，不会泄漏）；
2. 仓库 Settings → Secrets and variables → Actions → 新建 secret：
   `FRED_API_KEY` = 你的 key；
3. Settings → Pages → Source 选 **GitHub Actions**；
4. Actions 页面手动跑一次 `build-and-deploy`（或等定时触发）。

说明：
- 工作流每次会把累积后的 `data/cache/` 提交回仓库——这既是 CI 的热启动缓存，
  也让 ICE BofA 的滚动累积在 git 历史里永久可溯。
- **首次运行务必检查 Actions 日志**：GitHub 的运行器是数据中心 IP，个别数据源
  （尤其 api.nasdaq.com）可能对云端 IP 更严格。若 Nasdaq 在 CI 中被拒，备选
  方案是在本机跑 `python3 build_data.py` 后 `git push`（可配 launchd 定时），
  流水线的其余部分完全一样。
- 公开站点请留意数据再分发条款（见上文第 1 点，ICE 系列尤甚）；小范围使用
  建议加访问控制（如 Cloudflare Access）。

## 免责声明

本项目仅为公开数据与学术文献结论的可视化整理，供研究参考，不构成任何投资建议。
