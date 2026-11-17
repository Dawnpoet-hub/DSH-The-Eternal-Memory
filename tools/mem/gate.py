# -*- coding: utf-8 -*-
"""gate —— 写入前的判重闸门（L1）

输入一批待写入的事实，判定每条是 `new`（写）还是 `dup`（跳过）。
判据与 audit / dedupe 完全一致，没有第二套口径：

  1. 余弦 ≥ 0.92                  单靠阈值分不开（分布非双峰），必须配下面几条
  2. 字面值集合相同或互相包含       实测"字面值不同"多半是详略差异
  3. 类别归一后相同                防止约束/理由被并进决定
  4. 已有条目带 conversation 元数据  无元数据视为人工写入，永不覆盖

比较范围限定在**目标笔记内**：跨笔记合并会把事实搬到别的笔记去，风险更高，
本版不做（已知局限，见报告）。

作为常驻服务的一个 op 被调用（serve.py），向量模型只加载一次。

单独调试：
    echo '{"items":[{"text":"…","category":"决定","note":"某笔记.md"}]}' | python3 gate.py
"""

import json
import os
import sys

import audit  # 复用 _lits / _family，保证与报告口径一致
import core

COS_THRESHOLD = float(os.environ.get("MEM_GATE_COS", "0.92"))
# 0.92 的实测依据：真实提炼产生的改写通常 ≥0.95；手工重写的说法会掉到 0.85 以下。
# 宁可漏掉重复，也不误并——漏掉只多一条，误并会丢信息。

_cache = {"max_id": 0, "by_note": {}, "mat": {}}


def _basename(path):
    return str(path).rsplit("/", 1)[-1]


def _refresh(db):
    """增量把新观察读进缓存。索引重建后 id 会变小，此时整表重来。"""
    import numpy as np

    cur = db.execute("SELECT COALESCE(MAX(id), 0) FROM obs").fetchone()[0]
    if cur < _cache["max_id"]:
        _cache["by_note"].clear()
        _cache["mat"].clear()
        _cache["max_id"] = 0
    if cur == _cache["max_id"]:
        return

    rows = db.execute(
        """SELECT o.id, n.path, o.line, o.text, o.category, o.conv, v.data
             FROM obs o
             JOIN notes n ON n.id = o.note_id
             JOIN obs_vec v ON v.obs_id = o.id
            WHERE o.id > ?""",
        (_cache["max_id"],),
    ).fetchall()

    for _oid, npath, line, text, cat, conv, vec in rows:
        try:
            v = np.array(json.loads(vec), dtype="float32")
        except Exception:
            continue
        n = float(np.linalg.norm(v))
        if n <= 0:
            continue
        key = _basename(npath)
        _cache["by_note"].setdefault(key, []).append((line, text or "", cat or "", conv or "", v / n))
        _cache["mat"].pop(key, None)   # 该笔记矩阵失效，下次按需重建

    _cache["max_id"] = cur


def _matrix(key):
    import numpy as np

    cached = _cache["mat"].get(key)
    if cached is not None:
        return cached
    rows = _cache["by_note"].get(key) or []
    if not rows:
        _cache["mat"][key] = (None, rows)
        return _cache["mat"][key]
    mat = np.vstack([r[4] for r in rows])
    _cache["mat"][key] = (mat, rows)
    return _cache["mat"][key]


def check(items, threshold=COS_THRESHOLD):
    """items: [{"text","category","note"}] → [{"i","verdict","score","target_line","why"}]

    `note` 是目标笔记的文件名（含 .md），与 appendFact 的 slugify 结果一致。
    任何异常都退化成 new —— 闸门坏掉不能阻断写入。
    """
    if not items:
        return []
    try:
        import numpy as np
        import embed as E
    except Exception as e:                                  # pragma: no cover
        return [{"i": i, "verdict": "new", "why": f"import-fail:{e}"}
                for i in range(len(items))]

    out = [{"i": i, "verdict": "new"} for i in range(len(items))]
    try:
        db = core.connect()
        try:
            _refresh(db)
        finally:
            db.close()

        texts = [str(it.get("text") or "").strip() for it in items]
        vecs, _prov = E.embed_texts(texts)
        if not vecs or isinstance(vecs[0], dict):           # ngram 兜底：不做语义判重
            for o in out:
                o["why"] = "no-semantic-vector"
            return out

        for i, it in enumerate(items):
            key = _basename(it.get("note") or "")
            mat, rows = _matrix(key)
            if mat is None:
                out[i]["why"] = "empty-note"
                continue

            v = np.array(vecs[i], dtype="float32")
            n = float(np.linalg.norm(v))
            if n <= 0:
                out[i]["why"] = "zero-vector"
                continue
            v = v / n

            sims = mat @ v
            j = int(sims.argmax())
            score = float(sims[j])
            out[i]["score"] = round(score, 4)
            if score < threshold:
                out[i]["why"] = "below-threshold"
                continue

            line, text, cat, conv, _vec = rows[j]
            a, b = audit._lits(it.get("text")), audit._lits(text)
            if not (a == b or a <= b or b <= a):
                out[i]["why"] = "literals-differ"
                continue
            if audit._family(it.get("category")) != audit._family(cat):
                out[i]["why"] = "category-differ"
                continue
            if not conv:
                out[i]["why"] = "target-is-manual"
                continue

            out[i].update({"verdict": "dup", "target_line": line, "why": "dup"})
    except Exception as e:                                  # pragma: no cover
        for o in out:
            if o["verdict"] == "dup":
                o.update({"verdict": "new", "why": f"error:{e}"})
    return out


def main():
    """调试入口：stdin 收 {"items":[...]}，stdout 回结果。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            sys.stdout.write(json.dumps({"results": check(req.get("items") or [])},
                                        ensure_ascii=False) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"error": f"{type(e).__name__}: {e}"},
                                        ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
