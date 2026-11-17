# -*- coding: utf-8 -*-
"""verify —— 核验一条记忆观察里引用的字面值现在还成不成立

只回答一个问题：**这条事实引用的东西，此刻还在不在？**
不回答"结论对不对"——引用还在，结论仍可能过期。措辞必须守住这条线。

分档（P1 只做前两档）：
  ✅ 已核验   所有可核验字面值全部命中
  🔗 可追溯   没有可核验字面值，或只命中一部分，或没命中

第三个档（⚠️ 与现状不符）留给 P2，需要冲突检测配合。

成本控制：源码树做成一份 haystack 缓存（TTL 300s），字面值在内存里做子串扫描。
"""

import os
import re
import time

import core

TICK = re.compile(r"`([^`\n]{2,60})`")
PATHL = re.compile(
    r"(?:\.{0,2}/)?(?:[\w\-]+/)+[\w\-.]+|[\w\-]+\.(?:py|js|mjs|json|md|html|css|yml|yaml|ts|tsx)\b"
)
HEX = re.compile(r"#[0-9A-Fa-f]{6}\b")
PCT = re.compile(r"\b\d{1,3}(?:\.\d+)?%")   # 百分比结论：60%/29.1%

MIN_LIT = 4          # 太短的字面值假阳性高，不核
MAX_FILE = 512 * 1024  # 超过这个大小的文件不进 haystack
TTL = 300            # haystack 缓存秒数

_cache = {"built": 0.0, "files": [], "index": {}}

_SKIP_DIRS = {"node_modules", ".git", ".mem", ".venv", "dist", ".pnpm-store", ".tmp", "__pycache__"}
_EXTS = {".py", ".js", ".mjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".ts", ".tsx"}


def _roots():
    ws = core.WS
    return [ws / "tools" / "mem", ws / "dsh-bundles", ws]


def _build():
    """把源码树读成 (相对路径, 内容) 列表。memory/ 不进 haystack，避免自证。"""
    files, index, by_name = [], {}, {}
    seen = set()
    ws = core.WS
    for root in _roots():
        if not root.exists():
            continue
        shallow = (root == ws)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            p = os.path.join(dirpath, "")
            if shallow and os.path.relpath(dirpath, ws).count(os.sep) >= 1:
                dirnames[:] = []
                continue
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() not in _EXTS:
                    continue
                full = os.path.join(dirpath, fn)
                if full in seen:
                    continue
                seen.add(full)
                try:
                    if os.path.getsize(full) > MAX_FILE:
                        continue
                    with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                        text = fh.read()
                except OSError:
                    continue
                rel = os.path.relpath(full, ws)
                if rel.startswith("memory" + os.sep):
                    continue
                files.append((rel, text))
                index[rel] = text
                by_name.setdefault(os.path.basename(rel), rel)
    return files, index, by_name


def _haystack():
    now = time.time()
    if now - _cache["built"] < TTL and _cache["files"]:
        return _cache
    files, index, by_name = _build()
    _cache.update({"built": now, "files": files, "index": index, "by_name": by_name})
    return _cache


_CJK = re.compile(r"[\u4e00-\u9fff]")
_EXT = re.compile(r"\.(py|js|mjs|json|md|html|css|yml|yaml|ts|tsx)$")
## 不可核验的类型：日期、@scope 包名（需要 node_modules 才能查，且常已删除）
_DATEISH = re.compile(r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$")
_SCOPED = re.compile(r"^@[\w\-]+/[\w\-.]+$")
## 正文里裸写的代码 token：函数调用、camelCase、snake_case、全大写常量
_BARE_CODE = re.compile(
    r"\b(?:[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+"      # fs.existsSync / a.b.c
    r"|[a-z]+[A-Z][A-Za-z0-9]*"                               # pythonAvailable
    r"|[a-z][a-z0-9]*_[a-z0-9_]+"                             # mem_search
    r"|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b"                           # MAX_ITEMS（必须带下划线）
)


def _codeish(v):
    """只有像代码/路径/配置名的才值得核验。

    中文文案（`首页[易用性]`）、普通英文词（`get`）、带空格的路径碎片一律排除——
    它们核不到并不代表事实过期，只会把 ✅ 拉低成假阴性。
    """
    if len(v) < MIN_LIT or len(v) > 200:
        return False
    if _CJK.search(v) or " " in v or "\t" in v:
        return False
    if _DATEISH.match(v) or _SCOPED.match(v):
        return False
    if _EXT.search(v):
        return True
    if "/" in v or "\\" in v:
        # 要求末段像文件名（带扩展名）或有 3 段以上，避免把 ".../ANONA" 这类
        # 被空格截断的路径片段当成可核验项
        return bool(_EXT.search(v)) or v.count("/") >= 3
    # camelCase / snake_case / ALL_CAPS / 带 . - @ : # 的配置名
    return bool(re.search(r"[a-z][A-Z]|[A-Z]{2}|_|\.|@|:|#|-", v))


def literals(text):
    """抽出**高置信**可核验字面值：[(kind, value)]，去重且保序。"""
    out, seen = [], set()

    def add(kind, val):
        v = (val or "").strip().strip("`'\"。，、；：")
        # 百分比只有 3 字符（60%），不受 MIN_LIT 限制
        if kind == "pct":
            if len(v) < 3 or v in seen:
                return
            seen.add(v)
            out.append((kind, v))
            return
        if not _codeish(v) or v in seen:
            return
        seen.add(v)
        out.append((kind, v))

    for m in TICK.finditer(text or ""):
        inner = m.group(1).strip()
        # 反引号里可能是路径、符号、色值、命令
        if "/" in inner or PATHL.fullmatch(inner):
            add("path", inner)
        else:
            add("sym", inner)
    for m in HEX.finditer(text or ""):
        add("hex", m.group(0))
    for m in PCT.finditer(text or ""):
        add("pct", m.group(0))
    for m in PATHL.finditer(text or ""):
        add("path", m.group(0))
    for m in _BARE_CODE.finditer(text or ""):
        add("sym", m.group(0))
    # 去掉被更长字面值包含的碎片：路径里已经含有 america.md，不该再核一次
    out = [(k, v) for k, v in out
           if not any(v != w and v in w for _, w in out)]
    return out[:6]


def _check_one(kind, value, hs):
    """返回 (found, where)。"""
    ws = core.WS
    if kind == "path":
        try:
            direct = ws / value
            if direct.is_file():
                return True, value
        except OSError:
            pass
        base = os.path.basename(value.rstrip("/"))
        rel = hs["by_name"].get(base)
        if rel:
            return True, rel
        # 兜底：只接受相对模式；绝对路径/怪模式一律跳过，
        # 绝不整树 rglob（那会慢到不可用）
        try:
            if not os.path.isabs(value):
                for c in ws.glob(value):
                    if c.is_file():
                        return True, str(c)
        except (OSError, ValueError, NotImplementedError):
            pass
        return False, ""
    # sym / hex：在 haystack 里找
    for rel, text in hs["files"]:
        if value in text:
            return True, rel
    return False, ""


def check(text):
    """返回 {level, total, ok, items}。level ∈ {'ok','trace'}"""
    lits = literals(text)
    if not lits:
        return {"level": "trace", "total": 0, "ok": 0, "items": []}
    hs = _haystack()
    items = []
    ok = 0
    for kind, val in lits:
        found, where = _check_one(kind, val, hs)
        if found:
            ok += 1
        items.append({"kind": kind, "value": val, "found": found, "where": where})
    level = "ok" if ok == len(lits) else "trace"
    return {"level": level, "total": len(lits), "ok": ok, "items": items}


def mark(text):
    """只给标记，不解释。"""
    return "✅" if check(text)["level"] == "ok" else "🔗"
