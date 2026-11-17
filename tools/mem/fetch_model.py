#!/usr/bin/env python3
"""下载模型并写字节级进度。

用法：python fetch_model.py <repo_id> <progress.json> <cache_dir> [--rerank]

progress.json: {"done": 已下载字节, "total": 总字节, "state": "running|done|error", "error": "..."}

做法：先用 HfApi 拿到仓库总字节数，再边下边统计本地目录体积（符号链接按目标大小算），
不依赖 tqdm 内部状态，避免多线程进度互相覆盖。
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback

from huggingface_hub import HfApi, snapshot_download


def cache_bytes(root: str) -> int:
    """缓存里真实文件的总字节（跳过符号链接，按 inode 去重）。

    HuggingFace 把下到的数据写进缓存根目录的 blobs/，模型目录里只放符号链接，
    所以必须统计真实文件、并且用「相对下载开始时的增量」来算进度。
    """
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
    if len(sys.argv) < 4:
        print("usage: fetch_model.py <repo_id> <progress.json> <cache_dir> [--rerank]", file=sys.stderr)
        return 2

    repo_id, out_path, cache_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    rerank = "--rerank" in sys.argv[4:]
    os.environ["FASTEMBED_CACHE_PATH"] = cache_dir
    baseline = cache_bytes(cache_dir)

    total = 0
    try:
        info = HfApi().model_info(repo_id, files_metadata=True)
        total = sum((s.size or 0) for s in info.siblings)
    except Exception:
        total = 0

    write(out_path, {"done": 0, "total": total, "state": "running"})

    stop = threading.Event()

    def pump() -> None:
        while not stop.is_set():
            done = max(0, cache_bytes(cache_dir) - baseline)
            write(out_path, {"done": done, "total": total or done, "state": "running"})
            stop.wait(0.5)

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()

    try:
        snapshot_download(repo_id=repo_id, cache_dir=cache_dir)
        # 下完让 fastembed 真正载入一次，确认文件齐全可用
        if rerank:
            from fastembed.rerank.cross_encoder import TextCrossEncoder as C
            list(C(repo_id).rerank("预热", ["记住这件事"]))
        else:
            from fastembed import TextEmbedding
            list(TextEmbedding(repo_id).embed(["预热"]))
        stop.set()
        thread.join(timeout=2)
        final = max(0, cache_bytes(cache_dir) - baseline)
        write(out_path, {"done": (total or final), "total": (total or final), "state": "done"})
        return 0
    except Exception as exc:  # noqa: BLE001
        stop.set()
        write(out_path, {"done": max(0, cache_bytes(cache_dir) - baseline), "total": total, "state": "error", "error": str(exc)[:400]})
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
