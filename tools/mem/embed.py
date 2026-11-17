#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""embed —— 向量层，可插拔

优先级：
  1. openai     任何 OpenAI 兼容的 /embeddings 端点（OpenAI / 硅基流动 / 智谱 / 阿里 / Ollama）
  2. fastembed  本地 ONNX 模型，无 key、无网络
  3. ngram      字符 n-gram 降级（无同义能力）

配置（mem.json 的 "embed" 段，或环境变量）：
  {"provider": "openai", "base_url": "https://api.siliconflow.cn/v1",
   "api_key": "sk-...", "model": "BAAI/bge-m3"}
"""
import json
import os
import urllib.request
from pathlib import Path

from core import CONFIG, ngram_vector

# 模型与 HF 缓存固定在工作区内：沙箱只允许写这里，
# 也让 MCP 直接调用（不走 mem 包装脚本）时同样能加载模型。
_HERE = Path(__file__).resolve().parent
os.environ.setdefault("FASTEMBED_CACHE_PATH", str(_HERE / ".fastembed"))
os.environ.setdefault("HF_HOME", str(_HERE / ".hf"))
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(_HERE / ".hf" / "hub"))


def _cfg():
    cfg = {}
    if CONFIG.exists():
        try:
            cfg = (json.loads(CONFIG.read_text(encoding="utf-8")).get("embed") or {})
        except Exception:
            cfg = {}
    return {
        "provider": os.environ.get("MEM_EMBED_PROVIDER") or cfg.get("provider") or "",
        "base_url": os.environ.get("MEM_EMBED_BASE_URL") or cfg.get("base_url") or "",
        "api_key": os.environ.get("MEM_EMBED_API_KEY") or cfg.get("api_key") or "",
        "model": os.environ.get("MEM_EMBED_MODEL") or cfg.get("model") or "",
    }


def _openai_embed(cfg, texts):
    url = cfg["base_url"].rstrip("/") + "/embeddings"
    body = json.dumps({"model": cfg["model"], "input": texts}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {cfg['api_key']}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode())
    return [d["embedding"] for d in data["data"]]


class _FastEmbed:
    _model = None
    _name = None

    @classmethod
    def get(cls, name):
        if cls._model is None or cls._name != name:
            from fastembed import TextEmbedding  # 延迟导入
            cls._model = TextEmbedding(model_name=name)
            cls._name = name
        return cls._model


_RERANKERS = {}


def rerank_cfg():
    """mem.json 的 rerank 段；默认开启，模型可用性差时自动降级。"""
    cfg = {}
    if CONFIG.exists():
        try:
            cfg = (json.loads(CONFIG.read_text(encoding="utf-8")).get("rerank") or {})
        except Exception:
            cfg = {}
    return {
        "enabled": cfg.get("enabled", True) and os.environ.get("MEM_RERANK", "1") != "0",
        "model": os.environ.get("MEM_RERANK_MODEL") or cfg.get("model")
        or "BAAI/bge-reranker-v2-m3-int8",
        "top": int(os.environ.get("MEM_RERANK_TOP") or cfg.get("top") or 12),
    }


def rerank_pairs(query, docs):
    """cross-encoder 打分：把「问题 + 候选」放一起读，比向量余弦准得多。

    返回分数列表（与 docs 同序）；任何失败都返回 None，由调用方保持原排序。
    """
    cfg = rerank_cfg()
    if not cfg["enabled"] or not docs:
        return None
    try:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        enc = _RERANKERS.get(cfg["model"])
        if enc is None:
            enc = TextCrossEncoder(model_name=cfg["model"],
                                   cache_dir=os.environ["FASTEMBED_CACHE_PATH"])
            _RERANKERS[cfg["model"]] = enc
        return [float(x) for x in enc.rerank(query, docs)]
    except Exception:
        return None


def embed_texts(texts):
    """返回 (vectors, provider_name)。vectors 为 list[list[float]] 或 list[dict]（ngram）。"""
    cfg = _cfg()
    p = cfg["provider"].lower()

    if p == "openai" and cfg["base_url"] and cfg["model"]:
        return _openai_embed(cfg, texts), f"openai:{cfg['model']}"

    if p == "fastembed" or (not p and _has_fastembed()):
        name = cfg["model"] or "BAAI/bge-small-zh-v1.5"
        model = _FastEmbed.get(name)
        return [list(map(float, v)) for v in model.embed(texts)], f"fastembed:{name}"

    return [ngram_vector(t) for t in texts], "ngram"


def _has_fastembed():
    try:
        import fastembed  # noqa: F401
        return True
    except Exception:
        return False


def info():
    cfg = _cfg()
    if cfg["provider"] == "openai":
        return f"openai  {cfg['base_url']}  model={cfg['model']}"
    if cfg["provider"] == "fastembed" or _has_fastembed():
        return f"fastembed  model={cfg['model'] or 'BAAI/bge-small-zh-v1.5'}"
    return "ngram（字符三元组，无同义能力）"
