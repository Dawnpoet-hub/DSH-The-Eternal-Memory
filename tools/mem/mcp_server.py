#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mcp_server —— 标准输入输出上的 MCP 服务（JSON-RPC 2.0，无第三方依赖）

接入方式（DSH 的 MCP 客户端插件）：
  command: python3
  args:    ["<workspace>/tools/mem/mcp_server.py"]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import WS, build, connect  # noqa: E402
import core as _core  # noqa: E402
import search as S  # noqa: E402

PROTOCOL = "2024-11-05"

TOOLS = [
    {
        "name": "mem_search",
        "description": "在本地记忆库中搜索（全文 + 向量 + 图谱混合排序），返回笔记与具体观察。",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer"},
                           "project": {"type": "string", "description": "只在这个项目里搜索（省略=全部）"}},
            "required": ["query"],
        },
    },
    {
        "name": "mem_context",
        "description": "获取某个查询的压缩上下文块（笔记标题 + 命中的观察），适合直接放进提示词。",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "top": {"type": "integer"},
                           "project": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "mem_related",
        "description": "沿 [[关系]] 查找与某篇笔记关联的其他笔记。",
        "inputSchema": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "depth": {"type": "integer"}},
            "required": ["title"],
        },
    },
    {
        "name": "mem_write_note",
        "description": "在记忆库中创建或追加一篇笔记。content 为 Markdown 正文。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "type": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "content": {"type": "string"},
                "append": {"type": "boolean"},
            },
            "required": ["title", "content"],
        },
    },
    {
        "name": "mem_read_note",
        "description": "按标题或路径读取一篇笔记的全文。",
        "inputSchema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    },
    {
        "name": "mem_recent",
        "description": "列出最近修改的笔记。",
        "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}},
    },
    {
        "name": "mem_reindex",
        "description": "重建索引（笔记文件被外部修改后调用）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "mem_schema",
        "description": "查看或校验记忆库的结构：infer 推断各类型应有哪些字段与观察类别；validate 找出不合规的笔记；diff 对比声明式 schema 与推断结果。",
        "inputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string", "enum": ["infer", "validate", "diff"]}},
        },
    },
]

# MCP 工具行为标注：agent 据此判断能否并发、能否重试、是否破坏数据
_ANNOTATIONS = {
    "mem_search":     {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_context":    {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_related":    {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_read_note":  {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_recent":     {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_schema":     {"readOnlyHint": True,  "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
    "mem_write_note": {"readOnlyHint": False, "destructiveHint": True,  "idempotentHint": False, "openWorldHint": False},
    "mem_reindex":    {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True,  "openWorldHint": False},
}
for _t in TOOLS:
    _t["annotations"] = _ANNOTATIONS.get(_t["name"], {"openWorldHint": False})


def _slug(title):
    s = "".join(c if c.isalnum() or c in "-_" else "-" for c in title.lower())
    return "-".join(filter(None, s.split("-")))[:60] or "note"


def write_note(title, content, type_="note", tags=None, append=False, project="main"):
    roots = {n: r for n, r in _core.load_projects()}
    d = roots.get(project or "main") or (WS / "memory")
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{_slug(title)}.md"
    if append and path.exists():
        old = path.read_text(encoding="utf-8").rstrip()
        path.write_text(old + "\n" + content.strip() + "\n", encoding="utf-8")
    else:
        fm = ["---", f"title: {title}", f"type: {type_}"]
        if tags:
            fm.append("tags: [" + ", ".join(tags) + "]")
        fm.append("---")
        path.write_text("\n".join(fm) + "\n" + content.strip() + "\n", encoding="utf-8")
    build(verbose=False, rebuild=False)
    return str(path.relative_to(WS))


def read_note(title):
    db = connect()
    try:
        r = db.execute("SELECT path FROM notes WHERE title=? OR permalink=? OR path LIKE ?",
                       (title, title, f"%{title}%")).fetchone()
    finally:
        db.close()
    if not r:
        return None
    p = WS / r[0]
    return p.read_text(encoding="utf-8") if p.exists() else None


def call_tool(name, args):
    if name == "mem_search":
        return S.search(args["query"], int(args.get("limit") or 8), project=args.get("project"))
    if name == "mem_context":
        return S.context(args["query"], int(args.get("top") or 3), project=args.get("project"))
    if name == "mem_related":
        return S.related(args["title"], int(args.get("depth") or 1))
    if name == "mem_write_note":
        return write_note(args["title"], args["content"], args.get("type", "note"),
                          args.get("tags"), bool(args.get("append")), args.get("project", "main"))
    if name == "mem_read_note":
        return read_note(args["title"]) or "（未找到）"
    if name == "mem_schema":
        import schema as _schema
        action = args.get("action") or "infer"
        if action == "validate":
            return _schema.report("validate")
        if action == "diff":
            return _schema.report("diff")
        return _schema.report("infer")
    if name == "mem_recent":
        db = connect()
        try:
            rows = db.execute("SELECT title, path, mtime FROM notes ORDER BY mtime DESC LIMIT ?",
                              (int(args.get("limit") or 10),)).fetchall()
        finally:
            db.close()
        return [{"title": r[0], "path": r[1]} for r in rows]
    if name == "mem_reindex":
        return build(verbose=False)
    raise ValueError(f"unknown tool: {name}")


def handle(req):
    method, rid, params = req.get("method"), req.get("id"), req.get("params") or {}
    if method == "initialize":
        res = {"protocolVersion": PROTOCOL,
               "capabilities": {"tools": {}},
               "serverInfo": {"name": "local-mem", "version": "2.0.0"}}
    elif method == "tools/list":
        res = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            out = call_tool(params.get("name"), params.get("arguments") or {})
            text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, indent=1)
            res = {"content": [{"type": "text", "text": text}]}
        except Exception as e:  # noqa: BLE001
            res = {"content": [{"type": "text", "text": f"错误：{e}"}], "isError": True}
    elif method == "ping":
        res = {}
    else:
        if rid is None:
            return None  # 通知，不响应
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}}
    if rid is None:
        return None
    return {"jsonrpc": "2.0", "id": rid, "result": res}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
