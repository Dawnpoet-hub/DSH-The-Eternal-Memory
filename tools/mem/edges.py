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
import os
import re
import time

SEMANTIC_MIN = 0.68     # 余弦下限
SEMANTIC_TOP = 3        # 每条事实最多连几条

# 按类型配额，而不是全局按权重一刀切。
# 四类的权重刻度不可比：因果恒 1.0、实体 0.6~1.0、语义 0.68~0.99、时序固定 0.5。
# 全局按权重升序删，会把时序边整类删光（实测每轮重建后 temporal = 0）。
EDGE_BUDGET = {
    "semantic": int(os.environ.get("MEM_EDGE_CAP_SEMANTIC", "4000")),
    "entity": int(os.environ.get("MEM_EDGE_CAP_ENTITY", "6000")),
    "temporal": int(os.environ.get("MEM_EDGE_CAP_TEMPORAL", "1500")),
    "causal": int(os.environ.get("MEM_EDGE_CAP_CAUSAL", "1500")),
}
MAX_EDGES = int(os.environ.get("MEM_EDGE_CAP_TOTAL", "13000"))   # 总量保险，正常不触发


def _trim(db):
    """先按类型配额削（各留各的），再按总量兜底。"""
    for etype, cap in EDGE_BUDGET.items():
        rows = db.execute(
            "SELECT id FROM edges WHERE etype=? ORDER BY weight DESC, id ASC", (etype,)
        ).fetchall()
        if len(rows) <= cap:
            continue
        db.executemany("DELETE FROM edges WHERE id=?", [(r[0],) for r in rows[cap:]])
    total = db.execute("SELECT count(*) FROM edges").fetchone()[0]
    if total > MAX_EDGES:
        db.execute(
            "DELETE FROM edges WHERE id IN (SELECT id FROM edges ORDER BY weight ASC LIMIT ?)",
            (total - MAX_EDGES,),
        )
    db.commit()


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



SEMANTIC_BLOCK = 256    # 分块行数：单块占 256×n×8 字节，n=10000 时约 20MB


def _semantic_scored(vecs, ids):
    """语义边的候选打分：每个 i 取 j>i 中 ≥SEMANTIC_MIN 的前 SEMANTIC_TOP 个。

    返回 [(score, a, b), ...]，排序与筛选语义与旧实现完全一致。

    优先走矩阵乘（60 万对从 18 秒降到 0.01 秒）；任何一步不可用就退回纯 Python：
    向量不是等长 list（n-gram 兜底）、没装 numpy、内存不足、出现 NaN。
    """
    try:
        import numpy as np
        if not all(isinstance(vecs[i], list) and vecs[i] for i in ids):
            raise ValueError("非 list 向量")
        dim = len(vecs[ids[0]])
        if any(len(vecs[i]) != dim for i in ids):
            raise ValueError("维度不一致")

        X = np.asarray([vecs[i] for i in ids], dtype=np.float64)
        if not np.isfinite(X).all():
            raise ValueError("向量含 NaN/Inf")
        norms = np.linalg.norm(X, axis=1, keepdims=True)
        norms[norms == 0] = 1.0          # 零向量：归一化后全 0，相似度恒 0，不会建边
        X /= norms

        ids_arr = np.asarray(ids, dtype=np.int64)
        n = len(ids)
        out = []
        for s0 in range(0, n, SEMANTIC_BLOCK):
            block = X[s0:s0 + SEMANTIC_BLOCK] @ X.T        # (chunk, n)
            for r in range(block.shape[0]):
                i = s0 + r
                if i + 1 >= n:
                    continue
                row = block[r, i + 1:]
                hit = np.where(row >= SEMANTIC_MIN)[0]
                if hit.size == 0:
                    continue
                vals = row[hit]
                bvals = ids_arr[i + 1:][hit]
                # 旧实现按 (score desc, b desc) 取前 k，这里保持一致
                order = np.lexsort((bvals, vals))[::-1][:SEMANTIC_TOP]
                for k in order:
                    out.append((float(vals[k]), int(ids_arr[i]), int(bvals[k])))
        return out
    except Exception:
        return _semantic_scored_python(vecs, ids)


def _semantic_scored_python(vecs, ids):
    """旧实现，保留作兜底。"""
    out = []
    for i, a in enumerate(ids):
        cand = []
        for b in ids[i + 1:]:
            s = _cos(vecs[a], vecs[b])
            if s >= SEMANTIC_MIN:
                cand.append((s, b))
        cand.sort(reverse=True)
        for s, b in cand[:SEMANTIC_TOP]:
            out.append((s, a, b))
    return out


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
        scored = _semantic_scored(vecs, ids)
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

    # 裁剪放在项目隔离之后：否则跨项目边先占掉配额、再被删，两类边都算错
    _trim(db)
    total = db.execute("SELECT count(*) FROM edges").fetchone()[0]
    stats["total"] = total

    db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('edges_built_at',?)", (str(now),))
    db.commit()
    if verbose:
        print(f"关系边：{stats['total']} 条（语义 {stats['semantic']}，实体 {stats['entity']}，"
              f"时序 {stats['temporal']}，因果 {stats['causal']}），实体 {stats['entities']} 个")
    return stats
