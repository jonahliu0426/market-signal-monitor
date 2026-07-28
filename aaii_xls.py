"""AAII 情绪调查 .xls 的最小化纯标准库解析器。

sentiment.xls 是老式二进制 Excel（CFB 容器 + BIFF8 记录流）。系统 Python 3.9
没有 xlrd，本模块只实现读取数字单元格所需的最小子集：
  CFB: 头 → DIFAT → FAT → 目录 → 提取 "Workbook" 流
  BIFF8: BOUNDSHEET 定位 "SENTIMENT" 表 → NUMBER / RK / MULRK / FORMULA 记录

解析结果经过多重校验（见 parse_sentiment 尾部）；任何一步失手都抛异常，
由上层回退到缓存，绝不返回可疑数据。
（开发时用已知历史极值验证：2009-03-05 看空 70.27%。）
"""
import struct
from datetime import date, timedelta

_EPOCH = date(1899, 12, 30)  # Excel 日期序列号纪元（1900 体系）


def _read_workbook_stream(data):
    if data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise ValueError("不是 CFB(.xls) 文件——AAII 可能改了格式或返回了错误页")
    sector = 1 << struct.unpack_from("<H", data, 30)[0]
    ints_per_sector = sector // 4
    num_fat = struct.unpack_from("<I", data, 44)[0]
    dir_start = struct.unpack_from("<I", data, 48)[0]
    difat_ext = struct.unpack_from("<I", data, 68)[0]
    difat = list(struct.unpack_from("<109I", data, 76))
    while difat_ext not in (0xFFFFFFFE, 0xFFFFFFFF):  # 大文件的扩展 DIFAT
        off = 512 + difat_ext * sector
        chunk = struct.unpack_from("<%dI" % ints_per_sector, data, off)
        difat.extend(chunk[:-1])
        difat_ext = chunk[-1]
    fat = []
    for s in [x for x in difat if x not in (0xFFFFFFFE, 0xFFFFFFFF)][:num_fat]:
        fat.extend(struct.unpack_from("<%dI" % ints_per_sector, data, 512 + s * sector))

    def chain(start, limit=None):
        out, s, seen = [], start, set()
        while s not in (0xFFFFFFFE, 0xFFFFFFFF):
            if s in seen or s >= len(fat):
                raise ValueError("CFB FAT 链损坏")
            seen.add(s)
            out.append(data[512 + s * sector: 512 + (s + 1) * sector])
            s = fat[s]
        blob = b"".join(out)
        return blob[:limit] if limit else blob

    dirdata = chain(dir_start)
    for i in range(0, len(dirdata) - 127, 128):
        e = dirdata[i:i + 128]
        nlen = struct.unpack_from("<H", e, 64)[0]
        if not nlen:
            continue
        name = e[:max(0, nlen - 2)].decode("utf-16-le", errors="replace")
        if name in ("Workbook", "Book"):
            start = struct.unpack_from("<I", e, 116)[0]
            size = struct.unpack_from("<I", e, 120)[0]
            if size < 4096:
                raise ValueError("Workbook 流过小（mini-stream 未实现）")
            return chain(start, size)
    raise ValueError("CFB 中找不到 Workbook 流")


def _decode_rk(rk):
    if rk & 2:
        v = rk >> 2
        if v & 0x20000000:
            v -= 0x40000000
        val = float(v)
    else:
        val = struct.unpack("<d", b"\0\0\0\0" + struct.pack("<I", rk & 0xFFFFFFFC))[0]
    return val / 100 if rk & 1 else val


def _sheet_cells(wb, sheet_name):
    """返回指定工作表的 {(row, col): float}（仅数字单元格）。"""
    pos, target = 0, None
    while pos + 4 <= len(wb):
        rid, rlen = struct.unpack_from("<HH", wb, pos)
        body = wb[pos + 4: pos + 4 + rlen]
        pos += 4 + rlen
        if rid == 0x85:  # BOUNDSHEET
            bof = struct.unpack_from("<I", body, 0)[0]
            nlen, flags = body[6], body[7]
            name = (body[8:8 + nlen * 2].decode("utf-16-le", errors="replace")
                    if flags & 1 else body[8:8 + nlen].decode("latin-1"))
            if name.strip().upper() == sheet_name:
                target = bof
    if target is None:
        raise ValueError("找不到工作表 %s" % sheet_name)

    cells, pos, bof_seen = {}, target, 0
    while pos + 4 <= len(wb):
        rid, rlen = struct.unpack_from("<HH", wb, pos)
        body = wb[pos + 4: pos + 4 + rlen]
        pos += 4 + rlen
        if rid == 0x809:  # BOF
            bof_seen += 1
            if bof_seen > 1:
                break
            continue
        if rid == 0x0A:  # EOF
            break
        if rid == 0x203 and len(body) >= 14:  # NUMBER
            r, c = struct.unpack_from("<HH", body, 0)
            cells[(r, c)] = struct.unpack_from("<d", body, 6)[0]
        elif rid == 0x27E and len(body) >= 10:  # RK
            r, c = struct.unpack_from("<HH", body, 0)
            cells[(r, c)] = _decode_rk(struct.unpack_from("<I", body, 6)[0])
        elif rid == 0xBD and len(body) >= 12:  # MULRK
            r, c0 = struct.unpack_from("<HH", body, 0)
            for k in range((len(body) - 6) // 6):
                rk = struct.unpack_from("<I", body, 4 + k * 6 + 2)[0]
                cells[(r, c0 + k)] = _decode_rk(rk)
        elif rid == 0x06 and len(body) >= 14:  # FORMULA（数字结果缓存）
            r, c = struct.unpack_from("<HH", body, 0)
            if body[12:14] != b"\xff\xff":
                cells[(r, c)] = struct.unpack_from("<d", body, 6)[0]
    return cells


def parse_sentiment(data):
    """解析 AAII sentiment.xls → (dates, bull, neutral, bear)，百分比 0-100。"""
    cells = _sheet_cells(_read_workbook_stream(data), "SENTIMENT")
    lo = (date(1987, 1, 1) - _EPOCH).days
    hi = (date.today() + timedelta(days=7) - _EPOCH).days
    rows = []
    for (r, c), v in cells.items():
        if c == 0 and lo <= v <= hi and abs(v - round(v)) < 1e-6:
            b, n, br = cells.get((r, 1)), cells.get((r, 2)), cells.get((r, 3))
            if b is None or n is None or br is None:
                continue  # 早期数周缺分项，跳过
            if not (0 <= b <= 1.001 and 0 <= n <= 1.001 and 0 <= br <= 1.001):
                continue
            if not 0.97 <= b + n + br <= 1.03:
                continue  # 三项之和必须≈100%
            rows.append(((_EPOCH + timedelta(days=int(round(v)))).isoformat(),
                         round(b * 100, 2), round(n * 100, 2), round(br * 100, 2)))
    rows.sort()
    dedup = {d: (b, n, br) for d, b, n, br in rows}  # 同日取最后一条
    dates = sorted(dedup)

    # ---- 整体校验：任何一条不满足都视为解析失败 ----
    if len(dates) < 1500:
        raise ValueError("AAII 解析行数异常（%d 行），疑似格式变化" % len(dates))
    if dates[0] > "1988-01-01":
        raise ValueError("AAII 起始日期异常: %s" % dates[0])
    if (date.today() - date.fromisoformat(dates[-1])).days > 30:
        raise ValueError("AAII 最新数据过旧: %s" % dates[-1])
    anchor = dedup.get("2009-03-05")
    if anchor and abs(anchor[2] - 70.27) > 0.1:
        raise ValueError("AAII 历史锚点校验失败: %s" % (anchor,))

    bull = [dedup[d][0] for d in dates]
    neutral = [dedup[d][1] for d in dates]
    bear = [dedup[d][2] for d in dates]
    return dates, bull, neutral, bear
