#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""schema —— 结构推断 / 校验 / 差异（对齐 Basic Memory 的 bm_schema_*）

三种结果区分开，别混：
- 声明式 schema：schemas/<type>.json，人写的，硬约束
- 推断式 schema：schemas/inferred.json，从现有笔记统计出来的，软建议
- 差异：两者对比，告诉你知识库正在往哪长

推断规则（可解释、可复核）：
- 字段：该类型笔记里出现率 ≥ 80% 的 frontmatter 字段
- 观察类别：出现率 ≥ 60% 的 [类别]
- 关系类型：出现过的 relation 类型及次数
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402

FIELD_RATIO = 0.8
CAT_RATIO = 0.6
BASE_FIELDS = ("title", "type", "project")


def _scan():
    """遍历全部笔记，返回按 type 分组的统计。"""
    notes = []
    for project, root in core.load_projects():
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.md")):
            head = f.read_text(encoding="utf-8", errors="ignore")[:400]
            if re.search(r"^index:\s*(false|0|no)\s*$", head, re.M | re.I):
                continue      # 说明类文件不参与结构推断
            note = core.parse_note(f, project)
            if note is None:
                continue
            notes.append(note)
    return notes


def infer(write=True):
    notes = _scan()
    total = len(notes)
    by_type = defaultdict(list)
    for n in notes:
        by_type[n["type"] or "note"].append(n)

    inferred = {"generated_at": core.time.strftime("%Y-%m-%d %H:%M:%S"),
                "notes": total, "types": {}}

    for typ, group in sorted(by_type.items()):
        cnt = len(group)
        field_hits = Counter()
        cat_hits = Counter()
        rel_hits = Counter()
        tag_hits = Counter()
        for n in group:
            for k in n["meta"]:
                field_hits[k] += 1
            for o in n["obs"]:
                cat_hits[o["category"]] += 1
            for r in n["rel"]:
                rel_hits[r["type"]] += 1
            for t in n["tags"]:
                tag_hits[t] += 1
        inferred["types"][typ] = {
            "count": cnt,
            "fields": sorted([k for k, c in field_hits.items()
                              if c / cnt >= FIELD_RATIO or k in BASE_FIELDS]),
            "field_ratio": {k: round(c / cnt, 2) for k, c in field_hits.most_common()},
            "observation_categories": sorted([k for k, c in cat_hits.items() if c / cnt >= CAT_RATIO]),
            "category_ratio": {k: round(c / cnt, 2) for k, c in cat_hits.most_common()},
            "relation_types": dict(rel_hits.most_common()),
            "common_tags": [t for t, _ in tag_hits.most_common(8)],
        }

    if write:
        out = core.WS / "schemas" / "inferred.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(inferred, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return inferred


def _declared():
    return {name: spec for name, spec in core.load_schemas().items()}


def diff():
    inf = infer(write=False)
    dec = _declared()
    out = {"types": {}}
    for typ, spec in inf["types"].items():
        declared = dec.get(typ)
        entry = {
            "count": spec["count"],
            "only_inferred": [],
            "only_declared": [],
            "new_categories": [],
        }
        if declared:
            df = set(declared.get("required", []))
            entry["only_declared"] = sorted(df - set(spec["fields"]))
            entry["only_inferred"] = sorted(set(spec["fields"]) - df)
            dc = set(declared.get("required_observations", []))
            entry["new_categories"] = sorted(set(spec["observation_categories"]) - dc)
        else:
            entry["only_inferred"] = spec["fields"]
            entry["new_categories"] = spec["observation_categories"]
        out["types"][typ] = entry
    out["undeclared_types"] = sorted(set(inf["types"]) - set(dec))
    return out


def validate():
    """返回问题列表；推断式 schema 只给建议级问题。"""
    inf = infer(write=False)
    dec = _declared()
    problems = []
    for project, root in core.load_projects():
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.md")):
            note = core.parse_note(f, project)
            if note is None:
                continue
            typ = note["type"] or "note"
            spec = dec.get(typ)
            if spec:
                for field in spec.get("required", []):
                    val = note["title"] if field == "title" else note["meta"].get(field)
                    if not val:
                        problems.append({"path": note["path"], "level": "error",
                                         "problem": f"缺少字段 {field}"})
                cats = {o["category"] for o in note["obs"]}
                for cat in spec.get("required_observations", []):
                    if cat not in cats:
                        problems.append({"path": note["path"], "level": "error",
                                         "problem": f"缺少 [{cat}] 类观察"})
            soft = inf["types"].get(typ)
            if soft:
                for field in soft["fields"]:
                    if field in ("title",) or field in BASE_FIELDS:
                        continue
                    if field not in note["meta"]:
                        problems.append({"path": note["path"], "level": "warn",
                                         "problem": f"同类笔记多数有字段 {field}，这篇没有"})
    return problems


def report(kind="infer"):
    if kind == "infer":
        inf = infer()
        lines = [f"共 {inf['notes']} 篇笔记，推断出 {len(inf['types'])} 种类型"]
        for typ, spec in inf["types"].items():
            lines.append(f"  {typ}（{spec['count']} 篇）字段 {spec['fields']}；"
                         f"类别 {spec['observation_categories']}")
        return "\n".join(lines)
    if kind == "diff":
        d = diff()
        lines = []
        for typ, e in d["types"].items():
            lines.append(f"{typ}（{e['count']} 篇）：未声明类型字段 {e['only_inferred']}；"
                         f"声明但少见 {e['only_declared']}；新增类别 {e['new_categories']}")
        if d["undeclared_types"]:
            lines.append(f"尚未写 schema 的类型：{d['undeclared_types']}")
        return "\n".join(lines) or "（无可比较的类型）"
    probs = validate()
    errs = [p for p in probs if p["level"] == "error"]
    warns = [p for p in probs if p["level"] == "warn"]
    lines = [f"硬性问题 {len(errs)} 个，软建议 {len(warns)} 个"]
    for p in (errs + warns)[:12]:
        lines.append(f"  [{p['level']}] {p['path']}: {p['problem']}")
    return "\n".join(lines)
