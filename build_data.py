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


if __name__ == "__main__":
    main()
