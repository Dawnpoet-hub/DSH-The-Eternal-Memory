#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mem —— 本地 Markdown 记忆库命令行

功能对齐 Basic Memory（六层：格式/解析/索引/同步/检索/接口），
全部本地、无第三方依赖。MCP 接口见 mcp_server.py。

用法：
  python3 tools/mem/mem.py index [--update]     建索引（默认全量，--update 增量）
  python3 tools/mem/mem.py search "关键词"       混合检索
  python3 tools/mem/mem.py context "关键词"      压缩上下文
  python3 tools/mem/mem.py related "笔记标题"    沿关系查关联
  python3 tools/mem/mem.py recent               最近修改
  python3 tools/mem/mem.py list                 列出全部笔记（供面板用）
  python3 tools/mem/mem.py doctor               体检：格式、失效引用、未整理
  python3 tools/mem/mem.py stats                统计
  python3 tools/mem/mem.py watch                轮询监听变化（Ctrl-C 退出）
  python3 tools/mem/mem.py mcp                  以 MCP 服务方式启动

加 --json 输出机器可读结果（面板插件使用）。
"""
import argparse
import json as jsonlib
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402
import search as S  # noqa: E402


def _ts(v):
    """支持 2026-11-01 / 2026-11-01 12:00 / 7d / 30d。"""
    import datetime
    if not v:
        return None
    if v.endswith("d") and v[:-1].isdigit():
        return (datetime.datetime.now() - datetime.timedelta(days=int(v[:-1]))).timestamp()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(v, fmt).timestamp()
        except ValueError:
            continue
    raise SystemExit(f"时间格式不对：{v}（用 2026-11-01 或 7d）")


def _indexable(path):
    """frontmatter 写了 index: false 的说明类文件不进面板列表。"""
    try:
        head = path.read_text(encoding="utf-8", errors="ignore")[:400]
    except OSError:
        return False
    m = re.search(r"^index:\s*(false|0|no)\s*$", head, re.M | re.I)
    return not m


def _emit(data, as_json, text_fn):
    if as_json:
        print(jsonlib.dumps(data, ensure_ascii=False))
    else:
        print(text_fn(data))


# ---------------- 命令 ----------------


def cmd_index(a):
    core.build(verbose=not a.json, rebuild=not a.update)
    if a.json:
        print(jsonlib.dumps({"ok": True}, ensure_ascii=False))


def cmd_search(a):
    hits = S.search(a.q, a.n, since=_ts(a.since), until=_ts(a.until), recency=a.recency, project=a.project)
    if a.json:
        print(jsonlib.dumps(hits, ensure_ascii=False))
        return
    if not hits:
        print("（无结果）")
        return
    for h in hits:
        if h["kind"] == "note":
            print(f"📄 {h['title']}\n    {h['path']}  ·  score {h['score']}")
        else:
            print(f"[{h['cat']}] {h['text']}\n    ← {h['title']}  {h['path']}:{h['line']}")


def cmd_context(a):
    out = S.context(a.q, a.n, since=_ts(a.since), until=_ts(a.until), project=a.project)
    print(jsonlib.dumps({"text": out}, ensure_ascii=False) if a.json else (out or "（无结果）"))


def cmd_related(a):
    rows = S.related(a.title, a.depth)
    if a.json:
        print(jsonlib.dumps(rows, ensure_ascii=False))
        return
    if not rows:
        print("（没有关联笔记）")
        return
    for r in rows:
        print(f"-{r['rtype']}→ {r['title']}\n    {r['path']}")


def cmd_recent(a):
    db = core.connect()
    try:
        lo = _ts(a.since) or 0
        rows = db.execute(
            "SELECT title, path, mtime FROM notes WHERE mtime>=? ORDER BY mtime DESC LIMIT ?",
            (lo, a.n),
        ).fetchall()
    finally:
        db.close()
    if a.json:
        print(jsonlib.dumps([{"title": r[0], "path": r[1], "mtime": r[2]} for r in rows],
                            ensure_ascii=False))
        return
    for title, path, mt in rows:
        print(f"{time.strftime('%m-%d %H:%M', time.localtime(mt))}  {title}\n    {path}")


def cmd_list(a):
    """列出全部笔记，带要点数与是否已整理，供面板列表用。"""
    db = core.connect()
    try:
        rows = db.execute(
            """SELECT n.path, n.title, n.type, n.project, n.tags, n.mtime,
                      (SELECT count(*) FROM obs o WHERE o.note_id = n.id) AS obs_count
               FROM notes n ORDER BY n.mtime DESC"""
        ).fetchall()
        indexed = {r[0]: r[1] for r in db.execute("SELECT path, hash FROM notes")}
    finally:
        db.close()

    items, seen = [], set()
    if a.project:
        rows = [r for r in rows if r[3] == a.project]
    for path, title, typ, project, tags, mtime, obs_count in rows:
        seen.add(path)
        items.append({"path": path, "title": title, "type": typ, "project": project,
                      "tags": [t for t in (tags or "").split(",") if t],
                      "mtime": mtime, "obs": obs_count, "indexed": True,
                      "missing": not (core.WS / path).exists()})

    # 磁盘上存在但没进索引的文件
    for project, root in core.load_projects():
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.md")):
            rel = str(f.relative_to(core.WS))
            if rel in seen or not _indexable(f):
                continue
            items.append({"path": rel, "title": f.stem, "type": "note", "project": project,
                          "tags": [], "mtime": f.stat().st_mtime, "obs": 0,
                          "indexed": False, "missing": False})

    if a.json:
        print(jsonlib.dumps(items, ensure_ascii=False))
        return
    for it in items:
        flag = "" if it["indexed"] else "  (未整理)"
        print(f"{it['title']}  [{it['type']}] {it['obs']} 条{flag}\n    {it['path']}")


def cmd_doctor(a):
    db = core.connect()
    problems = {"schema": [], "orphans": [], "unindexed": [], "missing": []}
    try:
        schemas = core.load_schemas()
        notes = db.execute("SELECT path, title, type FROM notes").fetchall()
        for path, title, typ in notes:
            f = core.WS / path
            if not f.exists():
                problems["missing"].append({"path": path, "title": title})
                continue
            note = core.parse_note(f, "main")
            if note:
                for prob in core.validate(note, schemas):
                    problems["schema"].append({"path": path, "title": title, "problem": prob})
        # 失效引用
        titles = {r[0] for r in notes} | {r[1] for r in notes}
        for src, target in db.execute(
            "SELECT n.title, r.target FROM rel r JOIN notes n ON n.id=r.note_id"
        ):
            if not S._resolve(db, target):
                problems["orphans"].append({"from": src, "target": target})
        # 未整理
        indexed = {r[0]: r[1] for r in db.execute("SELECT path, hash FROM notes")}
    finally:
        db.close()
    for project, root in core.load_projects():
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.md")):
            rel = str(f.relative_to(core.WS))
            if rel not in indexed and _indexable(f):
                problems["unindexed"].append({"path": rel, "title": f.stem})

    if a.json:
        print(jsonlib.dumps(problems, ensure_ascii=False))
        return
    total = sum(len(v) for v in problems.values())
    print(f"体检完成：{total} 个问题")
    for k, label in (("schema", "格式不对"), ("orphans", "失效引用"),
                     ("unindexed", "还没整理"), ("missing", "文件不见了")):
        for item in problems[k][:10]:
            print(f"  [{label}] {item}")


def cmd_points(a):
    """全部要点，按笔记分组，供面板「关键要点」详情用。"""
    db = core.connect()
    try:
        rows = db.execute(
            """SELECT n.title, n.path, o.category, o.text, o.line
               FROM obs o JOIN notes n ON n.id = o.note_id
               ORDER BY n.mtime DESC, o.line""").fetchall()
    finally:
        db.close()
    items = [{"title": r[0], "path": r[1], "cat": r[2], "text": r[3], "line": r[4]} for r in rows]
    if a.json:
        print(jsonlib.dumps(items, ensure_ascii=False))
        return
    for it in items:
        print(f"[{it['cat']}] {it['text']}\n    ← {it['title']}")


def cmd_relations(a):
    """全部关系，带解析后的目标标题。"""
    db = core.connect()
    try:
        rows = db.execute(
            """SELECT src.title, src.path, r.rtype, r.target
               FROM rel r JOIN notes src ON src.id = r.note_id""").fetchall()
        items = []
        for src_title, src_path, rtype, target in rows:
            tid = S._resolve(db, target)
            if tid is not None:
                row = db.execute("SELECT id, title, path FROM notes WHERE id=?", (tid,)).fetchone()
                if row and row[2] == src_path:      # 指回自己：多半是前缀误配，跳过
                    continue
                t = (row[1], row[2]) if row else None
            else:
                t = None
            items.append({"from": src_title, "fromPath": src_path, "type": rtype,
                          "to": target, "toTitle": t[0] if t else None,
                          "toPath": t[1] if t else None})
    finally:
        db.close()
    if a.json:
        print(jsonlib.dumps(items, ensure_ascii=False))
        return
    for it in items:
        print(f"{it['from']} -{it['type']}→ {it['toTitle'] or it['to']}")


def cmd_schema(a):
    import schema
    kind = a.action
    if a.json:
        data = schema.infer(write=False) if kind == "infer" else schema.diff() if kind == "diff" else schema.validate()
        print(jsonlib.dumps(data, ensure_ascii=False))
        return
    print(schema.report(kind))


def cmd_projects(a):
    """列出项目根目录；每次先与 DSH 工作区同步（只增不删）。"""
    try:
        import workspaces as W
        W.sync()
    except Exception as e:
        print(f"⚠ 工作区同步失败（{e}）", file=sys.stderr)
    rows = []
    used = {}
    for rec in core.load_project_records():
        name, root = rec["name"], rec["path"]
        used[name] = rec
    for name, root in core.load_projects():
        count = 0
        if root.exists():
            count = len(list(root.rglob("*.md")))
        rec = used.get(name, {})
        rows.append({"name": name, "title": rec.get("title") or name,
                     "workspace": rec.get("workspace"),
                     "path": str(root.relative_to(core.WS)), "notes": count})
    if a.json:
        print(jsonlib.dumps(rows, ensure_ascii=False))
        return
    for r in rows:
        print(f"{r['title']}  ({r['path']})  {r['notes']} 篇")


def cmd_edges(a):
    """事实边聚合成「笔记对 + 类型」，供关系图使用。"""
    db = core.connect()
    try:
        rows = db.execute(
            """SELECT na.path, na.title, nb.path, nb.title, e.etype, count(*) c
               FROM edges e
               JOIN obs oa ON oa.id = e.a JOIN notes na ON na.id = oa.note_id
               JOIN obs ob ON ob.id = e.b JOIN notes nb ON nb.id = ob.note_id
               WHERE na.id != nb.id
               GROUP BY na.id, nb.id, e.etype
               ORDER BY c DESC""").fetchall()
        ent = db.execute("SELECT count(*) FROM entities").fetchone()[0]
    finally:
        db.close()
    items = [{"from": r[1], "fromPath": r[0], "to": r[3], "toTitle": r[3],
              "toPath": r[2], "type": r[4], "count": r[5]} for r in rows]
    if a.json:
        print(jsonlib.dumps({"items": items, "entities": ent}, ensure_ascii=False))
        return
    for it in items:
        print(f"{it['from']} -{it['type']}×{it['count']}→ {it['toTitle']}")
    print(f"实体 {ent} 个")


def cmd_stats(a):
    db = core.connect()
    proj = getattr(a, "project", None)
    w = " WHERE n.project=?" if proj else ""
    wp = (proj,) if proj else ()
    try:
        n = db.execute("SELECT count(*) FROM notes n" + w, wp).fetchone()[0]
        o = db.execute("SELECT count(*) FROM obs o JOIN notes n ON n.id=o.note_id" + w, wp).fetchone()[0]
        r = db.execute("SELECT count(*) FROM rel r JOIN notes n ON n.id=r.note_id" + w, wp).fetchone()[0]
        v = db.execute("SELECT count(*) FROM vec").fetchone()[0]
        ov = db.execute("SELECT count(*) FROM obs_vec").fetchone()[0]
        meta = dict(db.execute("SELECT k,v FROM meta").fetchall())
        try:
            ecount = db.execute(
                "SELECT count(*) FROM edges e JOIN obs o ON o.id=e.a JOIN notes n ON n.id=o.note_id" + w,
                wp).fetchone()[0]
            entcount = db.execute("SELECT count(*) FROM entities").fetchone()[0]
            bytype = db.execute("SELECT etype, count(*) FROM edges GROUP BY etype").fetchall()
        except Exception:
            ecount, entcount, bytype = 0, 0, []
        by_type = db.execute("SELECT type, count(*) FROM notes n" + w + " GROUP BY type ORDER BY 2 DESC", wp).fetchall()
        by_project = db.execute("SELECT project, count(*) FROM notes GROUP BY project ORDER BY 2 DESC").fetchall()
        by_day = db.execute(
            "SELECT date(created,'unixepoch','localtime') d, count(*) FROM notes n"
            " WHERE created > strftime('%s','now','-30 days')" + (" AND n.project=?" if proj else "")
            + " GROUP BY d ORDER BY d", wp).fetchall()
    finally:
        db.close()

    import embed as E
    data = {
        "notes": n, "obs": o, "rel": r, "vec": v, "obs_vec": ov,
        "built_at": float(meta["built_at"]) if meta.get("built_at") else None,
        "provider": meta.get("embed_provider") or E.info(),
        "by_type": [{"key": k or "note", "count": c} for k, c in by_type],
        "by_project": [{"key": k or "main", "count": c} for k, c in by_project],
        "by_day": [{"day": d, "count": c} for d, c in by_day],
        "edges": ecount,
        "entities": entcount,
        "by_edge": [{"key": k, "count": c} for k, c in bytype],
    }
    if a.json:
        print(jsonlib.dumps(data, ensure_ascii=False))
        return
    print(f"{n} 篇笔记 / {o} 条观察 / {r} 条关系 / {v} 个向量（含 {ov} 条观察向量）")
    print(f"向量后端：{E.info()}")
    if data["built_at"]:
        print(f"上次索引：{time.strftime('%Y-%m-%d %H:%M', time.localtime(data['built_at']))}")


def cmd_watch(a):
    print(f"监听中（每 {a.interval}s 检查一次，Ctrl-C 退出）")
    last = None
    try:
        while True:
            sig = tuple(sorted(
                (p, p.stat().st_mtime)
                for name, root in core.load_projects() if root.exists()
                for p in root.rglob("*.md")
            ))
            if last is not None and sig != last:
                core.build(verbose=True, rebuild=False)
            last = sig
            time.sleep(a.interval)
    except KeyboardInterrupt:
        print("\n已停止")


def cmd_mcp(a):
    import mcp_server
    mcp_server.main()


def main():
    ap = argparse.ArgumentParser(prog="mem", description="本地 Markdown 记忆库")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("index", help="重建索引")
    p.add_argument("--update", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_index)

    p = sub.add_parser("search", help="混合检索")
    p.add_argument("q"); p.add_argument("-n", type=int, default=8)
    p.add_argument("--since"); p.add_argument("--until")
    p.add_argument("--recency", type=float, default=0.0)
    p.add_argument("--project")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("context", help="压缩上下文")
    p.add_argument("q"); p.add_argument("-n", type=int, default=3)
    p.add_argument("--since"); p.add_argument("--until")
    p.add_argument("--project")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_context)

    p = sub.add_parser("related", help="关系查询")
    p.add_argument("title"); p.add_argument("-d", "--depth", type=int, default=1)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_related)

    p = sub.add_parser("recent", help="最近笔记")
    p.add_argument("-n", type=int, default=10); p.add_argument("--since")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_recent)

    p = sub.add_parser("list", help="列出全部笔记")
    p.add_argument("--project")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("points", help="全部要点")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_points)

    p = sub.add_parser("schema", help="结构推断/校验/差异")
    p.add_argument("action", choices=["infer", "validate", "diff"], nargs="?", default="infer")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_schema)

    p = sub.add_parser("projects", help="列出项目")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_projects)

    p = sub.add_parser("edges", help="事实边（笔记级聚合）")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_edges)

    p = sub.add_parser("relations", help="全部关系")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_relations)

    p = sub.add_parser("doctor", help="体检")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("stats", help="统计")
    p.add_argument("--json", action="store_true")
    p.add_argument("--project")
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser("watch", help="监听变化")
    p.add_argument("--interval", type=float, default=2.0)
    p.set_defaults(fn=cmd_watch)

    p = sub.add_parser("mcp", help="MCP 服务")
    p.set_defaults(fn=cmd_mcp)

    a = ap.parse_args()
    if a.cmd not in ("index", "list", "doctor", "mcp") and not core.DB_PATH.exists():
        core.build(verbose=False)
    a.fn(a)


if __name__ == "__main__":
    main()
