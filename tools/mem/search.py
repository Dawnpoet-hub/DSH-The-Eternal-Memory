#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# 过程类事实（category = 过程）默认不进自动注入：它记录的是当时的动作与试探，
# 最容易过期，混进「现在是什么」里会误导。仍然保留在库里，mem_search 可以主动捞到。
PROCESS_CATS = {"过程"}
"""search —— 混合检索：全文 + 向量 + 图谱，RRF 融合

对齐 Basic Memory 的四路召回思路（语义/关键词/图谱/时间），
本地实现为三路：FTS5(BM25) + 字符 n-gram 向量 + 关系扩展。
"""
import json
import os
import re
import sqlite3
from collections import defaultdict

from core import DB_PATH, connect, cosine, ngram_vector

RRF_K = 60

# ---- 图谱通道的三个旋钮（都可用环境变量覆盖，不用改代码） ----
# 邻居与查询的最低相似度。对齐 Hindsight 的扩散激活：每一步都要求邻居与查询相关，
# 否则会顺着「共享主题词」的边走到六度分隔去。实测 0.5 能把无关邻居挡掉约 6 成。
GRAPH_MIN_SIM = float(os.environ.get("MEM_GRAPH_MIN_SIM", "0.5"))
# 参与图通道的边类型。semantic 边刻意排除：它和向量路同源（实测邻居 76% 已被向量覆盖），
# 放进图通道等于把同一件事算两遍，还会挤掉真正的新信息。
GRAPH_ETYPES = tuple(x.strip() for x in os.environ.get(
    "MEM_GRAPH_ETYPES", "entity,temporal,causal").split(",") if x.strip())
# 通道交错：最终结果里固定给图保留几个位置（0 = 关闭交错，退回纯加权 RRF）。
# 靠调权重不可行——实测权重 1.0 时图一条进不去、2.0 时霸占 6.5/8 个位置，是悬崖不是旋钮。
GRAPH_SLOTS = int(os.environ.get("MEM_GRAPH_SLOTS", "2"))


def _cos(a, b):
    if isinstance(a, dict) or isinstance(b, dict):
        return cosine(a, b)
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1.0
    nb = sum(y * y for y in b) ** 0.5 or 1.0
    return dot / (na * nb)


def _q_clean(q):
    return re.sub(r"[\s\W_]+", "", q)


def _fts(q):
    return '"' + q.replace('"', '""') + '"'


def _lex(db, q, limit):
    """关键词一路：笔记级 + 观察级，返回 [(kind, id, note_id)]"""
    out = []
    short = len(_q_clean(q)) < 3
    if not short:
        for row in db.execute(
            """SELECT n.id FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
               WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?""",
            (_fts(q), limit),
        ):
            out.append(("note", row[0], row[0], 0.0))
        for row in db.execute(
            """SELECT o.id, o.note_id FROM obs_fts JOIN obs o ON o.id = obs_fts.rowid
               WHERE obs_fts MATCH ? ORDER BY bm25(obs_fts) LIMIT ?""",
            (_fts(q), limit * 2),
        ):
            out.append(("obs", row[0], row[1], 0.0))
    if len(out) < limit:  # 口语问句：FTS 整句匹配失败 → 按查询二元组命中数兜底
        grams = {q[i:i + 2] for i in range(len(q) - 1)}
        grams = {g for g in grams if len(_q_clean(g)) >= 2}
        scored = []
        for nid, title, body in db.execute("SELECT id, title, body FROM notes"):
            text = title + " " + body
            hit = sum(1 for g in grams if g in text)
            if hit >= 2:
                scored.append((hit, nid))
        scored.sort(reverse=True)
        for _, nid in scored[:limit]:
            out.append(("note", nid, nid, 0.0))
    if len(out) < limit:  # 两字词 / 无 FTS 命中 → 子串兜底
        like = f"%{q}%"
        for row in db.execute(
            "SELECT id FROM notes WHERE title LIKE ? OR body LIKE ? LIMIT ?",
            (like, like, limit),
        ):
            out.append(("note", row[0], row[0], 0.0))
        for row in db.execute(
            "SELECT id, note_id FROM obs WHERE text LIKE ? OR category LIKE ? LIMIT ?",
            (like, like, limit * 2),
        ):
            out.append(("obs", row[0], row[1], 0.0))
    return out


def _query_vec(db, q):
    """查询向量：与索引同源（神经模型优先，失败退回 n-gram）。

    抽成独立函数是为了让向量路和图谱路共用一次 embedding —— 图谱的相关性闸门
    也要用同一个查询向量，重复算一次会白白多花 10~30ms。
    """
    prov = ""
    row = db.execute("SELECT v FROM meta WHERE k='embed_provider'").fetchone()
    if row:
        prov = row[0] or ""
    if prov.startswith(("fastembed:", "openai:")):
        try:
            import embed as E
            return E.embed_texts([q])[0][0]
        except Exception:
            pass
    return ngram_vector(q)


def _vec(db, q, limit, qv=None):
    """向量一路：查询向量与索引同源（神经模型优先，失败退回 n-gram）。

    同时扫描「笔记级」和「观察级」两套向量：观察是更细的检索单元，
    长笔记里的关键结论靠它才不会被整篇语义稀释。
    """
    if qv is None:
        qv = _query_vec(db, q)

    scored = []
    for nid, data in db.execute("SELECT note_id, data FROM vec"):
        s = _cos(qv, json.loads(data))
        if s > 0.02:
            scored.append((s, "note", nid, nid))
    for oid, nid, data in db.execute("SELECT obs_id, note_id, data FROM obs_vec"):
        s = _cos(qv, json.loads(data))
        if s > 0.02:
            scored.append((s, "obs", oid, nid))
    scored.sort(reverse=True)

    # 观察与笔记各自保留一部分，避免一种类型挤满向量路
    obs = [(s, "obs", i, n) for s, k, i, n in scored if k == "obs"][: limit]
    notes = [(s, "note", i, n) for s, k, i, n in scored if k == "note"][: max(2, limit // 2)]
    merged = sorted(obs + notes, reverse=True)
    return [(k, i, n, round(float(s), 4)) for s, k, i, n in merged]


def _resolve(db, name):
    """链接目标解析：精确标题/permalink → 前缀 → 包含。"""
    for sql, arg in (("SELECT id FROM notes WHERE title=? OR permalink=?", (name, name)),
                     ("SELECT id FROM notes WHERE title LIKE ? OR permalink LIKE ?", (name + "%", name + "%")),
                     ("SELECT id FROM notes WHERE title LIKE ?", (f"%{name}%",))):
        row = db.execute(sql, arg).fetchone()
        if row:
            return row[0]
    return None


def _graph(db, seeds, limit, project=None, qvec=None):
    """图谱一路：沿关系跳一跳。

    1) 手写的 [[链接]]（笔记级，长期结构）
    2) 从事实推导的边 —— 只走 GRAPH_ETYPES 里的类型（默认 entity/temporal/causal）。
       semantic 边不参与：它和向量路同源（实测其邻居 76% 已被向量路覆盖），
       放进图通道等于把同一件事算两遍，还会挤掉真正的新信息。

    qvec 非空时启用「查询相关性闸门」：邻居与查询的相似度低于 GRAPH_MIN_SIM 就丢弃。
    对齐 Hindsight 的扩散激活——它每一步扩散都带相似度下限，否则会顺着
    「共享主题词」的边走到六度分隔。qvec 为空（或 n-gram 向量不可比）时不闸门，
    保持旧行为，避免因为拿不到向量而把整条通道清空。
    """
    out = []
    seen = set()
    etypes = GRAPH_ETYPES
    ph = ",".join("?" * len(etypes))
    vec_ok = isinstance(qvec, list) and len(qvec) > 0

    def near_batch(oids):
        """批量取邻居与查询的相似度：{oid: sim}。

        逐个 SELECT 会在每个种子上放大成几十次查询（实测 +107ms），
        一次 IN 查询即可。
        """
        if not vec_ok or not oids:
            return {}
        ph2 = ",".join("?" * len(oids))
        out = {}
        for oid, data in db.execute(
            f"SELECT obs_id, data FROM obs_vec WHERE obs_id IN ({ph2})", tuple(oids)
        ):
            try:
                out[oid] = _cos(qvec, json.loads(data))
            except Exception:
                pass
        return out

    def push(kind, oid, nid, score):
        key = (kind, oid)
        if key in seen:
            return
        seen.add(key)
        out.append((kind, oid, nid, score))

    for kind, oid, nid, _sim in seeds[:5]:
        if not db.execute("SELECT 1 FROM notes WHERE id=?", (nid,)).fetchone():
            continue
        # 手写关系
        for (target,) in db.execute("SELECT target FROM rel WHERE note_id=?", (nid,)):
            tid = _resolve(db, target)
            if tid and tid != nid:   # 跳过自引用（前缀匹配常见的假关系）
                push("note", tid, tid, 0.0)

        # 事实边：从种子具体命中的那条观察出发（没有就用该笔记的第一条）
        start_oid = oid if kind == "obs" else None
        if start_oid is None:
            row = db.execute("SELECT id FROM obs WHERE note_id=? ORDER BY line LIMIT 1", (nid,)).fetchone()
            start_oid = row[0] if row else None
        if start_oid is None:
            continue
        sql = (f"SELECT a,b,etype,weight FROM edges WHERE (a=? OR b=?) AND etype IN ({ph})"
               + (" AND project=?" if project else "")
               + " ORDER BY weight DESC LIMIT 12")
        args = (start_oid, start_oid, *etypes, project) if project else (start_oid, start_oid, *etypes)
        cands = []
        for a, b, etype, weight in db.execute(sql, args):
            other = b if a == start_oid else a
            cands.append((other, float(weight)))
        if not cands:
            continue
        ph3 = ",".join("?" * len(cands))
        notes_of = {r[0]: r[1] for r in db.execute(
            f"SELECT id, note_id FROM obs WHERE id IN ({ph3})", tuple(c[0] for c in cands))}
        sims = near_batch([c[0] for c in cands])
        for other, weight in cands:
            nid2 = notes_of.get(other)
            if nid2 is None or nid2 == nid:
                continue
            sim = sims.get(other)
            if sim is not None and sim < GRAPH_MIN_SIM:
                continue
            push("obs", other, nid2, round(weight * 0.35, 4))
    return out[:limit]


def search(q, limit=8, use_graph=True, since=None, until=None, recency=0.0, project=None, rerank=None):
    db = connect()
    try:
        allowed = None
        if project:
            allowed = {r[0] for r in db.execute("SELECT id FROM notes WHERE project=?", (project,))}
            if not allowed:
                return []
        elif since is not None or until is not None:
            lo = since if since is not None else 0
            hi = until if until is not None else 9e18
            allowed = {r[0] for r in db.execute(
                "SELECT id FROM notes WHERE created BETWEEN ? AND ?", (lo, hi))}
            if not allowed:
                return []
        def keep(items):
            if allowed is None:
                return items
            return [it for it in items if it[2] in allowed]

        # 查询向量只算一次，向量路和图谱闸门共用
        qv = _query_vec(db, q)
        lists = {"lex": keep(_lex(db, q, limit * 3)),
                 "vec": keep(_vec(db, q, limit, qv=qv))}
        if use_graph:
            lists["graph"] = keep(_graph(db, lists["lex"] + lists["vec"], limit,
                                         project=project, qvec=qv))
        # 加权 RRF：每一路内部先去重；语义权重最高，图谱只做扩展
        WEIGHTS = {"lex": 1.0, "vec": 1.2, "graph": 0.2}
        score, vsim = defaultdict(float), {}
        for name2, items in lists.items():
            w = WEIGHTS.get(name2, 1.0)
            seen_local, rank = set(), 0
            for kind, iid, nid, sim in items:
                if (kind, iid) in seen_local:
                    continue
                seen_local.add((kind, iid))
                score[(kind, iid)] += w / (RRF_K + rank + 1)
                if sim:
                    vsim[(kind, iid)] = max(vsim.get((kind, iid), 0.0), sim)
                rank += 1
        # 观察级命中略提权：比笔记标题更具体
        for (kind, iid), s in list(score.items()):
            if kind == "obs":
                score[(kind, iid)] = s * 1.15
        if recency > 0:
            ts = {r[0]: r[1] for r in db.execute("SELECT id, created FROM notes")}
            newest = max(ts.values()) if ts else 1
            for (kind, iid), sc in list(score.items()):
                nid = iid if kind == "note" else db.execute(
                    "SELECT note_id FROM obs WHERE id=?", (iid,)).fetchone()[0]
                age_days = max(0.0, (newest - ts.get(nid, newest)) / 86400.0)
                score[(kind, iid)] = sc * (1.0 + recency * 2.718 ** (-age_days / 30.0))
        ranked = sorted(score.items(),
                        key=lambda kv: (-kv[1], -vsim.get(kv[0], 0.0)))[: limit * 2]

        # 通道交错：图不靠权重抢位置，而是固定保留 GRAPH_SLOTS 个。
        # 靠权重是悬崖——实测权重 1.0 时图一条都进不去，2.0 时霸占 6.5/8 个位置。
        if use_graph and GRAPH_SLOTS > 0 and lists.get("graph"):
            base = {(k, i) for k, i, _, _ in lists["lex"]} | {(k, i) for k, i, _, _ in lists["vec"]}
            reserved = []
            for kind, iid, _nid, _sim in lists["graph"]:
                if (kind, iid) in base or (kind, iid) in reserved:
                    continue
                reserved.append((kind, iid))
                if len(reserved) >= GRAPH_SLOTS:
                    break
            if reserved:
                head = ranked[: max(0, limit - len(reserved))]
                head_keys = {k for k, _ in head}
                tail = [((k, i), score.get((k, i), 0.0))
                        for k, i in reserved if (k, i) not in head_keys]
                tail_keys = {k for k, _ in tail}
                rest = [kv for kv in ranked
                        if kv[0] not in head_keys and kv[0] not in tail_keys]
                ranked = head + tail + rest

        hits = []
        for (kind, iid), s in ranked:
            if kind == "note":
                r = db.execute("SELECT title, path, project FROM notes WHERE id=?", (iid,)).fetchone()
                if not r:
                    continue
                hits.append({"kind": "note", "title": r[0], "path": r[1],
                             "project": r[2], "score": round(s, 4)})
            else:
                r = db.execute(
                    """SELECT n.title, n.path, n.project, o.category, o.text, o.line
                       FROM obs o JOIN notes n ON n.id = o.note_id WHERE o.id=?""",
                    (iid,),
                ).fetchone()
                if not r:
                    continue
                hits.append({"kind": "obs", "title": r[0], "path": r[1], "project": r[2],
                             "cat": r[3], "text": r[4], "line": r[5],
                             "score": round(s, 4)})
        # 按融合分排序；笔记最多占三分之一，把位置让给更具体的观察
        merged, notes_used = [], 0
        cap = max(1, limit // 3)
        for h in hits:
            if h["kind"] == "note":
                if notes_used >= cap:
                    continue
                notes_used += 1
            merged.append(h)
            if len(merged) >= limit:
                break

        # ---- 重排：cross-encoder 对最靠前的候选重新打分（失败就保持原序） ----
        try:
            import embed as _E
            cfg = _E.rerank_cfg()
            enabled = cfg["enabled"] if rerank is None else bool(rerank)
            if enabled and len(merged) > 1:
                cand = merged[: cfg["top"]]
                docs = [(h.get("text") or h["title"]) for h in cand]
                scores = _E.rerank_pairs(q, docs)
                if scores and len(scores) == len(cand):
                    for h, sc in zip(cand, scores):
                        h["rerank"] = round(float(sc), 4)
                    cand.sort(key=lambda x: -x["rerank"])
                    merged = cand + merged[len(cand):]
        except Exception:
            pass

        return merged
    finally:
        db.close()


def related(title, depth=1):
    """沿关系走一跳（或 n 跳），返回关联笔记。"""
    db = connect()
    try:
        start = _resolve(db, title)
        if start is None:
            return []
        frontier, seen, out = [start], {start}, []
        for _ in range(max(1, depth)):
            nxt = []
            for nid in frontier:
                for rtype, target in db.execute(
                    "SELECT rtype,target FROM rel WHERE note_id=?", (nid,)
                ):
                    tid = _resolve(db, target)
                    if tid and tid not in seen:
                        hit = db.execute("SELECT title,path FROM notes WHERE id=?", (tid,)).fetchone()
                        seen.add(tid); nxt.append(tid)
                        out.append({"rtype": rtype, "title": hit[0], "path": hit[1]})
                # 反向关系（谁指向我）
                for (src,) in db.execute("SELECT note_id FROM rel WHERE note_id!=?", (nid,)):
                    if src not in seen:
                        seen.add(src); nxt.append(src)
            frontier = nxt
        return out
    finally:
        db.close()


def context(q, top=3, budget=1600, since=None, until=None, gate=False, margin=1.35, project=None, rerank=False):
    """gate=True 时做相关性闸门：最高分明显高于其余，才认为真的相关。"""
    hits = search(q, limit=top * 4, since=since, until=until, project=project, rerank=rerank)
    if gate and hits:
        scores = sorted((h["score"] for h in hits), reverse=True)
        best, rest = scores[0], scores[1:]
        if rest:
            med = sorted(rest)[len(rest) // 2]
            if med > 0 and best < margin * med:
                return ""
        elif best < 0.025:
            return ""
    order, bucket, used = [], {}, 0
    for h in hits:
        p = h["path"]
        if p not in bucket:
            if len(order) >= top:
                continue
            bucket[p] = {"title": h["title"], "obs": []}
            order.append(p)
        if h["kind"] == "obs":
            if (h.get("cat") or "") in PROCESS_CATS:
                continue
            bucket[p]["obs"].append((h["cat"], h["text"]))
    out = []
    if order:
        db = connect()
        try:
            for p in order:
                if bucket[p]["obs"]:
                    continue
                rows = db.execute(
                    """SELECT o.category, o.text FROM obs o JOIN notes n ON n.id=o.note_id
                       WHERE n.path=? AND COALESCE(o.category,'') NOT IN ({}) ORDER BY o.line LIMIT 3""".format(",".join("?" * len(PROCESS_CATS))), (p, *PROCESS_CATS)).fetchall()
                bucket[p]["obs"] = rows
        finally:
            db.close()
    # 核验标记：✅ 引用已核验 / 🔗 无可核验引用。MEM_VERIFY=0 可关掉。
    import os as _os
    verify_on = _os.environ.get("MEM_VERIFY", "1") != "0"
    V = None
    if verify_on:
        try:
            import verify as V  # noqa: F401
        except Exception:
            V = None

    ok_n = tot_n = 0
    for p in order:
        n = bucket[p]
        rows = []
        for cat, text in n["obs"][:4]:
            mark = ""
            if V is not None:
                try:
                    mark = V.mark(text)
                except Exception:
                    mark = ""
            rows.append((mark, cat, text))
        block = f"## {n['title']}\n  ({p})\n"
        for mark, cat, text in rows:
            block += f"  - {mark}[{cat}] {text}\n" if mark else f"  - [{cat}] {text}\n"
        if used + len(block) > budget:
            break
        out.append(block.rstrip())
        used += len(block)
        for mark, _cat, _text in rows:
            tot_n += 1
            if mark == "✅":
                ok_n += 1

    body = "\n\n".join(out)
    if body and tot_n:
        head = (f"（{tot_n} 条：{ok_n} 条引用已于核验时点确认仍在 ✅；"
                f"{tot_n - ok_n} 条无可核验引用 🔗）")
        return head + "\n\n" + body
    return body
