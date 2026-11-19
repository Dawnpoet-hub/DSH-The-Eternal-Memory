# -*- coding: utf-8 -*-
"""dedupe —— 合并提案报告（**只读**，绝不修改任何笔记或索引）

用途：L1 上线前先看清"如果合并，会发生什么"。所有判据与 audit 共用，
阈值和闸门完全一致，不存在两套口径。

分类：
  A. 可自动合并    被合并条目不携带保留条目之外的字面值（色值/版本/文件名/日期），
                   合并后无信息损失。
  B. 需人工确认    被合并条目含有保留条目没有的字面值，直接合并会丢信息。

冲突候选单独列出，只作提示——实测假阳性高，且真实矛盾往往相似度很低
（已知案例余弦 0.709），不能自动裁决。

用法：
    python3 tools/mem/mem.py dedupe                   文本摘要
    python3 tools/mem/mem.py dedupe --out report.md   同时写 Markdown 报告
    python3 tools/mem/mem.py dedupe --json            机器可读
"""

import json
import time

import audit
import core


def _keep_score(row):
    """保留优先级：字面值多 > 文本长 > 行号小（更早）。

    字面值优先，是因为实测"字面值不同"多半是详略差异——字面值最多的那条
    通常就是信息最完整的那条。行号只做最后的确定性兜底，不代表"新的更好"。
    """
    lits = audit._lits(row[4])
    return (-len(lits), -len(row[4] or ""), row[3] or 0)


def _brief(text, n=110):
    s = " ".join((text or "").split())
    return s if len(s) <= n else s[:n] + "…"


def collect(limit_conflicts=40):
    db = core.connect()
    try:
        groups = audit._load_groups(db)
        keymap, per_note = audit._cluster(groups)
        conflicts = audit._conflict_pairs(groups)
    finally:
        db.close()

    by_root = {}
    for g in groups.values():
        for row in g["rows"]:
            root = keymap.get((g["path"], row[3]))
            if root is None:
                continue
            by_root.setdefault(root, []).append(row)

    auto, review = [], []
    for rows in by_root.values():
        if len(rows) < 2:
            continue
        rows = sorted(rows, key=_keep_score)
        kept, dropped = rows[0], rows[1:]
        kept_lits = audit._lits(kept[4])
        dropped_lits = set()
        for r in dropped:
            dropped_lits |= audit._lits(r[4])
        lost = sorted(dropped_lits - kept_lits)

        item = {
            "path": kept[2],
            "kept": {"line": kept[3], "category": kept[5], "text": _brief(kept[4], 200),
                     "text_full": kept[4]},
            "dropped": [
                {"line": r[3], "category": r[5], "text": _brief(r[4]), "text_full": r[4]}
                for r in sorted(dropped, key=lambda x: x[3] or 0)
            ],
            "lost_literals": lost,
            "removed": len(dropped),
        }
        (review if lost else auto).append(item)

    auto.sort(key=lambda x: -x["removed"])
    review.sort(key=lambda x: -len(x["lost_literals"]))

    before = sum(b for _p, b, _a in per_note)
    after = sum(a for _p, _b, a in per_note)

    conf = []
    seen = set()
    for path, a, b in conflicts:
        key = (path, a[3], b[3])
        if key in seen:
            continue
        seen.add(key)
        conf.append({
            "path": path,
            "a": {"line": a[3], "category": a[5], "text": _brief(a[4])},
            "b": {"line": b[3], "category": b[5], "text": _brief(b[4])},
        })
        if len(conf) >= limit_conflicts:
            break

    return {
        "ts": int(time.time()),
        "readonly": True,
        "library": {"obs_scanned": before, "obs_after_merge": after,
                    "reducible": before - after},
        "auto_merge": auto,
        "needs_review": review,
        "auto_removed": sum(x["removed"] for x in auto),
        "review_removed": sum(x["removed"] for x in review),
        "notes_affected": len({x["path"] for x in auto + review}),
        "conflicts": conf,
        "conflicts_total": len(seen),
    }


def render_markdown(r):
    L = []
    L.append("# 合并提案报告（只读）")
    L.append("")
    L.append(f"生成时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(r['ts']))}")
    L.append("")
    L.append("> 本报告不修改任何文件。所有数字来自 `audit` 的同一套判据。")
    L.append(">")
    L.append("> **「第 N 条」是该笔记内第 N 条观察的序号，不是文件行号**（文件前面还有 frontmatter 和标题）。")
    L.append("> 手动清理时请按文字匹配，不要按行号删——曾因把序号当行号删错过 6 条观察。")
    L.append("")
    L.append("## 总览")
    L.append("")
    L.append("| 项 | 值 |")
    L.append("|---|---|")
    L.append(f"| 扫描观察 | {r['library']['obs_scanned']} 条 |")
    L.append(f"| 合并后 | {r['library']['obs_after_merge']} 条 |")
    L.append(f"| 可减少 | {r['library']['reducible']} 条 |")
    L.append(f"| 涉及笔记 | {r['notes_affected']} 篇 |")
    L.append(f"| A 可自动合并 | {len(r['auto_merge'])} 组，减少 {r['auto_removed']} 条 |")
    L.append(f"| B 需人工确认 | {len(r['needs_review'])} 组，减少 {r['review_removed']} 条 |")
    L.append(f"| 冲突候选（宽松口径） | {r['conflicts_total']} 对 |")
    L.append("")

    def block(title, items, review_mode):
        L.append(f"## {title}")
        L.append("")
        if not items:
            L.append("（无）")
            L.append("")
            return
        for i, it in enumerate(items, 1):
            L.append(f"### {i}. `{it['path']}` — 合并 {it['removed']} 条")
            L.append("")
            L.append(f"- **保留** 第 {it['kept']['line']} 条 〔{it['kept']['category']}〕{it['kept']['text']}")
            for d in it["dropped"]:
                L.append(f"- ~~合并~~ 第 {d['line']} 条 〔{d['category']}〕{d['text']}")
            if review_mode:
                L.append(f"- ⚠️ **会丢字面值**：{', '.join('`%s`' % x for x in it['lost_literals'])}")
            else:
                L.append("- 字面值无损失")
            L.append("")

    block("A. 可自动合并（字面值无损失）", r["auto_merge"], False)
    block("B. 需人工确认（会丢字面值）", r["needs_review"], True)

    L.append("## C. 冲突候选（只提示，不自动处理）")
    L.append("")
    if not r["conflicts"]:
        L.append("（无）")
    else:
        L.append("同笔记 + 同类别 + 共享实体 + 字面值完全互斥。**假阳性很高**，仅供人工抽查。")
        L.append("")
        L.append("| 笔记 | A | B |")
        L.append("|---|---|---|")
        for c in r["conflicts"]:
            L.append(f"| `{c['path']}` | L{c['a']['line']} {c['a']['text'][:60]} "
                     f"| L{c['b']['line']} {c['b']['text'][:60]} |")
    L.append("")
    return "\n".join(L)


def render_text(r):
    L = []
    L.append("合并提案报告（只读，不会修改任何文件）")
    L.append(f"  扫描 {r['library']['obs_scanned']} 条 → 合并后 {r['library']['obs_after_merge']} 条"
             f"（可减少 {r['library']['reducible']}）")
    L.append(f"  A 可自动合并 {len(r['auto_merge'])} 组 / 减少 {r['auto_removed']} 条；"
             f"B 需确认 {len(r['needs_review'])} 组 / 减少 {r['review_removed']} 条")
    L.append(f"  冲突候选 {r['conflicts_total']} 对（宽松口径，只作提示）")
    L.append("")
    if r["auto_merge"]:
        L.append("  A 组前 5：")
        for it in r["auto_merge"][:5]:
            L.append(f"    {it['path'].replace('memory/', ''):<34} 合并 {it['removed']} 条 → 保留 L{it['kept']['line']}")
    if r["needs_review"]:
        L.append("  B 组前 5（会丢字面值）：")
        for it in r["needs_review"][:5]:
            L.append(f"    {it['path'].replace('memory/', ''):<34} 丢 {', '.join(it['lost_literals'][:4])}")
    return "\n".join(L)


# ---------------- L3 执行器 ----------------

LOCK = core.WS / ".mem" / "dedupe.lock"
BACKUP_DIR = core.WS / ".mem" / "backups"
LOCK_STALE_SEC = 600


def _acquire_lock():
    """迁移锁：同一时间只允许一个迁移。锁文件超过 10 分钟视为上次崩溃残留。"""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        try:
            age = time.time() - LOCK.stat().st_mtime
        except OSError:
            age = LOCK_STALE_SEC + 1
        if age < LOCK_STALE_SEC:
            raise SystemExit(f"另一个迁移正在进行（锁 {LOCK}），跳过本次。"
                             f"若确认没有在跑，删掉该文件重试。")
        print(f"⚠️ 发现 {int(age)} 秒前的残留锁，已接管")
    LOCK.write_text(json.dumps({"pid": __import__("os").getpid(), "at": int(time.time())}),
                    encoding="utf-8")


def _release_lock():
    try:
        LOCK.unlink()
    except OSError:
        pass


def _mark_line(line, kept_line):
    """把 merged_into 标记塞进已有的括号里——不能加在行尾。

    core.parse_note 只在行以 `)` 结尾时才解析元数据；标记加在括号外会让
    这条观察失去 page/entities/conversation 信息。
    """
    tag = f"merged_into:L{kept_line}"
    if line.rstrip().endswith(")"):
        idx = line.rstrip().rfind(")")
        return line.rstrip()[:idx] + f" · {tag}" + line.rstrip()[idx:]
    return line.rstrip() + f" ({tag})"


def apply(include_review=False, verbose=True):
    """执行合并：只改文件，然后整体重建索引（含 edges）。

    只自动处理「字面值无损失」的 A 组。B 组要 include_review=True 才动，
    因为它会丢字面值——那是需要人判断的取舍，不是机械去重。
    """
    report = collect()
    targets = list(report["auto_merge"]) + (list(report["needs_review"]) if include_review else [])

    _acquire_lock()
    try:
        ts = int(time.time())
        backup_root = BACKUP_DIR / f"dedupe-{ts}"
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime())

        files = {}
        for it in targets:
            files.setdefault(it["path"], []).append(it)

        stats = {"notes": 0, "marked": 0, "skipped": 0, "details": []}
        for path, items in files.items():
            src = core.WS / path
            if not src.exists():
                stats["skipped"] += len(items)
                continue
            backup_root.mkdir(parents=True, exist_ok=True)
            (backup_root / path.replace("/", "__")).write_bytes(src.read_bytes())

            text = src.read_text(encoding="utf-8")
            st0 = src.stat()
            before = (st0.st_mtime_ns, st0.st_size)
            _meta, body = core.split_frontmatter(text)
            pos = text.find(body) if body else -1
            if pos < 0:
                stats["skipped"] += len(items)
                continue
            # DB 里的 line 是相对 frontmatter 之后（body）的行号；
            # 要改文件就得换算成整文件行号，否则会错位到 frontmatter 行数。
            offset = text[:pos].count("\n")
            lines = text.splitlines(keepends=True)
            # 用 parse_note 的规范化文本精确匹配：索引文本已剥掉 #tag，
            # 直接拿它和原始行做子串比较会匹配不上。
            note = core.parse_note(src, "main") or {}
            by_text = {o["text"].strip(): o["line"] for o in note.get("obs", [])}
            changed = 0
            for it in items:
                keep_line = it["kept"]["line"]
                for d in it["dropped"]:
                    full = (d.get("text_full") or "").strip()
                    body_line = by_text.get(full)
                    if body_line is None:
                        for o in note.get("obs", []):
                            if full and o["text"].strip().startswith(full[:24]):
                                body_line = o["line"]
                                break
                    if body_line is None:
                        stats["skipped"] += 1
                        continue
                    idx = offset + body_line - 1
                    if not (0 <= idx < len(lines)) or "merged_into:" in lines[idx]:
                        stats["skipped"] += 1
                        continue
                    lines[idx] = _mark_line(lines[idx], keep_line)
                    if not lines[idx].endswith("\n"):
                        lines[idx] += "\n"
                    changed += 1
            if changed:
                # 插件在跑：读完之后文件可能又被追加过，覆盖就会吃掉那些内容。
                # 只要 mtime 或大小变了就放弃这个文件，下次迁移再处理。
                now = src.stat()
                if (now.st_mtime_ns, now.st_size) != (before[0], before[1]):
                    stats["skipped"] += changed
                    stats["details"].append({"path": path, "marked": 0, "raced": True})
                    continue
                tmp = src.with_suffix(".md.tmp")
                tmp.write_text("".join(lines), encoding="utf-8")
                tmp.replace(src)          # 原子替换，避免写到一半被读到
                stats["notes"] += 1
                stats["marked"] += changed
            stats["details"].append({"path": path, "marked": changed})

        # 整体重建索引（core.build 内部会一并重建 edges）
        core.build(verbose=verbose, rebuild=True)

        log_dir = core.WS / ".mem" / "audit"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / f"merge-{ts}.json").write_text(
            json.dumps({"ts": ts, "at": stamp, "include_review": include_review,
                        "backup": str(backup_root), **{k: v for k, v in stats.items()}},
                       ensure_ascii=False, indent=1), encoding="utf-8")

        stats["backup"] = str(backup_root)
        stats["include_review"] = include_review
        return stats
    finally:
        _release_lock()


def render_apply(stats):
    L = ["合并已执行"]
    L.append(f"  处理笔记 {stats['notes']} 篇，标记 {stats['marked']} 条为已合并，跳过 {stats['skipped']} 条")
    L.append(f"  备份目录：{stats['backup']}")
    L.append("  索引与边已重建")
    if not stats["include_review"]:
        L.append("  （只处理了 A 组；B 组需 --include-review 才动）")
    return "\n".join(L)


# ---------------- 人工合并（阈值抓不到、或需要先富化保留条目时用） ----------------

def manual_merge(path, keep_line, merge_lines, new_text=None, verbose=True):
    """人工指定一组行：把 merge_lines 标成合并到 keep_line，可选改写保留行正文。

    行号一律用**文件里的原始行号**（1-based，和 grep -n 看到的一致），
    内部再换算成 body 行号，避免把 frontmatter 算进去。

    这是"人已经判断过"的通道：不走余弦，但仍然备份、加锁、重建索引、写日志。
    """
    src = core.WS / path
    if not src.exists():
        raise SystemExit(f"文件不存在：{path}")
    merge_lines = [int(x) for x in merge_lines if str(x).strip()]
    if not merge_lines:
        raise SystemExit("没有要合并的行")

    _acquire_lock()
    try:
        ts = int(time.time())
        backup_root = BACKUP_DIR / f"dedupe-{ts}"
        backup_root.mkdir(parents=True, exist_ok=True)
        (backup_root / path.replace("/", "__")).write_bytes(src.read_bytes())

        text = src.read_text(encoding="utf-8")
        st0 = src.stat()
        before = (st0.st_mtime_ns, st0.st_size)
        _meta, body = core.split_frontmatter(text)
        pos = text.find(body) if body else -1
        if pos < 0:
            raise SystemExit("读不到正文，放弃")
        offset = text[:pos].count("\n")
        lines = text.splitlines(keepends=True)

        kept_idx = keep_line - 1
        if not (0 <= kept_idx < len(lines)):
            raise SystemExit(f"保留行越界：{keep_line}")
        merged = 0
        for ln in merge_lines:
            i = ln - 1
            if not (0 <= i < len(lines)):
                print(f"  跳过：第 {ln} 行越界"); continue
            if i == kept_idx:
                continue
            if "merged_into:" in lines[i]:
                print(f"  跳过：第 {ln} 行已经是合并状态"); continue
            lines[i] = _mark_line(lines[i], keep_line)
            if not lines[i].endswith("\n"):
                lines[i] += "\n"
            merged += 1

        if new_text:
            import re as _re
            m = _re.match(r"^(\s*-\s*\[[^\]]+\]\s*)(.*?)(\s*\(.*\)\s*)$", lines[kept_idx].rstrip())
            if m:
                lines[kept_idx] = m.group(1) + new_text.strip() + m.group(3) + "\n"
            else:
                lines[kept_idx] = f"- [决定] {new_text.strip()}\n"

        now = src.stat()
        if (now.st_mtime_ns, now.st_size) != before:
            raise SystemExit("文件在迁移期间被改动（插件正在写），本次放弃；请重跑。")

        tmp = src.with_suffix(".md.tmp")
        tmp.write_text("".join(lines), encoding="utf-8")
        tmp.replace(src)

        core.build(verbose=verbose, rebuild=True)

        log_dir = core.WS / ".mem" / "audit"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / f"manual-merge-{ts}.json").write_text(json.dumps({
            "ts": ts, "path": path, "keep_line": keep_line,
            "merged_lines": merge_lines, "merged": merged,
            "enriched": bool(new_text), "backup": str(backup_root),
        }, ensure_ascii=False, indent=1), encoding="utf-8")

        return {"path": path, "merged": merged, "keep_line": keep_line,
                "enriched": bool(new_text), "backup": str(backup_root)}
    finally:
        _release_lock()
