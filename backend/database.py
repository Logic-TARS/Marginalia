"""SQLite storage layer for Marginalia highlights."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional
import uuid

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
                client_id TEXT DEFAULT '',
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
                updated_at TEXT,
                status TEXT DEFAULT 'raw',
                synced_to_feishu INTEGER DEFAULT 0
            )
        """)
        await _ensure_column(db, "client_id", "TEXT DEFAULT ''")
        await _ensure_column(db, "updated_at", "TEXT")
        await _ensure_column(db, "status", "TEXT DEFAULT 'raw'")
        await db.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_client_id
            ON highlights(client_id)
            WHERE client_id IS NOT NULL AND client_id != ''
            """
        )
        await db.execute("""
            CREATE TABLE IF NOT EXISTS drafts (
                id TEXT PRIMARY KEY,
                target TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                source_highlight_ids TEXT DEFAULT '[]',
                created_at TEXT,
                updated_at TEXT,
                exported_to_obsidian INTEGER DEFAULT 0
            )
        """)
        await db.commit()


async def _ensure_column(db: aiosqlite.Connection, name: str, definition: str) -> None:
    rows = await db.execute_fetchall("PRAGMA table_info(highlights)")
    columns = {row[1] for row in rows}
    if name not in columns:
        await db.execute(f"ALTER TABLE highlights ADD COLUMN {name} {definition}")


async def save_highlights(highlights: list[dict]) -> list[str]:
    """Upsert highlights into the database. Returns list of server IDs."""
    items = await upsert_highlights(highlights)
    return [item["id"] for item in items]


async def upsert_highlights(highlights: list[dict]) -> list[dict]:
    """Insert or update highlights. Returns server/client ID mappings."""
    import uuid
    from datetime import datetime, timezone

    items = []
    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(str(DB_PATH)) as db:
        for h in highlights:
            client_id = h.get("client_id") or h.get("id") or ""
            existing_id = await _find_existing_highlight_id(db, h, client_id)
            tags_json = json.dumps(h.get("tags", []), ensure_ascii=False)

            if existing_id:
                await db.execute(
                    """
                    UPDATE highlights
                    SET client_id = COALESCE(NULLIF(?, ''), client_id),
                        book_title = ?, book_author = ?, chapter = ?, cfi = ?,
                        highlight_text = ?, note = ?, tags = ?, color = ?,
                        created_at = ?, progress_percent = ?, updated_at = ?,
                        status = ?
                    WHERE id = ?
                    """,
                    (
                        client_id,
                        h.get("book_title", ""),
                        h.get("book_author", ""),
                        h.get("chapter", ""),
                        h.get("cfi", ""),
                        h.get("highlight_text", ""),
                        h.get("note", ""),
                        tags_json,
                        h.get("color", "yellow"),
                        _jsonable_datetime(h.get("created_at", now)),
                        h.get("progress_percent", 0.0),
                        now,
                        _highlight_status(h),
                        existing_id,
                    ),
                )
                items.append({"id": existing_id, "client_id": client_id, "action": "updated"})
            else:
                hid = str(uuid.uuid4())
                await db.execute(
                    """
                    INSERT INTO highlights
                        (id, client_id, book_title, book_author, chapter, cfi,
                         highlight_text, note, tags, color,
                         created_at, progress_percent, received_at, updated_at,
                         status, synced_to_feishu)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (
                        hid,
                        client_id,
                        h.get("book_title", ""),
                        h.get("book_author", ""),
                        h.get("chapter", ""),
                        h.get("cfi", ""),
                        h.get("highlight_text", ""),
                        h.get("note", ""),
                        tags_json,
                        h.get("color", "yellow"),
                        _jsonable_datetime(h.get("created_at", now)),
                        h.get("progress_percent", 0.0),
                        now,
                        now,
                        _highlight_status(h),
                    ),
                )
                items.append({"id": hid, "client_id": client_id, "action": "created"})
        await db.commit()

    return items


async def _find_existing_highlight_id(
    db: aiosqlite.Connection, h: dict, client_id: str
) -> str | None:
    if client_id:
        cursor = await db.execute(
            "SELECT id FROM highlights WHERE client_id = ? OR id = ?",
            (client_id, client_id),
        )
        row = await cursor.fetchone()
        if row:
            return row[0]

        cursor = await db.execute(
            """
            SELECT id FROM highlights
            WHERE (client_id IS NULL OR client_id = '')
              AND book_title = ?
              AND cfi = ?
              AND created_at = ?
              AND highlight_text = ?
            """,
            (
                h.get("book_title", ""),
                h.get("cfi", ""),
                _jsonable_datetime(h.get("created_at", "")),
                h.get("highlight_text", ""),
            ),
        )
        row = await cursor.fetchone()
        if row:
            return row[0]
    return None


async def get_all_highlights(
    book_title: Optional[str] = None, limit: int = 100, offset: int = 0
) -> list[dict]:
    """Fetch highlights, optionally filtered by book title."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
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


async def get_materials(
    book_title: Optional[str] = None,
    tag: Optional[str] = None,
    status: Optional[str] = None,
    has_note: Optional[bool] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """Fetch highlight materials for the creation workspace."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        conditions = []
        params = []
        if book_title:
            conditions.append("book_title LIKE ?")
            params.append(f"%{book_title}%")
        if status:
            conditions.append("status = ?")
            params.append(status)
        if has_note is True:
            conditions.append("note IS NOT NULL AND note != ''")
        elif has_note is False:
            conditions.append("(note IS NULL OR note = '')")

        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        query = f"SELECT * FROM highlights{where} ORDER BY received_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = await db.execute_fetchall(query, params)
        results = [_row_to_dict(r) for r in rows]

        # tag filter requires Python-side check (JSON array), but dataset is now much smaller
        if tag:
            results = [h for h in results if tag in h.get("tags", [])]

        return results


async def get_highlights_by_ids(ids: list[str]) -> list[dict]:
    """Fetch specific highlights by their IDs."""
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            f"SELECT * FROM highlights WHERE id IN ({placeholders}) OR client_id IN ({placeholders})",
            [*ids, *ids],
        )
        return [_row_to_dict(r) for r in rows]


async def get_highlight(identifier: str) -> dict | None:
    """Fetch one highlight by server ID or client ID."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM highlights WHERE id = ? OR client_id = ?",
            (identifier, identifier),
        )
        row = await cursor.fetchone()
        return _row_to_dict(row) if row else None


async def update_highlight(identifier: str, data: dict) -> dict | None:
    """Update editable fields and return the updated highlight."""
    from datetime import datetime, timezone

    allowed = {
        "book_title", "book_author", "chapter", "cfi", "highlight_text",
        "note", "tags", "color", "progress_percent", "status",
    }
    values = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not values:
        return await get_highlight(identifier)

    if "tags" in values:
        values["tags"] = json.dumps(values["tags"], ensure_ascii=False)
    if "note" in values and "status" not in values:
        values["status"] = "reflected" if str(values["note"]).strip() else "raw"
    values["updated_at"] = datetime.now(timezone.utc).isoformat()

    assignments = ", ".join(f"{key} = ?" for key in values)
    params = [*values.values(), identifier, identifier]

    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            f"UPDATE highlights SET {assignments} WHERE id = ? OR client_id = ?",
            params,
        )
        await db.commit()

    return await get_highlight(identifier)


async def delete_highlight(identifier: str, legacy_match: Optional[dict] = None) -> bool:
    """Delete a highlight by ID/client ID, with an optional legacy exact match."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        cursor = await db.execute(
            "DELETE FROM highlights WHERE id = ? OR client_id = ?",
            (identifier, identifier),
        )
        deleted = cursor.rowcount

        if deleted == 0 and legacy_match:
            cursor = await db.execute(
                """
                DELETE FROM highlights
                WHERE (client_id IS NULL OR client_id = '')
                  AND book_title = ?
                  AND cfi = ?
                  AND created_at = ?
                  AND highlight_text = ?
                """,
                (
                    legacy_match.get("book_title", ""),
                    legacy_match.get("cfi", ""),
                    _jsonable_datetime(legacy_match.get("created_at", "")),
                    legacy_match.get("highlight_text", ""),
                ),
            )
            deleted = cursor.rowcount

        await db.commit()
        return deleted > 0


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
    d = dict(row)

    # Parse tags from JSON string
    try:
        d["tags"] = json.loads(d["tags"]) if isinstance(d["tags"], str) else d["tags"]
    except (json.JSONDecodeError, TypeError):
        d["tags"] = []

    d["synced_to_feishu"] = bool(d["synced_to_feishu"])
    return d


def _jsonable_datetime(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _highlight_status(highlight: dict) -> str:
    explicit = highlight.get("status")
    if explicit and (explicit != "raw" or not str(highlight.get("note", "")).strip()):
        return explicit
    return "reflected" if str(highlight.get("note", "")).strip() else "raw"


def _row_json_list(value: Any) -> list:
    try:
        if isinstance(value, str):
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        return value if isinstance(value, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _row_json_dict(value: Any) -> dict:
    try:
        if isinstance(value, str):
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _draft_row_to_dict(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["metadata"] = _row_json_dict(d.get("metadata"))
    d["source_highlight_ids"] = _row_json_list(d.get("source_highlight_ids"))
    d["exported_to_obsidian"] = bool(d.get("exported_to_obsidian"))
    return d


async def create_draft(
    target: str,
    title: str,
    content: str,
    source_highlight_ids: list[str],
    metadata: Optional[dict] = None,
) -> dict:
    """Create a generated content draft."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    draft_id = str(uuid.uuid4())
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO drafts
                (id, target, title, content, metadata, source_highlight_ids,
                 created_at, updated_at, exported_to_obsidian)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                draft_id,
                target,
                title,
                content,
                json.dumps(metadata or {}, ensure_ascii=False),
                json.dumps(source_highlight_ids, ensure_ascii=False),
                now,
                now,
            ),
        )
        await db.commit()
    draft = await get_draft(draft_id)
    return draft or {}


async def list_drafts(target: Optional[str] = None, limit: int = 100, offset: int = 0) -> list[dict]:
    """List content drafts."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        if target:
            rows = await db.execute_fetchall(
                "SELECT * FROM drafts WHERE target = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (target, limit, offset),
            )
        else:
            rows = await db.execute_fetchall(
                "SELECT * FROM drafts ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        return [_draft_row_to_dict(r) for r in rows]


async def get_draft(draft_id: str) -> dict | None:
    """Fetch one draft."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,))
        row = await cursor.fetchone()
        return _draft_row_to_dict(row) if row else None


async def update_draft(draft_id: str, data: dict) -> dict | None:
    """Update a draft and return it."""
    from datetime import datetime, timezone

    allowed = {"title", "content", "metadata", "exported_to_obsidian"}
    values = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not values:
        return await get_draft(draft_id)
    if "metadata" in values:
        values["metadata"] = json.dumps(values["metadata"], ensure_ascii=False)
    if "exported_to_obsidian" in values:
        values["exported_to_obsidian"] = 1 if values["exported_to_obsidian"] else 0
    values["updated_at"] = datetime.now(timezone.utc).isoformat()
    assignments = ", ".join(f"{key} = ?" for key in values)
    params = [*values.values(), draft_id]

    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(f"UPDATE drafts SET {assignments} WHERE id = ?", params)
        await db.commit()
    return await get_draft(draft_id)


async def delete_draft(draft_id: str) -> bool:
    """Delete a draft."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        cursor = await db.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
        await db.commit()
        return cursor.rowcount > 0


NOTES_JSON_PATH = Path(__file__).parent / "data" / "notes.json"


async def export_all_to_json() -> Path:
    """Export all highlights from SQLite to a standard JSON file on disk."""
    all_highlights = await get_all_highlights(limit=100000, offset=0)
    entries = []
    for h in all_highlights:
        entries.append({
            "book_title": h.get("book_title", ""),
            "book_author": h.get("book_author", ""),
            "chapter": h.get("chapter", ""),
            "highlight_text": h.get("highlight_text", ""),
            "note": h.get("note", ""),
            "tags": h.get("tags", []),
            "color": h.get("color", "yellow"),
            "progress_percent": h.get("progress_percent", 0),
            "created_at": h.get("created_at", ""),
            "updated_at": h.get("updated_at", ""),
            "status": h.get("status", "raw"),
        })
    NOTES_JSON_PATH.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return NOTES_JSON_PATH
