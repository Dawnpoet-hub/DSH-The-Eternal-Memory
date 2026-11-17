# -*- coding: utf-8 -*-
"""relabel —— 把历史上被记成「决定/事实」的过程性观察，改标成「过程」

背景：插件早期没有区分过程与结果（见方案文档第 11 节），911 条观察里有相当一部分
是"当时的排查动作"被写成了结论。新提示词已经能正确区分，这个工具负责回标历史。

安全设计：
  · 只改行首的 `- [类别]` 标记，正文一个字不动
  · 改前备份、加迁移锁、写日志（复用 dedupe 的锁与备份目录）
  · 写回前核对 mtime/size，插件并发追加过就放弃该文件
  · 只接受调用方明确给出的 id 列表——判定逻辑不在这个模块里

用法（一般由上层脚本调用，不直接手敲）：
    python3 -c "import relabel; relabel.dump('cands.json')"
    python3 -c "import relabel; relabel.apply([1,5,9])"
"""

import json
import re
import time

import core
import dedupe

# 强信号：出现这些词，才值得送去人工/模型判定是不是过程
PROCESS_HINT = re.compile(
    r"排查|验证|实测|测试结果|发现|误判|核对|复现|定位|试探|临时|等待|二分|抓取|逐个|状态检查|报错"
)

VALID = {"过程", "决定", "事实", "环境", "约束", "原因", "规则", "原则", "证据", "教训", "偏好", "配置"}


def candidates(include_mid=False):
    """返回待判定的观察列表。category 已经是「过程」的不再列出。"""
    rx = PROCESS_HINT
    if include_mid:
        rx = re.compile(PROCESS_HINT.pattern + r"|检查|确认|抓包|日志|尝试|先试")
    db = core.connect()
    try:
        rows = db.execute(
            """SELECT o.id, o.category, o.text, n.path, o.line
                 FROM obs o JOIN notes n ON n.id = o.note_id"""
        ).fetchall()
    finally:
        db.close()
    out = []
    for oid, cat, text, path, line in rows:
        cat = (cat or "").strip()
        if cat == "过程":
            continue
        if not rx.search(text or ""):
            continue
        out.append({"id": oid, "category": cat, "text": text, "path": path, "line": line})
    out.sort(key=lambda x: (x["path"], x["line"]))
    return out


def dump(path, include_mid=False):
    items = candidates(include_mid=include_mid)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    print(f"导出 {len(items)} 条候选 → {path}")
    return items


def apply(ids, verbose=True):
    """把指定 id 的观察类别改成「过程」。只改行首标记。"""
    ids = set(int(i) for i in ids)
    if not ids:
        return {"changed": 0, "notes": 0, "skipped": 0}

    db = core.connect()
    try:
        q = ",".join("?" * len(ids))
        rows = db.execute(
            f"""SELECT o.id, o.category, o.text, n.path, o.line
                  FROM obs o JOIN notes n ON n.id = o.note_id
                 WHERE o.id IN ({q})""",
            tuple(ids),
        ).fetchall()
    finally:
        db.close()

    by_path = {}
    for oid, cat, text, path, line in rows:
        by_path.setdefault(path, []).append((oid, (cat or "").strip(), text, line))

    dedupe._acquire_lock()
    try:
        ts = int(time.time())
        backup_root = dedupe.BACKUP_DIR / f"relabel-{ts}"
        stats = {"notes": 0, "changed": 0, "skipped": 0, "details": []}

        for path, items in by_path.items():
            src = core.WS / path
            if not src.exists():
                stats["skipped"] += len(items)
                continue
            text = src.read_text(encoding="utf-8")
            st0 = src.stat()
            before = (st0.st_mtime_ns, st0.st_size)
            _meta, body = core.split_frontmatter(text)
            pos = text.find(body) if body else -1
            if pos < 0:
                stats["skipped"] += len(items)
                continue
            offset = text[:pos].count("\n")
            lines = text.splitlines(keepends=True)

            changed = 0
            for oid, cat, txt, body_line in items:
                idx = offset + body_line - 1
                if not (0 <= idx < len(lines)):
                    stats["skipped"] += 1
                    continue
                line = lines[idx]
                m = re.match(r"^(\s*-\s*)\[([^\]]+)\]", line)
                if not m:
                    stats["skipped"] += 1
                    continue
                # 行首类别必须和索引里的一致，否则说明文件已经变了
                if m.group(2).strip() != cat:
                    stats["skipped"] += 1
                    continue
                if cat == "过程":
                    continue
                lines[idx] = f"{m.group(1)}[过程]" + line[m.end():]
                if not lines[idx].endswith("\n"):
                    lines[idx] += "\n"
                changed += 1

            if changed:
                now = src.stat()
                if (now.st_mtime_ns, now.st_size) != before:
                    stats["skipped"] += changed
                    stats["details"].append({"path": path, "changed": 0, "raced": True})
                    continue
                backup_root.mkdir(parents=True, exist_ok=True)
                (backup_root / path.replace("/", "__")).write_bytes(src.read_bytes())
                tmp = src.with_suffix(".md.tmp")
                tmp.write_text("".join(lines), encoding="utf-8")
                tmp.replace(src)
                stats["notes"] += 1
                stats["changed"] += changed
                stats["details"].append({"path": path, "changed": changed})

        core.build(verbose=verbose, rebuild=True)

        log_dir = core.WS / ".mem" / "audit"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / f"relabel-{ts}.json").write_text(json.dumps(
            {"ts": ts, "requested": len(ids), "found": len(rows),
             "backup": str(backup_root), **stats}, ensure_ascii=False, indent=1),
            encoding="utf-8")
        stats["backup"] = str(backup_root)
        return stats
    finally:
        dedupe._release_lock()
