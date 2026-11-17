# -*- coding: utf-8 -*-
"""audit —— 记忆库质量与成本指标，用于"改前 / 改后"对比

四项指标：

1. 同义率     同一笔记内，满足「余弦 ≥ 阈值 + 字面值可包含 + 同类别 + 双方有元数据」
              的观察聚成一簇，簇内多出来的条目视为冗余。
2. 召回重复率 重放历史提问的检索，统计返回结果里落在同一簇的比例。
3. 注入字数   auto.log 里 inject 事件的字数分布与命中率。
4. 提炼成本   auto.log 里 distill 事件的次数、模型耗时、送入字符、覆盖会话数。

用法：
    mem audit                       人类可读
    mem audit --json                机器可读
    mem audit --save                另存基线到 .mem/audit/audit-<ts>.json
    mem audit --recall-samples 20   附带召回重复率（较慢，要跑 embedding 检索）

判据阈值来自实测标定，见 长期记忆去重与冲突消解-方案v1.md。
"""

import json
import re
import time

import core

COS_THRESHOLD = 0.92

# 字面值：色值 / 版本号 / 日期 / 文件名。
# 中文数字（「第三版」「两行」）抽不出来——这是已知限制：宁可漏，不要误合并。
LIT_RE = re.compile(
    r"#[0-9A-Fa-f]{6}\b"
    r"|\bv?\d+\.\d+(?:\.\d+)?\b"
    r"|\b\d{4}-\d{2}-\d{2}\b"
    r"|[A-Za-z0-9_\-]+\.(?:html|png|md|py|js|css|json|yml|yaml|ts|tsx|jsx)\b"
)

# category 实际跑出 30 多种，先归一到 6 类，否则「类别不同不合并」形同虚设
CATEGORY_FAMILY = {
    "决定": "决定",
    "约束": "约束", "规则": "约束", "原则": "约束", "限制": "约束", "边界": "约束", "前提": "约束",
    "原因": "原因", "教训": "原因", "理由": "原因",
    "事实": "事实", "证据": "事实", "环境": "事实", "配置": "事实",
    "路径": "事实", "端口": "事实", "背景": "事实",
    "偏好": "偏好",
    # 过程自成一族：不给它映射到「事实」，否则「类别不同不合并」的保护会失效，
    # 过程条目会被并进结论里——那正是要避免的事。
    "过程": "过程",
}


def _family(cat):
    c = (cat or "").strip()
    return CATEGORY_FAMILY.get(c, c)


def _lits(text):
    return set(m.group(0) for m in LIT_RE.finditer(text or ""))


def _ents(raw):
    if not raw:
        return set()
    try:
        v = json.loads(raw)
        return set(map(str, v)) if isinstance(v, list) else set()
    except Exception:
        return set(x for x in re.split(r"[|,，;；]", str(raw)) if x.strip())


def _load_groups(db):
    """{note_id: {"path": path, "rows": [row...]}}"""
    rows = db.execute(
        """SELECT o.id, o.note_id, n.path, o.line, o.text, o.category, o.conv, o.ents, v.data
             FROM obs o
             JOIN notes n ON n.id = o.note_id
             JOIN obs_vec v ON v.obs_id = o.id"""
    ).fetchall()
    groups = {}
    for r in rows:
        groups.setdefault(r[1], {"path": r[2], "rows": []})["rows"].append(r)
    return groups


def _cluster(groups, threshold=COS_THRESHOLD):
    """返回 (簇根映射 {(path,line): root}, 每篇统计 [(path, before, after)])。

    四道闸全部来自实测：
      · 余弦 ≥ 0.92          单靠阈值分不开（分布非双峰），必须配字面值闸门
      · 字面值集合相同或互含   实测"字面值不同"多半是详略差异，不是矛盾
      · 类别归一后相同        防止约束/理由被并进决定
      · 双方都有 conversation 无元数据视为人工写入，不参与自动合并
    """
    try:
        import numpy as np
    except ImportError:  # pragma: no cover
        raise SystemExit("audit 需要 numpy：tools/mem/.venv/bin/pip install numpy")

    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    keymap = {}
    per_note = []
    for _nid, g in groups.items():
        rows = g["rows"]
        path = g["path"]
        n = len(rows)
        roots = {}

        if n >= 2:
            X = np.array([json.loads(r[8]) for r in rows], dtype="float32")
            norms = np.linalg.norm(X, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            X = X / norms
            S = X @ X.T
            lits = [_lits(r[4]) for r in rows]
            fams = [_family(r[5]) for r in rows]
            conv = [bool(r[6]) for r in rows]
            for i in range(n):
                for j in range(i + 1, n):
                    if S[i][j] < threshold:
                        continue
                    A, B = lits[i], lits[j]
                    if not (A == B or A <= B or B <= A):
                        continue
                    if fams[i] != fams[j]:
                        continue
                    if not (conv[i] and conv[j]):
                        continue
                    union(rows[i][0], rows[j][0])

        for r in rows:
            root = find(r[0])
            roots[r[0]] = root
            keymap[(path, r[3])] = root
        per_note.append((path, n, len(set(roots.values()))))

    return keymap, per_note


def _conflict_pairs(groups):
    """宽松口径的冲突候选对：同笔记 + 同类别 + 共享实体 + 字面值完全互斥。

    只作趋势与人工复核线索。实测假阳性很多（同一实体的不同事实），
    不得据此自动改库。
    """
    out = []
    for _nid, g in groups.items():
        rows = g["rows"]
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                if _family(rows[i][5]) != _family(rows[j][5]):
                    continue
                if not (_ents(rows[i][7]) & _ents(rows[j][7])):
                    continue
                A, B = _lits(rows[i][4]), _lits(rows[j][4])
                if A and B and not (A & B):
                    out.append((g["path"], rows[i], rows[j]))
    return out


def _conflict_candidates(groups):
    return len(_conflict_pairs(groups))


def _log_metrics(log_path, since_ms=None):
    inj_chars, empty, inject = [], 0, 0
    distills, queries = [], []
    if not log_path.exists():
        return {}, {}, []
    with log_path.open(encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if since_ms is not None and (e.get("t") or 0) < since_ms:
                continue
            ev = e.get("ev")
            if ev == "inject":
                inject += 1
                if isinstance(e.get("chars"), int):
                    inj_chars.append(e["chars"])
                if e.get("q"):
                    queries.append(e["q"])
            elif ev == "empty":
                empty += 1
            elif ev == "distill":
                distills.append(e)

    inj = {"events": inject, "empty": empty}
    if inj_chars:
        inj_chars.sort()
        inj.update({
            "chars_min": inj_chars[0],
            "chars_median": inj_chars[len(inj_chars) // 2],
            "chars_max": inj_chars[-1],
            "chars_total": sum(inj_chars),
        })
    hits = inject + empty
    inj["hit_rate"] = round(inject / hits, 3) if hits else None

    dist = {"calls": len(distills)}
    if distills:
        dist["model_seconds"] = round(sum(d.get("ms", 0) for d in distills) / 1000, 1)
        dist["chars"] = sum(d.get("chars", 0) for d in distills)
        dist["facts"] = sum(d.get("facts", 0) for d in distills)
        dist["written"] = sum(d.get("written", 0) for d in distills)
        sids = {d["sid"] for d in distills if d.get("sid")}
        dist["sessions"] = len(sids) if sids else None
    return inj, dist, queries


def _recall_duplicates(queries, keymap, samples):
    """重放历史提问的检索，统计返回结果里同簇重复的比例。"""
    import search as S

    picked = queries[-samples:] if len(queries) > samples else list(queries)
    returned = dup = 0
    for q in picked:
        try:
            hits = S.search(q, limit=12)
        except Exception:
            continue
        obs_hits = [h for h in hits if h.get("kind") == "obs"][:8]
        roots = []
        for h in obs_hits:
            returned += 1
            root = keymap.get((h.get("path"), h.get("line")))
            if root is not None:
                roots.append(root)
        dup += len(roots) - len(set(roots))
    return {
        "queries": len(picked),
        "returned": returned,
        "duplicate": dup,
        "rate": round(dup / returned, 3) if returned else None,
    }


def parse_since(text):
    """把 `90m` / `2h` / `3d` / `2026-11-17 18:00` 解析成毫秒时间戳。

    传 epoch 秒数也可以。解析不出来就抛 SystemExit，不要静默忽略。
    """
    import datetime as _dt

    s = str(text).strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([mhd])", s, re.I)
    if m:
        n, unit = float(m.group(1)), m.group(2).lower()
        secs = n * {"m": 60, "h": 3600, "d": 86400}[unit]
        return int((time.time() - secs) * 1000)
    if re.fullmatch(r"\d{9,13}", s):
        v = int(s)
        return v if v > 10**11 else v * 1000
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(_dt.datetime.strptime(s, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise SystemExit(f"--since 看不懂：{text}（用 90m / 2h / 3d / 2026-11-17 18:00）")


def collect(recall_samples=0, since_ms=None):
    db = core.connect()
    try:
        groups = _load_groups(db)
        notes = db.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        obs = db.execute("SELECT COUNT(*) FROM obs").fetchone()[0]
        keymap, per_note = _cluster(groups)
        conflicts = _conflict_candidates(groups)
    finally:
        db.close()

    before = sum(b for _p, b, _a in per_note)
    after = sum(a for _p, _b, a in per_note)
    worst = sorted(((b - a, p, b, a) for p, b, a in per_note if b > a), reverse=True)[:10]

    inj, dist, queries = _log_metrics(core.WS / ".mem" / "auto.log", since_ms)

    out = {
        "ts": int(time.time()),
        "library": {"notes": notes, "obs": obs},
        "redundancy": {
            "obs_scanned": before,
            "obs_after_merge": after,
            "reducible": before - after,
            "rate": round((before - after) / before, 3) if before else None,
            "worst_notes": [{"path": p, "before": b, "after": a} for _d, p, b, a in worst],
        },
        "conflict_candidates": conflicts,
        "injection": inj,
        "distill": dist,
        "since_ms": since_ms,
    }
    if recall_samples:
        out["recall"] = _recall_duplicates(queries, keymap, recall_samples)
    return out


def render(r):
    L = ["记忆库体检指标"]
    if r.get("since_ms"):
        import datetime as _dt
        t = _dt.datetime.fromtimestamp(r["since_ms"] / 1000).strftime("%m-%d %H:%M")
        L.append(f"  统计窗口：{t} 之后")
    L.append(f"  笔记 {r['library']['notes']} 篇 / 观察 {r['library']['obs']} 条")
    red = r["redundancy"]
    if red["rate"] is not None:
        L.append(
            f"  同义率（可压缩） {red['reducible']}/{red['obs_scanned']}"
            f" = {red['rate'] * 100:.1f}%"
        )
        for w in red["worst_notes"][:5]:
            L.append(f"    {w['path'].replace('memory/', ''):<40} {w['before']} → {w['after']}")
    L.append(f"  冲突候选（宽松口径，只作趋势） {r['conflict_candidates']}")
    inj = r.get("injection") or {}
    if inj.get("events"):
        L.append(
            f"  注入 {inj['events']} 次 / 空召回 {inj['empty']} 次"
            f"（命中率 {inj.get('hit_rate')}）"
        )
        if inj.get("chars_median"):
            L.append(
                f"    注入字数 中位 {inj['chars_median']}，"
                f"区间 {inj['chars_min']}–{inj['chars_max']}，累计 {inj['chars_total']}"
            )
    dist = r.get("distill") or {}
    if dist.get("calls"):
        L.append(
            f"  提炼 {dist['calls']} 次，模型耗时 {dist.get('model_seconds')}s，"
            f"送入 {dist.get('chars', 0):,} 字符，写入 {dist.get('written', 0)} 条"
        )
        if dist.get("sessions"):
            L.append(f"    覆盖会话 {dist['sessions']} 个（按 sid 统计）")
    if "recall" in r:
        rc = r["recall"]
        L.append(
            f"  召回重复率 {rc['duplicate']}/{rc['returned']}"
            f" = {(rc['rate'] or 0) * 100:.1f}%（{rc['queries']} 次查询）"
        )
    return "\n".join(L)
