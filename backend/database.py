"""SQLite storage layer for Marginalia highlights."""

import json
import os
from pathlib import Path

import aiosqlite

from config import settings

# Ensure data directory exists
DB_PATH = Path(__file__).parent / "data" / "marginalia.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


async def init_db() -> None:
    """Create tables if they don't exist."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS highlights (
                id TEXT PRIMARY KEY,
                book_title TEXT NOT NULL,
                book_author TEXT DEFAULT '',
                chapter TEXT DEFAULT '',
                cfi TEXT DEFAULT '',
                highlight_text TEXT NOT NULL,
                note TEXT DEFAULT '',
                tags TEXT DEFAULT '[]',
                color TEXT DEFAULT 'yellow',
                created_at TEXT,
                progress_percent REAL DEFAULT 0.0,
                received_at TEXT,
                synced_to_feishu INTEGER DEFAULT 0
            )
        """)
        await db.commit()


async def save_highlights(highlights: list[dict]) -> list[str]:
    """Insert highlights into the database. Returns list of assigned IDs."""
    import uuid
    from datetime import datetime, timezone

    ids = []
    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(str(DB_PATH)) as db:
        for h in highlights:
            hid = str(uuid.uuid4())
            ids.append(hid)

            tags_json = json.dumps(h.get("tags", []), ensure_ascii=False)

            await db.execute(
                """
                INSERT INTO highlights
                    (id, book_title, book_author, chapter, cfi,
                     highlight_text, note, tags, color,
                     created_at, progress_percent, received_at, synced_to_feishu)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    hid,
                    h.get("book_title", ""),
                    h.get("book_author", ""),
                    h.get("chapter", ""),
                    h.get("cfi", ""),
                    h.get("highlight_text", ""),
                    h.get("note", ""),
                    tags_json,
                    h.get("color", "yellow"),
                    h.get("created_at", now),
                    h.get("progress_percent", 0.0),
                    now,
                ),
            )
        await db.commit()

    return ids


async def get_all_highlights(
    book_title: str | None = None, limit: int = 100, offset: int = 0
) -> list[dict]:
    """Fetch highlights, optionally filtered by book title."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        if book_title:
            rows = await db.execute_fetchall(
                "SELECT * FROM highlights WHERE book_title LIKE ? ORDER BY received_at DESC LIMIT ? OFFSET ?",
                (f"%{book_title}%", limit, offset),
            )
        else:
            rows = await db.execute_fetchall(
                "SELECT * FROM highlights ORDER BY received_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        return [_row_to_dict(r) for r in rows]


async def get_highlights_by_ids(ids: list[str]) -> list[dict]:
    """Fetch specific highlights by their IDs."""
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        rows = await db.execute_fetchall(
            f"SELECT * FROM highlights WHERE id IN ({placeholders})",
            ids,
        )
        return [_row_to_dict(r) for r in rows]


async def mark_feishu_synced(ids: list[str]) -> None:
    """Mark highlights as having been sent to Feishu."""
    if not ids:
        return
    placeholders = ",".join("?" for _ in ids)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            f"UPDATE highlights SET synced_to_feishu = 1 WHERE id IN ({placeholders})",
            ids,
        )
        await db.commit()


def _row_to_dict(row: aiosqlite.Row) -> dict:
    """Convert a SQLite row to a dictionary."""
    columns = [
        "id", "book_title", "book_author", "chapter", "cfi",
        "highlight_text", "note", "tags", "color",
        "created_at", "progress_percent", "received_at", "synced_to_feishu",
    ]
    d = dict(zip(columns, row))

    # Parse tags from JSON string
    try:
        d["tags"] = json.loads(d["tags"]) if isinstance(d["tags"], str) else d["tags"]
    except (json.JSONDecodeError, TypeError):
        d["tags"] = []

    d["synced_to_feishu"] = bool(d["synced_to_feishu"])
    return d
