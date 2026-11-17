#!/usr/bin/env python3
"""下载模型并写出字节级进度。

用法：
    python fetch_model.py <repo_id> <progress.json> <cache_dir> <expected_bytes> [--rerank]

progress.json: {"done": ..., "total": ..., "state": "running|done|error", "error": "..."}

下载交给 fastembed 自己完成（它只取需要的文件，体积≈标称值），
本脚本只负责：记录缓存真实文件增量 → 写入进度文件。
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback


def cache_bytes(root: str) -> int:
    """缓存里真实文件的字节数（跳过符号链接、按 inode 去重）。"""
    seen = set()
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                if os.path.islink(p):
                    continue
                st = os.stat(p)
                key = (st.st_dev, st.st_ino)
                if key in seen:
                    continue
                seen.add(key)
                total += st.st_size
            except OSError:
                pass
    return total


def write(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: fetch_model.py <repo_id> <progress> <cache_dir> <expected_bytes> [--rerank]", file=sys.stderr)
        return 2

    repo_id = sys.argv[1]
    out_path = sys.argv[2]
    cache_dir = sys.argv[3]
    try:
        total = max(1, int(sys.argv[4]))
    except ValueError:
        total = 1
    rerank = "--rerank" in sys.argv[5:]

    os.environ["FASTEMBED_CACHE_PATH"] = cache_dir
    baseline = cache_bytes(cache_dir)
    write(out_path, {"done": 0, "total": total, "state": "running"})

    stop = threading.Event()
    last = {"bytes": 0, "at": time.time()}

    def pump() -> None:
        while not stop.is_set():
            done = min(total - 1, max(0, cache_bytes(cache_dir) - baseline))
            now = time.time()
            if done != last["bytes"]:
                last["bytes"] = done
                last["at"] = now
            stalled = int(now - last["at"])
            write(out_path, {"done": done, "total": total, "state": "running", "stalled": stalled})
            stop.wait(0.5)

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()

    def watchdog() -> None:
        while not stop.is_set():
            if os.environ.get("LM_DOWNLOAD_STALL_LIMIT"):
                limit = int(os.environ["LM_DOWNLOAD_STALL_LIMIT"])
            else:
                limit = 180
            if time.time() - last["at"] > limit:
                write(out_path, {
                    "done": last["bytes"], "total": total, "state": "error",
                    "error": f"网络 {limit} 秒没有进展，已停止；请检查网络后重试",
                })
                os._exit(3)
            stop.wait(2)

    threading.Thread(target=watchdog, daemon=True).start()

    try:
        if rerank:
            from fastembed.rerank.cross_encoder import TextCrossEncoder as C
            list(C(repo_id).rerank("预热", ["记住这件事"]))
        else:
            from fastembed import TextEmbedding
            list(TextEmbedding(repo_id).embed(["预热"]))
        stop.set()
        thread.join(timeout=2)
        write(out_path, {"done": total, "total": total, "state": "done"})
        return 0
    except Exception as exc:  # noqa: BLE001
        stop.set()
        write(out_path, {"done": 0, "total": total, "state": "error", "error": str(exc)[:400]})
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
