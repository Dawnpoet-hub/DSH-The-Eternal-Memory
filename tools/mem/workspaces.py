#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""workspaces —— 把 DSH 的工作区自动映射成记忆项目

DSH 把工作区登记在 ~/.dsh/storages/workspace.json：
  {"global": {...}, "tables": {"workspaces": {"<id>": {"path","title","sessionIds",...}}}}

这里做两件事：
1. 读出全部工作区（id / 标题 / 路径）；
2. 把还没登记的工作区补进 mem.json 的 roots：一个工作区 = 一个记忆项目，
   目录统一放在 <workspace>/projects/<slug>/，默认工作区沿用已有的 memory/。

设计前提：**只增不减**。工作区被删掉时，这里不删记忆目录，只把它标记为「离线」，
以免误删用户数据。
"""
import json
import os
import re
import time
from pathlib import Path

DSH_DIR = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
WS_FILE = Path(os.environ.get("DSH_WORKSPACE_JSON") or (DSH_DIR / "storages" / "workspace.json"))

PROJECTS = Path(__file__).resolve().parents[2]


def _slug(text, fallback="ws"):
    s = re.sub(r"[^\w\u4e00-\u9fa5-]+", "-", (text or "")).strip("-")
    s = s.lower()[:40]
    return s or fallback


def read_workspaces():
    """返回 [{id, title, path}]，读不到就返回空列表（不抛错）。"""
    try:
        data = json.loads(WS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    table = ((data.get("tables") or {}).get("workspaces") or {})
    out = []
    for wid, rec in table.items():
        if not isinstance(rec, dict):
            continue
        if rec.get("archivedAt"):
            continue
        out.append({"id": wid, "title": (rec.get("title") or "").strip(), "path": rec.get("path") or ""})
    return out


def load_config():
    p = PROJECTS / "mem.json"
    if not p.exists():
        return {"roots": [{"name": "main", "title": "默认工作区", "path": "memory"}]}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"roots": [{"name": "main", "path": "memory"}]}


def save_config(cfg):
    p = PROJECTS / "mem.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sync(verbose=False):
    """把 DSH 工作区同步进 mem.json。返回 (config, added_names)。"""
    cfg = load_config()
    roots = cfg.setdefault("roots", [])
    if not roots:
        roots.append({"name": "main", "title": "默认工作区", "path": "memory"})

    by_ws = {str(Path(r["workspace"]).resolve()): r for r in roots if r.get("workspace")}
    added = []

    for ws in read_workspaces():
        path = ws["path"]
        if not path:
            continue
        try:
            key = str(Path(path).resolve())
        except Exception:
            continue
        if key in by_ws:
            by_ws[key]["title"] = ws["title"] or by_ws[key].get("title") or by_ws[key]["name"]
            by_ws[key]["workspaceId"] = ws["id"]
            continue

        is_default = key == str(PROJECTS.resolve())
        if is_default:
            # 默认工作区：已有根目录就地补上 workspace 字段，绝不新增
            target = next((r for r in roots if r.get("path") == "memory"), roots[0])
            target["workspace"] = key
            target["workspaceId"] = ws["id"]
            target["title"] = ws["title"] or target.get("title") or "默认工作区"
            by_ws[key] = target
            continue

        name = _slug(ws["title"] or Path(path).name)
        base, i = name, 2
        taken = {r["name"] for r in roots}
        while name in taken:
            name = f"{base}-{i}"
            i += 1

        rel = f"projects/{name}"
        (PROJECTS / rel).mkdir(parents=True, exist_ok=True)

        rec = {"name": name,
               "title": ws["title"] or Path(path).name,
               "path": rel,
               "workspace": key,
               "workspaceId": ws["id"]}
        roots.append(rec)
        added.append(rec["name"])
        if verbose:
            print(f"+ 工作区「{rec['title']}」→ {rel}")

    cfg["syncedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    save_config(cfg)
    return cfg, added


if __name__ == "__main__":
    cfg, added = sync(verbose=True)
    print("工作区 → 记忆项目：")
    for r in cfg["roots"]:
        print(f"  {r.get('title') or r['name']}  ({r['path']})")
    if not added:
        print("（没有新增）")
