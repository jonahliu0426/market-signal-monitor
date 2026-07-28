"""新式 .xlsx 的最小化纯标准库解析器（zipfile + ElementTree）。

只做一件事：把第一张工作表读成 [{列字母: 值}] 的列表。
- 数字单元格 → float
- 共享字符串 / 内联字符串 → str
供 NAAIM（日期为 Excel 序列号）与 FINRA（日期为 "YYYY-MM" 字符串）共用。
"""
import io
import zipfile
from xml.etree import ElementTree as ET

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def rows(data, sheet="xl/worksheets/sheet1.xml"):
    """返回 [ {列字母: float|str}, ... ]，按行顺序。解析失败抛异常。"""
    z = zipfile.ZipFile(io.BytesIO(data))
    try:
        shared = ["".join(t.text or "" for t in e.iter("{%s}t" % _NS["m"]))
                  for e in ET.fromstring(z.read("xl/sharedStrings.xml"))]
    except KeyError:
        shared = []
    root = ET.fromstring(z.read(sheet))
    out = []
    for row in root.findall(".//m:row", _NS):
        cells = {}
        for c in row.findall("m:c", _NS):
            ref = c.get("r") or ""
            col = "".join(ch for ch in ref if ch.isalpha())
            t = c.get("t")
            if t == "inlineStr":
                cells[col] = "".join(x.text or "" for x in c.iter("{%s}t" % _NS["m"]))
                continue
            v = c.findtext("m:v", None, _NS)
            if v is None:
                continue
            if t == "s":
                cells[col] = shared[int(v)]
            elif t == "str":
                cells[col] = v
            else:
                try:
                    cells[col] = float(v)
                except ValueError:
                    cells[col] = v
        if cells:
            out.append(cells)
    return out
