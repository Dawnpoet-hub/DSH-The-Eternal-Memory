#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""serve —— 常驻检索服务（给 DSH 的自动注入插件用）

不用 HTTP，走 stdin/stdout 的 JSON 行协议：每个请求一行，每个响应一行。
这样可以只加载一次向量模型，后续每次检索只有几十毫秒。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import core          # noqa: E402
import search as S   # noqa: E402


def respond(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        core.connect().close()   # 预热数据库
    except Exception as e:       # 索引还没建也允许启动，后续按需报错
        respond({"ready": True, "warn": str(e)})

    respond({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op", "context")
            if op == "ping":
                respond({"text": "pong"})
                continue
            if op == "sync":
                import workspaces as W
                cfg, added = W.sync()
                respond({"projects": [{"name": r["name"], "title": r.get("title") or r["name"]}
                                      for r in cfg.get("roots", [])], "added": added})
                continue
            if op == "project":
                cwd = req.get("cwd") or ""
                name = core.project_for_cwd(cwd)
                roots = dict(core.load_projects())
                root = roots.get(name)
                respond({"project": name,
                         "root": str(root.relative_to(core.WS)) if root else "memory"})
                continue

            q = (req.get("q") or "").strip()
            if not q:
                respond({"text": ""})
                continue
            if op == "search":
                respond({"hits": S.search(q, int(req.get("n", 8)))})
                continue
            text = S.context(q, top=int(req.get("top", 3)), budget=int(req.get("budget", 900)),
                             gate=True, project=req.get("project") or None)
            respond({"text": text or ""})
        except Exception as e:
            respond({"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
