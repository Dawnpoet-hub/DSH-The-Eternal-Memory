#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""core —— 解析 / 存储 / 索引 / 向量 / 图谱

对齐 Basic Memory 的六层：文件格式、解析、索引、同步、检索、接口。
本文件负责前四层的存储部分。
"""
import hashlib
import json
import math
import re
import sqlite3
import time
import os
from pathlib import Path

WS = Path(__file__).resolve().parents[2]
DB_PATH = WS / ".mem" / "index.db"
_DB_OVERRIDE = None   # 重建时指向临时库，建完再原子替换
CONFIG = WS / "mem.json"

OBS_RE = re.compile(r"^\s*-\s*\[([^\]]+)\]\s+(.+?)\s*$")
REL_RE = re.compile(r"^\s*-\s*([^\[\]]*?)\s*\[\[([^\]]+)\]\](.*)$")
TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)")
CTX_RE = re.compile(r"\(([^()]*)\)\s*$")
CHECKBOX = ("- [ ]", "- [x]", "- [-]")


# ---------------- 项目配置 ----------------

def load_projects():
    """mem.json: {"roots": [{"name": "main", "path": "memory"}]}，缺省为 memory/。"""
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            roots = cfg.get("roots") or []
            if roots:
                return [(r.get("name", "main"), (WS / r["path"]).resolve()) for r in roots]
        except Exception:
            pass
    return [("main", WS / "memory")]


# ---------------- 解析 ----------------

def load_project_records():
    """roots 的完整记录：[{name,title,path,workspace,workspaceId}]"""
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            roots = cfg.get("roots") or []
            if roots:
                out = []
                for r in roots:
                    out.append({
                        "name": r.get("name", "main"),
                        "title": r.get("title") or r.get("name", "main"),
                        "path": (WS / r["path"]).resolve(),
                        "workspace": r.get("workspace"),
                        "workspaceId": r.get("workspaceId"),
                    })
                return out
        except Exception:
            pass
    return [{"name": "main", "title": "main", "path": WS / "memory", "workspace": None, "workspaceId": None}]


def project_paths():
    """name -> Path，便于按项目定位根目录。"""
    return {name: root for name, root in load_projects()}


def project_for_cwd(cwd, default="main"):
    """把会话的工作目录映射到项目名：cwd 落在哪个根目录下就属于哪个项目。

    未来接入别的仓库时，只要在 mem.json 里加一条根目录，写入就会自动路由过去。
    """
    if not cwd:
        return default
    try:
        target = Path(str(cwd)).resolve()
    except Exception:
        return default
    best, best_len = default, -1
    for rec in load_project_records():
        ws = rec.get("workspace")
        if ws:
            try:
                ws_path = Path(ws).resolve()
            except Exception:
                ws_path = None
            if ws_path and (target == ws_path or ws_path in target.parents):
                if len(str(ws_path)) > best_len:
                    best, best_len = rec["name"], len(str(ws_path))
                continue
        try:
            root = rec["path"].resolve()
        except Exception:
            continue
        if target == root or root in target.parents:
            if len(str(root)) > best_len:
                best, best_len = rec["name"], len(str(root))
    return best


def split_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            meta[k.strip()] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k.strip()] = v.strip("'\"")
    return meta, m.group(2)


def _parse_date(v):
    if not v:
        return None
    import datetime
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M", "%Y/%m/%d"):
        try:
            return datetime.datetime.strptime(str(v)[:len(fmt) + 2].strip(), fmt).timestamp()
        except Exception:
            continue
    return None


CTX_FIELD_RE = re.compile(r"(page|conversation|entities|because):\s*([^·)\n]+)")


def parse_context(ctx):
    """从观察的括号上下文里取出 page / conversation / entities / because。"""
    out = {"page": None, "conv": None, "ents": [], "because": None}
    if not ctx:
        return out
    for m in CTX_FIELD_RE.finditer(ctx):
        k, v = m.group(1), m.group(2).strip()
        if not v:
            continue
        if k == "page":
            out["page"] = v
        elif k == "conversation":
            out["conv"] = v
        elif k == "entities":
            out["ents"] = [x.strip() for x in re.split(r"[|,，]", v) if x.strip()]
        elif k == "because":
            out["because"] = v
    return out


def parse_note(path, project):
    text = path.read_text(encoding="utf-8", errors="ignore")
    meta, body = split_frontmatter(text)
    obs, rels, sections = [], [], []
    in_fence, current = False, ""
    for i, line in enumerate(body.splitlines(), 1):
        s = line.lstrip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or s.startswith("    "):
            continue
        if s.startswith("## "):
            current = s[3:].strip()
            sections.append(current)
            continue
        if s.startswith(CHECKBOX):
            continue
        m = REL_RE.match(line)
        if m and "[[" in line:
            rels.append({"type": m.group(1).strip() or "relates_to",
                         "target": m.group(2).strip(),
                         "context": m.group(3).strip().strip("()")})
            continue
        m = OBS_RE.match(line)
        if m:
            cat, rest = m.group(1).strip(), m.group(2)
            ctx = ""
            if rest.endswith(")") and "(" in rest and not rest.startswith("("):
                cm = CTX_RE.search(rest)
                if cm:
                    ctx, rest = cm.group(1).strip(), rest[: cm.start()].strip()
            tags = TAG_RE.findall(rest)
            text_only = TAG_RE.sub("", rest).strip()
            obs.append({"category": cat, "text": text_only,
                        "tags": " ".join(tags), "context": ctx,
                        "line": i, "section": current})
    if str(meta.get("index", "")).lower() in ("false", "0", "no"):
        return None
    return {
        "project": project,
        "path": str(path.relative_to(WS)),
        "title": meta.get("title") or path.stem,
        "type": meta.get("type", "note"),
        "permalink": meta.get("permalink", ""),
        "tags": meta.get("tags") or [],
        "meta": meta,
        "body": body,
        "sections": sections,
        "obs": obs,
        "rel": rels,
        "mtime": path.stat().st_mtime,
        "created": _parse_date(meta.get("date") or meta.get("created")) or path.stat().st_mtime,
        "hash": hashlib.sha1(text.encode("utf-8")).hexdigest(),
    }


# ---------------- 向量（角色：语义层） ----------------

def ngram_vector(text, n=3):
    """字符 n-gram 向量（TF-IDF 之外的简单归一化词频）。

    没有神经模型时的降级方案：能处理词形变化与部分重叠，
    但**不具备同义能力**（费用 ≠ 成本）。"""
    t = re.sub(r"\s+", "", text.lower())
    if len(t) < n:
        t = (t + " " * n)[:n]
    vec = {}
    for i in range(len(t) - n + 1):
        g = t[i:i + n]
        vec[g] = vec.get(g, 0) + 1
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    return {k: v / norm for k, v in vec.items()}


def cosine(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


# ---------------- schema 校验 ----------------

SCHEMA_DIR = WS / "schemas"


def load_schemas():
    """schemas/<type>.json，形如：
    {"required": ["title", "type"], "allowed_types": ["decision"],
     "required_observations": ["决定", "原因"]}
    """
    out = {}
    if not SCHEMA_DIR.exists():
        return out
    for f in sorted(SCHEMA_DIR.glob("*.json")):
        try:
            out[f.stem] = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            pass
    return out


def validate(note, schemas):
    spec = schemas.get(note["type"])
    if not spec:
        return []
    problems = []
    for field in spec.get("required", []):
        val = note["title"] if field == "title" else note["meta"].get(field)
        if not val:
            problems.append(f"缺少字段 {field}")
    cats = {o["category"] for o in note["obs"]}
    for cat in spec.get("required_observations", []):
        if cat not in cats:
            problems.append(f"缺少 [{cat}] 类观察")
    return problems



def check_content(type_name, text, schemas):
    """写入前检查：该类型要求的观察类别，正文里是否至少出现一条。返回问题列表。"""
    spec = schemas.get(type_name or "note")
    if not spec:
        return []
    need = spec.get("required_observations") or []
    if not need:
        return []
    import re as _re
    cats = set(_re.findall(r"^-\s*\[([^\]]+)\]", text or "", flags=_re.M))
    missing = [c for c in need if c not in cats]
    if not missing:
        return []
    have = "、".join(f"[{c}]" for c in sorted(cats)) or "（没有任何类别）"
    want = "、".join(f"[{c}]" for c in missing)
    return [f"这篇是「{type_name}」类型，必须至少有一条 {want} 开头的要点；你写的是 {have}"]



def pages_index(root=None):
    """列出所有主题页面：{title, path, summary, body}"""
    base = (Path(root) if root else WS / "memory") / "pages"
    out = []
    if not base.exists():
        return out
    for f in sorted(base.glob("*.md")):
        try:
            raw = f.read_text(encoding="utf-8")
        except OSError:
            continue
        title, summary = f.stem, ""
        if raw.startswith("---"):
            end = raw.find("\n---", 3)
            if end > 0:
                fm = raw[3:end]
                for line in fm.splitlines():
                    if line.startswith("title:"):
                        title = line.split(":", 1)[1].strip().strip('"')
                    elif line.startswith("summary:"):
                        summary = line.split(":", 1)[1].strip().strip('"')
        out.append({
            "title": title,
            "path": str(f.relative_to(WS)).replace(os.sep, "/"),
            "summary": summary,
            "body": raw,
        })
    return out


def match_pages(query, limit=2, min_score=0.12):
    """按字面重合度挑出相关页面，用于注入「标题 + 摘要」而不是整页。"""
    q = set(query or "")
    out = []
    for pg in pages_index():
        text = f"{pg['title']} {pg['summary']} {pg['body'][:800]}"
        chars = set(text)
        if not chars:
            continue
        score = len(q & chars) / max(1, len(q))
        if score >= min_score:
            out.append((score, pg))
    out.sort(key=lambda x: -x[0])
    return [pg for _, pg in out[:limit]]

# ---------------- 存储 ----------------

SCHEMA = """
CREATE TABLE notes(id INTEGER PRIMARY KEY, project TEXT, path TEXT UNIQUE,
                   title TEXT, type TEXT, permalink TEXT, tags TEXT,
                   mtime REAL, created REAL, hash TEXT, body TEXT);
CREATE TABLE obs(id INTEGER PRIMARY KEY, note_id INT, category TEXT, text TEXT,
                 tags TEXT, context TEXT, line INT, section TEXT,
                 page TEXT, conv TEXT, ents TEXT, because TEXT);
CREATE TABLE rel(id INTEGER PRIMARY KEY, note_id INT, rtype TEXT, target TEXT);
CREATE TABLE vec(id INTEGER PRIMARY KEY, note_id INT, dim INT, data BLOB);
CREATE TABLE obs_vec(id INTEGER PRIMARY KEY, obs_id INT, note_id INT, data BLOB);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE entities(id INTEGER PRIMARY KEY, norm TEXT UNIQUE, name TEXT, kind TEXT,
                      first_seen REAL, seen INT DEFAULT 1);
CREATE TABLE fact_entity(fact_id INT, entity_id INT, PRIMARY KEY(fact_id, entity_id));
CREATE TABLE edges(id INTEGER PRIMARY KEY, a INT, b INT, etype TEXT, weight REAL,
                   computed_at REAL, UNIQUE(a,b,etype));
CREATE INDEX idx_edges_a ON edges(a);
CREATE INDEX idx_edges_b ON edges(b);
CREATE INDEX idx_fact_entity_e ON fact_entity(entity_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes',
                 content_rowid='id', tokenize='trigram');
CREATE VIRTUAL TABLE obs_fts USING fts5(text, category, tags, context,
                 content='obs', content_rowid='id', tokenize='trigram');
"""


def connect():
    target = _DB_OVERRIDE or DB_PATH
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target)
    db.execute("PRAGMA journal_mode=WAL")
    return db


def _pack(vec):
    import struct
    items = sorted(vec.items())
    return struct.pack(f"<{len(items)}Hf", *[x for k, v in items for x in (hash(k) & 0xFFFF, v)])


def build(verbose=True, rebuild=True, edges_enabled=True):
    """索引或增量更新。rebuild=False 时按 hash 跳过未变文件。

    rebuild=True 时先建到临时库、成功后原子替换，避免重建期间读者看到「no such table」。
    同时用文件锁阻止并发重建。
    """
    global _DB_OVERRIDE

    if rebuild:
        lock = DB_PATH.with_suffix(".lock")
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
        except FileExistsError:
            # 已有重建在进行：本次直接跳过，避免两个进程互相踩
            if verbose:
                print("另一个重建正在进行，跳过本次")
            return {"new": 0, "skip": 0, "notes": 0, "obs": 0, "rel": 0, "busy": True}
        tmp = DB_PATH.with_suffix(".db.build")
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(tmp) + suffix).unlink()
            except FileNotFoundError:
                pass
        _DB_OVERRIDE = str(tmp)
    else:
        lock = None
    db = connect()
    if rebuild:
        db.executescript(SCHEMA)
    seen, stats = set(), {"new": 0, "skip": 0, "notes": 0, "obs": 0, "rel": 0}
    pending = []
    pending_obs = []
    schemas, violations = load_schemas(), []
    old = {}
    if not rebuild:
        old = {r[0]: r[1] for r in db.execute("SELECT path, hash FROM notes")}

    for project, root in load_projects():
        if not root.exists():
            continue
        for f in sorted(root.rglob("*.md")):
            note = parse_note(f, project)
            if note is None:
                continue
            seen.add(note["path"])
            if not rebuild and old.get(note["path"]) == note["hash"]:
                stats["skip"] += 1
                continue
            db.execute("DELETE FROM obs WHERE note_id IN (SELECT id FROM notes WHERE path=?)",
                       (note["path"],))
            db.execute("DELETE FROM rel WHERE note_id IN (SELECT id FROM notes WHERE path=?)",
                       (note["path"],))
            db.execute("DELETE FROM vec WHERE note_id IN (SELECT id FROM notes WHERE path=?)",
                       (note["path"],))
            db.execute("DELETE FROM obs_vec WHERE note_id IN (SELECT id FROM notes WHERE path=?)",
                       (note["path"],))
            db.execute("DELETE FROM notes WHERE path=?", (note["path"],))
            cur = db.execute(
                "INSERT INTO notes(project,path,title,type,permalink,tags,mtime,created,hash,body)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (note["project"], note["path"], note["title"], note["type"],
                 note["permalink"], ",".join(note["tags"]), note["mtime"],
                 note["created"], note["hash"], note["body"]),
            )
            nid = cur.lastrowid
            for o in note["obs"]:
                cx = parse_context(o["context"])
                cur2 = db.execute(
                    "INSERT INTO obs(note_id,category,text,tags,context,line,section,"
                    "page,conv,ents,because) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (nid, o["category"], o["text"], o["tags"], o["context"],
                     o["line"], o["section"], cx["page"], cx["conv"],
                     json.dumps(cx["ents"], ensure_ascii=False) if cx["ents"] else None,
                     cx["because"]))
                pending_obs.append((cur2.lastrowid, nid,
                                    f"[{o['category']}] {o['text']} {o['tags']} {o['context']}".strip()))
            for r in note["rel"]:
                db.execute("INSERT INTO rel(note_id,rtype,target) VALUES(?,?,?)",
                           (nid, r["type"], r["target"]))
            # 向量延后批量计算：标题权重加倍 + 正文
            pending.append((nid, note["title"] * 2 + " " + note["body"]))
            for prob in validate(note, schemas):
                violations.append((note["path"], prob))
            stats["new"] += 1
            stats["obs"] += len(note["obs"])
            stats["rel"] += len(note["rel"])

    if pending:
        import embed as E
        vectors, prov = [], ""
        try:
            for i in range(0, len(pending), 64):
                chunk = pending[i:i + 64]
                vecs, prov = E.embed_texts([t for _, t in chunk])
                vectors.extend(zip([nid for nid, _ in chunk], vecs))
        except Exception as e:  # 网络/模型失败 → 降级
            print(f"⚠ 向量化失败（{e}），降级为 ngram")
            vectors = [(nid, ngram_vector(t)) for nid, t in pending]
            prov = "ngram"
        db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('embed_provider',?)", (prov,))
        for nid, v in vectors:
            db.execute("INSERT INTO vec(note_id,dim,data) VALUES(?,?,?)",
                       (nid, len(v) if not isinstance(v, dict) else 0,
                        json.dumps(v)))
        if pending_obs:
            try:
                ob_vecs, prov2 = [], prov
                for i in range(0, len(pending_obs), 64):
                    chunk = pending_obs[i:i + 64]
                    vs, prov2 = E.embed_texts([t for _, _, t in chunk])
                    ob_vecs.extend(zip([oid for oid, _, _ in chunk],
                                       [nid for _, nid, _ in chunk], vs))
            except Exception as e:
                print(f"⚠ 观察向量化失败（{e}），降级为 ngram")
                ob_vecs = [(oid, nid, ngram_vector(t)) for oid, nid, t in pending_obs]
                prov2 = "ngram"
            for oid, nid, v in ob_vecs:
                db.execute("INSERT INTO obs_vec(obs_id,note_id,data) VALUES(?,?,?)",
                           (oid, nid, json.dumps(v)))
            stats["obs_vec"] = len(ob_vecs)
        stats["embed"] = prov
        stats["embed_obs"] = prov2 if pending_obs else prov

    gone = set(old) - seen
    for p in gone:
        db.execute("DELETE FROM notes WHERE path=?", (p,))

    db.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')")
    db.execute("INSERT INTO obs_fts(obs_fts) VALUES('rebuild')")
    db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('built_at',?)", (str(time.time()),))
    db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('schema_version','2')")
    db.commit()

    if edges_enabled:
        import edges as EG
        try:
            stats["edges"] = EG.build(db, verbose=verbose)
        except Exception as e:
            print(f"⚠ 关系边生成失败（{e}），其余功能不受影响")

    stats["notes"] = db.execute("SELECT count(*) FROM notes").fetchone()[0]
    db.close()

    if rebuild:
        # 临时库建好后原子替换，读者要么看到旧库、要么看到新库，不会看到半成品
        try:
            for suffix in ("-wal", "-shm"):
                try:
                    Path(str(tmp) + suffix).unlink()
                except FileNotFoundError:
                    pass
            os.replace(str(tmp), str(DB_PATH))
        finally:
            _DB_OVERRIDE = None
            try:
                lock.unlink()
            except FileNotFoundError:
                pass
    if violations:
        print(f"⚠ schema 校验：{len(violations)} 处不合规")
        for path, prob in violations[:8]:
            print(f"   {path}: {prob}")
    if verbose:
        print(f"索引：{stats['notes']} 篇（新增/更新 {stats['new']}，跳过 {stats['skip']}，"
              f"移除 {len(gone)}），{stats['obs']} 条观察，{stats['rel']} 条关系"
              + (f"，向量 {stats['embed']}" if stats.get("embed") else "")
              + (f"（含 {stats.get('obs_vec', 0)} 条观察向量）" if stats.get("obs_vec") else ""))
    return stats
