#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""edges —— 从事实推导关系边（对齐 Hindsight 的四类边）

semantic  语义相近（复用已有的 observation 向量，纯计算，不花钱）
entity    共享实体（文件、色值、接口名……）
temporal  同一段对话里先后出现
causal    提炼时标注的「因为」，链回被引用的那条事实

设计前提：**边全部可再生**。它们从 Markdown 事实 + 向量推导，删库重建不会丢东西。
"""
import json
import math
import re
import time

SEMANTIC_MIN = 0.68     # 余弦下限
SEMANTIC_TOP = 3        # 每条事实最多连几条
MAX_EDGES = 8000        # 全局上限，防止规模爆炸


def _cos(a, b):
    if isinstance(a, dict) or isinstance(b, dict):
        a = dict(a) if isinstance(a, dict) else a
        b = dict(b) if isinstance(b, dict) else b
        if not a or not b:
            return 0.0
        keys = set(a) & set(b)
        dot = sum(a[k] * b[k] for k in keys)
        na = math.sqrt(sum(v * v for v in a.values())) or 1.0
        nb = math.sqrt(sum(v * v for v in b.values())) or 1.0
        return dot / (na * nb)
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def _norm(t):
    return re.sub(r"[\s，。、,.!?！？:：;；\"'“”‘’（）()\[\]【】#]", "", (t or "")).lower()


def _load_obs_vecs(db):
    rows = db.execute("SELECT obs_id, data FROM obs_vec").fetchall()
    out = {}
    for oid, raw in rows:
        try:
            out[oid] = json.loads(raw)
        except Exception:
            continue
    return out


def _index_entities(db, now, stats):
    """把 obs.ents 里的实体落成实体表 + 事实-实体关联。"""
    rows = db.execute("SELECT id, ents FROM obs WHERE ents IS NOT NULL AND ents != ''").fetchall()
    for oid, raw in rows:
        try:
            names = json.loads(raw)
        except Exception:
            continue
        for name in names:
            name = str(name).strip()
            if not name or len(name) > 80:
                continue
            norm = _norm(name)
            if not norm:
                continue
            cur = db.execute("SELECT id FROM entities WHERE norm=?", (norm,)).fetchone()
            if cur:
                eid = cur[0]
                db.execute("UPDATE entities SET seen = seen + 1 WHERE id=?", (eid,))
            else:
                eid = db.execute(
                    "INSERT INTO entities(norm,name,kind,first_seen,seen) VALUES(?,?,?,?,1)",
                    (norm, name, _kind_of(name), now),
                ).lastrowid
                if eid is None:
                    row = db.execute("SELECT id FROM entities WHERE norm=?", (norm,)).fetchone()
                    if not row:
                        continue
                    eid = row[0]
            db.execute("INSERT OR IGNORE INTO fact_entity(fact_id,entity_id) VALUES(?,?)", (oid, eid))


FILE_EXT = (".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml", ".svg",
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".css", ".sh", ".txt", ".toml", ".sql")


def _kind_of(name):
    n = name.strip()
    if re.match(r"^#?[0-9a-fA-F]{3,8}$", n):
        return "color"
    if "/" in n or n.lower().endswith(FILE_EXT):
        return "file"
    if re.match(r"^[A-Za-z_][\w.]*\(", n) or re.match(r"^[a-z]+_[a-z_]+$", n):
        return "api"
    return "concept"


def build(db, verbose=True):
    """重建全部边。可重复执行（幂等）。"""
    now = time.time()
    stats = {"semantic": 0, "entity": 0, "temporal": 0, "causal": 0, "entities": 0}

    db.execute("DELETE FROM edges")
    db.execute("DELETE FROM fact_entity")
    db.execute("DELETE FROM entities")
    db.commit()

    _index_entities(db, now, stats)
    stats["entities"] = db.execute("SELECT count(*) FROM entities").fetchone()[0]

    # ---- entity 边：共享实体 ----
    pairs = db.execute(
        """SELECT fa.fact_id, fb.fact_id, count(*) c
           FROM fact_entity fa JOIN fact_entity fb
             ON fa.entity_id = fb.entity_id AND fa.fact_id < fb.fact_id
           GROUP BY fa.fact_id, fb.fact_id"""
    ).fetchall()
    for a, b, c in pairs:
        db.execute("INSERT OR IGNORE INTO edges(a,b,etype,weight,computed_at) VALUES(?,?,?,?,?)",
                   (min(a, b), max(a, b), "entity", min(1.0, 0.4 + 0.2 * c), now))
        stats["entity"] += 1

    # ---- temporal 边：同一段对话内相邻的两条事实 ----
    convs = {}
    for oid, conv in db.execute("SELECT id, conv FROM obs WHERE conv IS NOT NULL AND conv != ''"):
        convs.setdefault(conv, []).append(oid)
    for conv, ids in convs.items():
        ids.sort()
        for a, b in zip(ids, ids[1:]):
            db.execute("INSERT OR IGNORE INTO edges(a,b,etype,weight,computed_at) VALUES(?,?,?,?,?)",
                       (min(a, b), max(a, b), "temporal", 0.5, now))
            stats["temporal"] += 1

    # ---- semantic 边：向量近邻 ----
    vecs = _load_obs_vecs(db)
    ids = [i for i in vecs if isinstance(vecs[i], list) or isinstance(vecs[i], dict)]
    if len(ids) > 1:
        scored = []
        for i, a in enumerate(ids):
            cand = []
            for b in ids[i + 1:]:
                s = _cos(vecs[a], vecs[b])
                if s >= SEMANTIC_MIN:
                    cand.append((s, b))
            cand.sort(reverse=True)
            for s, b in cand[:SEMANTIC_TOP]:
                scored.append((s, a, b))
        scored.sort(reverse=True)
        for s, a, b in scored[:MAX_EDGES]:
            db.execute("INSERT OR IGNORE INTO edges(a,b,etype,weight,computed_at) VALUES(?,?,?,?,?)",
                       (min(a, b), max(a, b), "semantic", round(s, 4), now))
            stats["semantic"] += 1

    # ---- causal 边：提炼时标注的 because 指向某条已存在的事实 ----
    facts = db.execute("SELECT id, text FROM obs").fetchall()
    norm_index = [(_norm(t), i) for i, t in facts]
    for oid, because in db.execute(
        "SELECT id, because FROM obs WHERE because IS NOT NULL AND because != ''"
    ).fetchall():
        key = _norm(because)
        if len(key) < 6:
            continue
        hit = next((i for n, i in norm_index if key in n and i != oid), None)
        if hit is None:
            # 退一步：取前 24 个字符做前缀匹配
            short = key[:24]
            hit = next((i for n, i in norm_index if short and short in n and i != oid), None)
        if hit is None:
            continue
        db.execute("INSERT OR IGNORE INTO edges(a,b,etype,weight,computed_at) VALUES(?,?,?,?,?)",
                   (min(oid, hit), max(oid, hit), "causal", 1.0, now))
        stats["causal"] += 1

    db.commit()
    total = db.execute("SELECT count(*) FROM edges").fetchone()[0]
    stats["total"] = total
    if total > MAX_EDGES:      # 预留应急闸门：未来规模变大时裁剪最弱的边
        db.execute(
            "DELETE FROM edges WHERE id IN (SELECT id FROM edges ORDER BY weight ASC LIMIT ?)",
            (total - MAX_EDGES,),
        )
        db.commit()
        stats["total"] = MAX_EDGES


    # 按项目隔离：给每条边打上所属项目，并删掉跨项目的边
    db.execute("""
        UPDATE edges SET project = COALESCE((
            SELECT n.project FROM obs o JOIN notes n ON n.id = o.note_id WHERE o.id = edges.a
        ), 'main')
    """)
    db.execute("""
        DELETE FROM edges WHERE id IN (
            SELECT e2.id FROM edges e2
            JOIN obs oa ON oa.id = e2.a JOIN notes na ON na.id = oa.note_id
            JOIN obs ob ON ob.id = e2.b JOIN notes nb ON nb.id = ob.note_id
            WHERE na.project IS NOT nb.project
        )
    """)
    db.commit()
    db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('edges_built_at',?)", (str(now),))
    db.commit()
    if verbose:
        print(f"关系边：{stats['total']} 条（语义 {stats['semantic']}，实体 {stats['entity']}，"
              f"时序 {stats['temporal']}，因果 {stats['causal']}），实体 {stats['entities']} 个")
    return stats
