import contextlib
import os
import sqlite3
import threading
from pathlib import Path

from . import FORMATS, IMAGE_FORMATS, RequestError
from .media import Transcoder
from .scanner import is_link, scan_loop


VIDEO_GROUP = "CASE WHEN video_directory(relative) = '' THEN id ELSE video_directory(relative) END"


SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    total INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL REFERENCES sources(id),
    relative TEXT NOT NULL, generation INTEGER NOT NULL,
    UNIQUE(source_id, relative)
);
CREATE INDEX IF NOT EXISTS videos_source ON videos(source_id, id);
DROP INDEX IF EXISTS videos_favorite;
DROP TRIGGER IF EXISTS favorite_changed;
DROP TRIGGER IF EXISTS video_removed;
CREATE TRIGGER IF NOT EXISTS video_added AFTER INSERT ON videos BEGIN
    UPDATE sources SET total = total + 1 WHERE id = new.source_id;
END;
CREATE TRIGGER IF NOT EXISTS video_count_removed AFTER DELETE ON videos BEGIN
    UPDATE sources SET total = total - 1 WHERE id = old.source_id;
END;
COMMIT;
"""


class Library:
    def __init__(self, data_dir, roots, *, images=False):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.database = data_dir / ("images.sqlite3" if images else "flow.sqlite3")
        self.formats = IMAGE_FORMATS if images else FORMATS
        self.media_name = "图片" if images else "视频"
        self.roots = roots
        self.wakeup = threading.Event()
        self.transcoder = None if images else Transcoder()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            db.execute("UPDATE sources SET state = 'queued' WHERE state = 'scanning'")
            if not images and db.execute("PRAGMA user_version").fetchone()[0] == 0:
                # 已有视频库需要重新扫描，才能收录以前跳过的 MKV。
                db.execute("UPDATE sources SET state='queued', detail=''")
                db.execute("PRAGMA user_version=1")
        threading.Thread(target=scan_loop, args=(self,), daemon=True).start()

    @contextlib.contextmanager
    def connect(self):
        with contextlib.closing(sqlite3.connect(self.database, timeout=15)) as db:
            db.row_factory = sqlite3.Row
            with db:
                yield db

    def permitted(self, path):
        return not self.roots or any(path.is_relative_to(root) for root in self.roots)

    def directory(self, raw):
        if not isinstance(raw, str) or not raw or not Path(raw).is_absolute():
            raise RequestError("请输入服务器上的文件夹绝对路径")
        path = Path(raw).resolve()
        if not self.permitted(path):
            raise RequestError("文件夹超出服务允许的目录范围", 403)
        if not path.is_dir():
            raise RequestError("找不到该文件夹，或服务没有读取权限", 404)
        return path

    def browse(self, raw, offset):
        if not raw:
            roots = self.roots
            if not roots:
                roots = ([Path(drive + ":/") for drive in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                          if Path(drive + ":/").is_dir()] if os.name == "nt" else [Path("/")])
            return {"path": "", "parent": None, "folders": [
                {"name": str(root), "path": str(root)} for root in roots
            ], "more": False}
        path = self.directory(raw)
        folders = []
        seen = 0
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    if not entry.is_dir(follow_symlinks=False) or is_link(entry):
                        continue
                except OSError:
                    continue
                if seen >= offset:
                    folders.append({"name": entry.name, "path": entry.path})
                    if len(folders) == 101:
                        break
                seen += 1
        parent = path.parent
        return {"path": str(path), "parent": str(parent) if parent != path and self.permitted(parent) else "",
                "folders": folders[:100], "more": len(folders) > 100}

    def add(self, raw):
        path = self.directory(raw)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in db.execute("SELECT id, path, state FROM sources"):
                existing = Path(row["path"])
                if path == existing:
                    if row["state"] not in ("queued", "scanning"):
                        db.execute("UPDATE sources SET state='queued', detail='' WHERE id=?", (row["id"],))
                    source_id = row["id"]
                    break
                if path.is_relative_to(existing) or existing.is_relative_to(path):
                    raise RequestError("此目录与已引入的文件夹重叠，请选择其他目录")
            else:
                source_id = db.execute("INSERT INTO sources(path) VALUES (?)", (str(path),)).lastrowid
        self.wakeup.set()
        return {"id": source_id}

    def remove(self, raw):
        if not isinstance(raw, str) or not Path(raw).is_absolute():
            raise RequestError("请选择已引入的文件夹")
        if not self.permitted(Path(raw)):
            raise RequestError("文件夹超出服务允许的目录范围", 403)
        with self.connect() as db:
            db.execute("DELETE FROM videos WHERE source_id=(SELECT id FROM sources WHERE path=?)", (raw,))
            db.execute("DELETE FROM sources WHERE path=?", (raw,))
        return {}

    def status(self, joined=False):
        joined_counts = {}
        with self.connect() as db:
            rows = db.execute("SELECT id,path,state,total,detail FROM sources ORDER BY id").fetchall()
            if joined:
                db.create_function("video_directory", 1, os.path.dirname, deterministic=True)
                joined_counts = dict(db.execute(
                    f"SELECT source_id, COUNT(DISTINCT {VIDEO_GROUP}) FROM videos GROUP BY source_id"
                ).fetchall())
        sources = [dict(row, name=Path(row["path"]).name or row["path"])
                   for row in rows if self.permitted(Path(row["path"]))]
        if joined:
            for source in sources:
                source["joined_total"] = joined_counts.get(source["id"], 0)
        return {"sources": sources, "ffmpeg": bool(self.transcoder and self.transcoder.ffmpeg)}

    def video_page(self, anchor, reverse, source, with_duration=False, joined=False, group=0, clip=0, offset=0):
        if with_duration and not group:
            raise RequestError("请选择一个拼接视频")
        clauses = []
        params = []
        if source:
            clauses.append("v.source_id = ?")
            params.append(source)
        if anchor and not joined:
            clauses.append("v.id < ?" if reverse else "v.id > ?")
            params.append(anchor)
        if self.roots:
            with self.connect() as db:
                excluded = [row["id"] for row in db.execute("SELECT id,path FROM sources")
                            if not self.permitted(Path(row["path"]))]
            if excluded:
                clauses.append("v.source_id NOT IN (" + ",".join("?" for _ in excluded) + ")")
                params.extend(excluded)
        order = "DESC" if reverse else "ASC"
        with self.connect() as db:
            if joined or group:
                db.create_function("video_directory", 1, os.path.dirname, deterministic=True)
            if group:
                seed = db.execute("SELECT source_id,relative FROM videos WHERE id=?", (group,)).fetchone()
                if not seed or not os.path.dirname(seed["relative"]):
                    return []
                clauses.extend(("v.source_id = ?", "video_directory(v.relative) = ?"))
                params.extend((seed["source_id"], os.path.dirname(seed["relative"])))
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            query = ("SELECT v.id,v.source_id,v.relative,s.path FROM videos v "
                     "JOIN sources s ON s.id=v.source_id" + where)
            if joined:
                query = (f"WITH entries AS ({query}), grouped AS ("
                         "SELECT MIN(id) AS first_id, COUNT(*) AS group_size, MAX(id = ?) AS has_clip "
                         f"FROM entries GROUP BY source_id, {VIDEO_GROUP}) "
                         "SELECT e.*, g.group_size FROM grouped g JOIN entries e ON e.id=g.first_id")
                params.append(clip)
                if clip:
                    query += " WHERE g.has_clip"
                elif anchor:
                    query += " WHERE e.id < ?" if reverse else " WHERE e.id > ?"
                    params.append(anchor)
                query += f" ORDER BY e.id {order} LIMIT 20"
            else:
                query += f" ORDER BY v.id {order}"
                if not group or with_duration or anchor or reverse:
                    query += " LIMIT 20"
                    if offset:
                        query += " OFFSET ?"
                        params.append(offset)
            rows = db.execute(query, params).fetchall()
        result = []
        for row in rows:
            path = Path(row["relative"])
            root = Path(row["path"])
            item = {"id": row["id"], "source_id": row["source_id"], "name": path.name,
                    "folder": str(Path(root.name or root.anchor) / path.parent),
                    "format": path.suffix[1:].upper()}
            if joined:
                item["group_size"] = row["group_size"]
            if with_duration:
                try:
                    item["duration"] = self.transcoder.duration(self.resolve_media_path(root, path))
                except (OSError, RequestError):
                    item["duration"] = None
            result.append(item)
        return result

    def media_path(self, video_id):
        with self.connect() as db:
            row = db.execute("SELECT s.path,v.relative FROM videos v JOIN sources s ON v.source_id=s.id "
                             "WHERE v.id=?", (video_id,)).fetchone()
        if row:
            return self.resolve_media_path(Path(row["path"]), row["relative"])
        raise RequestError(f"原{self.media_name}已移动或无法读取", 404)

    def resolve_media_path(self, root, relative):
        candidate = root / relative
        path = candidate.resolve()
        if (path == candidate and self.permitted(path) and path.is_relative_to(root)
                and path.suffix.lower() in self.formats and path.is_file()):
            return path
        raise RequestError(f"原{self.media_name}已移动或无法读取", 404)

