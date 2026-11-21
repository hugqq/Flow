import os
import stat
import time
from pathlib import Path


def is_link(entry):
    if entry.is_symlink():
        return True
    return os.name == "nt" and bool(
        entry.stat(follow_symlinks=False).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def scan_loop(library):
    while True:
        library.wakeup.clear()
        with library.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM sources WHERE state='queued' ORDER BY id LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE sources SET state='scanning', generation=generation+1, detail='' WHERE id=?",
                           (row["id"],))
        if not row:
            library.wakeup.wait()
            continue
        try:
            scan_source(library, row["id"], row["path"], row["generation"] + 1)
        except Exception as error:
            with library.connect() as db:
                db.execute("UPDATE sources SET state='error', detail=? "
                           "WHERE id=? AND path=? AND generation=? AND state='scanning'",
                           (str(error), row["id"], row["path"], row["generation"] + 1))


def scan_source(library, source_id, source_path, generation):
    root = library.directory(source_path)
    batch = []
    skipped = 0
    last_flush = 0

    def flush(finished=False):
        nonlocal last_flush
        with library.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM sources WHERE id=? AND path=? AND generation=? AND state='scanning'",
                              (source_id, str(source_path), generation)).fetchone():
                return False
            db.executemany("""
                INSERT INTO videos(source_id, relative, generation) VALUES (?, ?, ?)
                ON CONFLICT(source_id, relative) DO UPDATE SET generation=excluded.generation
            """, batch)
            if finished:
                if not skipped:
                    db.execute("DELETE FROM videos WHERE source_id=? AND generation!=?", (source_id, generation))
                detail = f"有 {skipped} 个位置无法读取，已保留原有索引" if skipped else ""
                db.execute("UPDATE sources SET state='ready', detail=? WHERE id=?", (detail, source_id))
        batch.clear()
        last_flush = time.monotonic()
        return True

    stack = [os.scandir(root)]
    try:
        while stack:
            try:
                entry = next(stack[-1], None)
            except OSError:
                skipped += 1
                entry = None
            if entry is None:
                stack.pop().close()
                continue
            try:
                if is_link(entry):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(os.scandir(entry.path))
                elif Path(entry.name).suffix.lower() in library.formats and entry.is_file(follow_symlinks=False):
                    batch.append((source_id, os.path.relpath(entry.path, root), generation))
            except OSError:
                skipped += 1
            if len(batch) >= 256 or time.monotonic() - last_flush > 0.7:
                if not flush():
                    return
    finally:
        for entries in stack:
            entries.close()
    flush(finished=True)
