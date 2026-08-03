#!/usr/bin/env python3
"""全静态部署的构建脚本。

抓取全部序列（绕过 TTL，总是拉最新）→ 累积合并写回 data/cache/
→ 生成 public/data/bundle-<hash>.json 与 public/data/manifest.json。

- data/cache/ 需要提交进 git：它既是 CI 的热启动缓存，也是 ICE BofA
  滚动窗口的累积本体（历史越攒越长）。
- 任何序列既抓不到也没有缓存时构建失败（退出码 2），CI 不会用残缺
  数据覆盖线上版本。
- 单个序列抓取失败但有缓存时降级使用缓存（bundle 中标记 stale）。

用法:  FRED_API_KEY=xxx python3 build_data.py   （key 可选，见 README）
"""
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # 复用序列注册表、抓取、累积合并逻辑

OUT_DIR = os.path.join(server.PUBLIC, "data")
SITE = "https://weathertop.app"

PAGE_TMPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{site}/i/{slug}/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Weathertop 市场信号监测">
<meta property="og:title" content="{h1} — 定义、读法、证据与局限">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{site}/i/{slug}/">
<meta property="og:image" content="{site}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,&lt;svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'&gt;&lt;text y='.9em' font-size='90'&gt;📈&lt;/text&gt;&lt;/svg&gt;">
<script>try{{if(localStorage.getItem("msm-theme")==="light")document.documentElement.dataset.theme="light";}}catch(e){{}}</script>
<style>
.seo-wrap {{ max-width: 780px; margin: 0 auto; padding: 28px 20px 60px; }}
.seo-wrap .site {{ font-size: 13px; margin-bottom: 26px; }}
.seo-wrap .site a {{ color: var(--muted); text-decoration: none; }}
.seo-wrap .site a:hover {{ color: var(--ink); }}
.seo-wrap h1 {{ color: var(--ink); font-size: 26px; margin: 0 0 18px; }}
.seo-wrap h2 {{ color: var(--ink); font-size: 17px; margin: 26px 0 8px; }}
.seo-wrap p {{ color: var(--ink2); font-size: 14.5px; line-height: 1.9; margin: 8px 0; }}
.seo-cta {{ display: inline-block; margin: 26px 0 6px; background: var(--s1); color: #fff;
  padding: 10px 22px; border-radius: 9px; text-decoration: none; font-size: 14.5px; font-weight: 600; }}
.seo-rel {{ margin-top: 34px; padding-top: 14px; border-top: 1px solid var(--border); }}
.seo-rel .t {{ font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }}
.seo-rel a {{ display: inline-block; font-size: 12.5px; color: var(--ink2); text-decoration: none;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px;
  padding: 3px 11px; margin: 0 6px 6px 0; }}
.seo-rel a:hover {{ border-color: var(--muted); color: var(--ink); }}
.seo-foot {{ margin-top: 26px; font-size: 11.5px; color: var(--muted); line-height: 1.7; }}
</style>
</head>
<body>
<div class="seo-wrap">
  <div class="site"><a href="/">📈 Weathertop 市场信号监测</a> · 指标详解</div>
  <article>
    <h1>{h1}</h1>
    {body}
    <a class="seo-cta" href="/#{iid}">查看实时图表与当前信号 →</a>
  </article>
  <nav class="seo-rel"><div class="t">全部指标详解</div>{related}</nav>
  <div class="seo-foot">本页面为公开数据与学术文献结论的整理，仅供研究参考，不构成任何投资建议。数据每日自动更新，实时读数见<a href="/" style="color:var(--muted)">主面板</a>。</div>
</div>
</body>
</html>
"""


def generate_seo_pages():
    """从 seo_content.json 生成每指标静态详解页 + sitemap.xml。"""
    with open(os.path.join(server.ROOT, "seo_content.json")) as f:
        content = json.load(f)
    appjs = open(os.path.join(server.PUBLIC, "app.js")).read()
    today = time.strftime("%Y-%m-%d")
    urls = [(SITE + "/", today)]
    rel_all = "".join('<a href="/i/%s/">%s</a>' % (c["slug"], c["h1"])
                      for c in content.values())
    for iid, c in content.items():
        # slug 一致性检查：app.js 的 SLUGS 表漂移时让构建失败而非静默错链
        if '"%s"' % c["slug"] not in appjs:
            raise SystemExit("slug 不一致：app.js 中找不到 %s（%s）" % (c["slug"], iid))
        body = ""
        for sec in c["sections"]:
            body += "<h2>%s</h2>" % sec["h"]
            body += "".join("<p>%s</p>" % p for p in sec["p"])
        page_dir = os.path.join(server.PUBLIC, "i", c["slug"])
        os.makedirs(page_dir, exist_ok=True)
        with open(os.path.join(page_dir, "index.html"), "w") as f:
            f.write(PAGE_TMPL.format(site=SITE, slug=c["slug"], iid=iid,
                                     title=c["title"], desc=c["desc"], h1=c["h1"],
                                     body=body, related=rel_all))
        urls.append((SITE + "/i/" + c["slug"] + "/", today))
    with open(os.path.join(server.PUBLIC, "sitemap.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u, d in urls:
            f.write("  <url><loc>%s</loc><lastmod>%s</lastmod></url>\n" % (u, d))
        f.write("</urlset>\n")
    print("SEO: 生成 %d 个详解页 + sitemap.xml" % (len(urls) - 1))


def build_one(key):
    """总是尝试新抓；失败回退缓存。返回 (data, stale)。"""
    path = os.path.join(server.CACHE_DIR, key + ".json")
    cached = None
    if os.path.exists(path):
        try:
            with open(path) as f:
                cached = json.load(f)
        except Exception:
            cached = None
    try:
        data = server.fetch_series(key)
        if server.SERIES[key].get("accumulate") and cached and cached.get("dates"):
            data = server.merge_accumulated(cached, data)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return data, False
    except Exception as e:
        if cached:
            print("  ⚠ %s 刷新失败，使用缓存（%s）" % (key, e))
            return cached, True
        raise


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    series_out, failed = {}, []
    for key in sorted(server.SERIES):
        try:
            data, stale = build_one(key)
        except Exception as e:
            failed.append((key, str(e)))
            print("  ✗ %s 无数据: %s" % (key, e))
            continue
        entry = {k: data[k] for k in
                 ("dates", "values", "note", "source", "source_id", "fetched_at",
                  "neutral", "bearish")
                 if k in data}
        if stale:
            entry["stale"] = True
        series_out[key] = entry
        print("  ✓ %-8s %5d 行  %s → %s%s" % (
            key, len(data["dates"]), data["dates"][0], data["dates"][-1],
            "  (stale)" if stale else ""))

    if failed:
        print("\n构建失败：%d 个序列既抓不到也无缓存: %s"
              % (len(failed), ", ".join(k for k, _ in failed)))
        sys.exit(2)

    bundle = {
        "version": max(e["dates"][-1] for e in series_out.values()),
        "generated_at": int(time.time()),
        "series": series_out,
    }
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:10]
    fname = "bundle-%s.json" % digest

    # 清掉旧 bundle（git 历史仍保留），写新 bundle + manifest
    for old in os.listdir(OUT_DIR):
        if old.startswith("bundle-") and old.endswith(".json") and old != fname:
            os.remove(os.path.join(OUT_DIR, old))
    with open(os.path.join(OUT_DIR, fname), "w") as f:
        f.write(payload)
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump({"version": bundle["version"], "file": fname,
                   "generated_at": bundle["generated_at"]}, f)

    print("\n完成: public/data/%s (%.0f KB), 数据版本 %s"
          % (fname, len(payload) / 1024, bundle["version"]))
    generate_seo_pages()


if __name__ == "__main__":
    main()
