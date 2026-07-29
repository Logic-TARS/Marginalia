"""Persistent server EPUB library and cross-device reader state."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import HTTPException
from fastapi.responses import FileResponse

import database
from books_api import BOOKS_DIR, EPUB_MIME
from config import settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _connect() -> aiosqlite.Connection:
    db = await aiosqlite.connect(str(database.DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    return db


async def init_library_db() -> None:
    """Create the canonical server library and reader-sync tables."""
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    db = await _connect()
    try:
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS library_books (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                author TEXT DEFAULT '',
                original_filename TEXT NOT NULL,
                storage_filename TEXT NOT NULL UNIQUE,
                file_size INTEGER NOT NULL DEFAULT 0,
                knowledge_book_id TEXT,
                state_revision INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reading_states (
                book_id TEXT PRIMARY KEY,
                cfi TEXT DEFAULT '',
                progress_percent REAL NOT NULL DEFAULT 0,
                last_opened INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(book_id) REFERENCES library_books(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS reader_bookmarks (
                id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL,
                chapter TEXT DEFAULT '',
                cfi TEXT DEFAULT '',
                progress_percent REAL NOT NULL DEFAULT 0,
                label TEXT DEFAULT '',
                created_at TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(book_id) REFERENCES library_books(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_book
                ON reader_bookmarks(book_id);
            CREATE TABLE IF NOT EXISTS reader_sync_operations (
                op_id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                received_at TEXT NOT NULL,
                FOREIGN KEY(book_id) REFERENCES library_books(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_reader_sync_operations_book
                ON reader_sync_operations(book_id);
            """
        )
        await db.commit()
    finally:
        await db.close()


async def reconcile_legacy_books() -> None:
    """Register EPUBs that were manually placed in backend/data/books."""
    for path in sorted(BOOKS_DIR.glob("*.epub")):
        db = await _connect()
        try:
            row = await db.execute_fetchall(
                "SELECT id FROM library_books WHERE storage_filename = ?", (path.name,)
            )
        finally:
            await db.close()
        if row:
            continue
        try:
            await _register_existing_file(path, path.name)
        except Exception:
            # One bad legacy file must not prevent the service from starting.
            continue


async def _register_existing_file(path: Path, original_filename: str) -> dict:
    from knowledge import _read_epub_metadata, _validate_epub_archive

    _validate_epub_archive(path)
    content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    existing = await get_library_book_by_hash(content_hash)
    if existing:
        return existing
    title, author = _read_epub_metadata(path)
    book_id = str(uuid.uuid4())
    now = _now()
    db = await _connect()
    try:
        await db.execute(
            """
            INSERT INTO library_books
                (id, content_hash, title, author, original_filename,
                 storage_filename, file_size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                book_id,
                content_hash,
                title or Path(original_filename).stem,
                author,
                Path(original_filename).name,
                path.name,
                path.stat().st_size,
                now,
                now,
            ),
        )
        await db.commit()
    finally:
        await db.close()
    await ensure_library_knowledge(book_id)
    return await get_library_book(book_id) or {}


async def upload_library_book(
    content: bytes, filename: str, title: str = "", author: str = ""
) -> tuple[dict, bool]:
    """Validate and atomically store one EPUB, deduplicated by content hash."""
    max_bytes = settings.max_epub_upload_mb * 1024 * 1024
    if not content or len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"EPUB 大小必须在 1 字节到 {settings.max_epub_upload_mb}MB 之间",
        )
    if not filename.lower().endswith(".epub"):
        raise HTTPException(status_code=415, detail="Only .epub files are supported")

    content_hash = hashlib.sha256(content).hexdigest()
    existing = await get_library_book_by_hash(content_hash)
    if existing:
        await ensure_library_knowledge(existing["id"])
        return (await get_library_book(existing["id"]) or existing), False

    from knowledge import KnowledgeError, _read_epub_metadata, _validate_epub_archive

    book_id = str(uuid.uuid4())
    storage_filename = f"{book_id}.epub"
    temp_path = BOOKS_DIR / f".{book_id}.upload.epub"
    final_path = BOOKS_DIR / storage_filename
    temp_path.write_bytes(content)
    try:
        _validate_epub_archive(temp_path)
        parsed_title, parsed_author = _read_epub_metadata(temp_path)
        os.replace(temp_path, final_path)
    except KnowledgeError as exc:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    now = _now()
    db = await _connect()
    try:
        await db.execute(
            """
            INSERT INTO library_books
                (id, content_hash, title, author, original_filename,
                 storage_filename, file_size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                book_id,
                content_hash,
                title.strip() or parsed_title or Path(filename).stem,
                author.strip() or parsed_author,
                Path(filename).name,
                storage_filename,
                len(content),
                now,
                now,
            ),
        )
        await db.commit()
    except aiosqlite.IntegrityError:
        final_path.unlink(missing_ok=True)
        existing = await get_library_book_by_hash(content_hash)
        if not existing:
            raise
        await ensure_library_knowledge(existing["id"])
        return (await get_library_book(existing["id"]) or existing), False
    finally:
        await db.close()

    await ensure_library_knowledge(book_id)
    return (await get_library_book(book_id) or {}), True


async def ensure_library_knowledge(book_id: str) -> dict | None:
    """Point the AI index at the canonical server EPUB and enqueue indexing."""
    book = await get_library_book(book_id, include_knowledge=False)
    if not book:
        return None

    from knowledge import get_book_by_hash, register_server_book, reindex_book

    existing = await get_book_by_hash(book["content_hash"])
    source_path = str((BOOKS_DIR / book["filename"]).resolve())
    if existing:
        db = await _connect()
        try:
            await db.execute(
                """
                UPDATE qa_books
                SET source_path = ?, source_kind = 'server',
                    original_filename = ?, updated_at = ?
                WHERE id = ?
                """,
                (source_path, book["original_filename"], _now(), existing["id"]),
            )
            await db.execute(
                "UPDATE library_books SET knowledge_book_id = ?, updated_at = ? WHERE id = ?",
                (existing["id"], _now(), book_id),
            )
            await db.commit()
        finally:
            await db.close()
        if existing["status"] in {"failed", "outdated"}:
            await reindex_book(existing["id"])
        return existing

    knowledge_book = await register_server_book(book["filename"])
    db = await _connect()
    try:
        await db.execute(
            "UPDATE library_books SET knowledge_book_id = ?, updated_at = ? WHERE id = ?",
            (knowledge_book["id"], _now(), book_id),
        )
        await db.commit()
    finally:
        await db.close()
    return knowledge_book


async def get_library_book(
    book_id: str, *, include_knowledge: bool = True
) -> dict | None:
    db = await _connect()
    try:
        if include_knowledge:
            cursor = await db.execute(
                """
                SELECT lb.*, qb.status AS knowledge_status,
                       qb.error_message AS knowledge_error
                FROM library_books lb
                LEFT JOIN qa_books qb ON qb.id = lb.knowledge_book_id
                WHERE lb.id = ?
                """,
                (book_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM library_books WHERE id = ?", (book_id,)
            )
        row = await cursor.fetchone()
        return _public_book(dict(row)) if row else None
    finally:
        await db.close()


async def get_library_book_by_hash(content_hash: str) -> dict | None:
    db = await _connect()
    try:
        cursor = await db.execute(
            "SELECT * FROM library_books WHERE content_hash = ?", (content_hash,)
        )
        row = await cursor.fetchone()
        return _public_book(dict(row)) if row else None
    finally:
        await db.close()


async def list_library_books() -> list[dict]:
    db = await _connect()
    try:
        rows = await db.execute_fetchall(
            """
            SELECT lb.*, qb.status AS knowledge_status,
                   qb.error_message AS knowledge_error
            FROM library_books lb
            LEFT JOIN qa_books qb ON qb.id = lb.knowledge_book_id
            ORDER BY lb.created_at DESC
            """
        )
        return [_public_book(dict(row)) for row in rows]
    finally:
        await db.close()


def _public_book(book: dict) -> dict:
    return {
        "id": book["id"],
        "title": book["title"],
        "author": book.get("author", ""),
        "filename": book["storage_filename"],
        "original_filename": book["original_filename"],
        "content_hash": book["content_hash"],
        "file_size": book.get("file_size", 0),
        "knowledge_book_id": book.get("knowledge_book_id"),
        "knowledge_status": book.get("knowledge_status") or "unregistered",
        "knowledge_error": book.get("knowledge_error") or "",
        "state_revision": book.get("state_revision", 0),
        "created_at": book.get("created_at"),
        "updated_at": book.get("updated_at"),
    }


async def serve_library_book(book_id: str) -> FileResponse:
    book = await get_library_book(book_id, include_knowledge=False)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    path = (BOOKS_DIR / book["filename"]).resolve()
    if not path.is_relative_to(BOOKS_DIR.resolve()) or not path.is_file():
        raise HTTPException(status_code=404, detail="Book not found")
    return FileResponse(
        str(path),
        media_type=EPUB_MIME,
        filename=book["original_filename"],
    )


async def get_book_state(book_id: str) -> dict:
    db = await _connect()
    try:
        book = await db.execute_fetchall(
            "SELECT state_revision FROM library_books WHERE id = ?", (book_id,)
        )
        if not book:
            raise HTTPException(status_code=404, detail="Book not found")
        progress = await db.execute_fetchall(
            "SELECT cfi, progress_percent, last_opened, updated_at "
            "FROM reading_states WHERE book_id = ?",
            (book_id,),
        )
        bookmarks = await db.execute_fetchall(
            "SELECT * FROM reader_bookmarks WHERE book_id = ? ORDER BY progress_percent",
            (book_id,),
        )
        highlights = await db.execute_fetchall(
            "SELECT * FROM highlights WHERE book_id = ? ORDER BY progress_percent",
            (book_id,),
        )
        return {
            "book_id": book_id,
            "revision": book[0]["state_revision"],
            "progress": dict(progress[0]) if progress else None,
            "bookmarks": [dict(row) for row in bookmarks],
            "highlights": [_highlight_to_dict(row) for row in highlights],
        }
    finally:
        await db.close()


async def sync_book_state(book_id: str, operations: list[dict]) -> dict:
    """Apply idempotent reader operations, then return the canonical snapshot."""
    db = await _connect()
    try:
        exists = await db.execute_fetchall(
            "SELECT id, title, author, knowledge_book_id FROM library_books WHERE id = ?",
            (book_id,),
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Book not found")
        book = dict(exists[0])
        for operation in operations:
            op_id = str(operation.get("op_id") or "")
            operation_type = str(operation.get("type") or "")
            entity_id = str(operation.get("entity_id") or "")
            payload = operation.get("payload") or {}
            if not op_id or operation_type not in {
                "progress.set",
                "bookmark.upsert",
                "bookmark.delete",
                "highlight.upsert",
                "highlight.delete",
            }:
                raise HTTPException(status_code=422, detail="Invalid sync operation")
            seen = await db.execute_fetchall(
                "SELECT 1 FROM reader_sync_operations WHERE op_id = ?", (op_id,)
            )
            if seen:
                continue
            now = _now()
            if operation_type == "progress.set":
                await db.execute(
                    """
                    INSERT INTO reading_states
                        (book_id, cfi, progress_percent, last_opened, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(book_id) DO UPDATE SET
                        cfi=excluded.cfi,
                        progress_percent=excluded.progress_percent,
                        last_opened=excluded.last_opened,
                        updated_at=excluded.updated_at
                    """,
                    (
                        book_id,
                        str(payload.get("cfi") or ""),
                        float(payload.get("progress_percent") or 0),
                        int(payload.get("last_opened") or 0),
                        now,
                    ),
                )
            elif operation_type == "bookmark.upsert":
                if not entity_id:
                    raise HTTPException(status_code=422, detail="Bookmark ID is required")
                await db.execute(
                    """
                    INSERT INTO reader_bookmarks
                        (id, book_id, chapter, cfi, progress_percent, label,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        book_id=excluded.book_id, chapter=excluded.chapter,
                        cfi=excluded.cfi,
                        progress_percent=excluded.progress_percent,
                        label=excluded.label, updated_at=excluded.updated_at
                    """,
                    (
                        entity_id,
                        book_id,
                        str(payload.get("chapter") or ""),
                        str(payload.get("cfi") or ""),
                        float(payload.get("progress_percent") or 0),
                        str(payload.get("label") or ""),
                        str(payload.get("created_at") or now),
                        now,
                    ),
                )
            elif operation_type == "bookmark.delete":
                await db.execute(
                    "DELETE FROM reader_bookmarks WHERE id = ? AND book_id = ?",
                    (entity_id, book_id),
                )
            elif operation_type == "highlight.upsert":
                await _upsert_synced_highlight(db, book, entity_id, payload, now)
            elif operation_type == "highlight.delete":
                await db.execute(
                    "DELETE FROM highlights WHERE book_id = ? "
                    "AND (id = ? OR client_id = ?)",
                    (book_id, entity_id, entity_id),
                )
            await db.execute(
                "INSERT INTO reader_sync_operations "
                "(op_id, book_id, operation_type, received_at) VALUES (?, ?, ?, ?)",
                (op_id, book_id, operation_type, now),
            )
            await db.execute(
                "UPDATE library_books SET state_revision = state_revision + 1, "
                "updated_at = ? WHERE id = ?",
                (now, book_id),
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()
    return await get_book_state(book_id)


async def _upsert_synced_highlight(
    db: aiosqlite.Connection,
    book: dict,
    entity_id: str,
    payload: dict,
    now: str,
) -> None:
    if not entity_id:
        raise HTTPException(status_code=422, detail="Highlight ID is required")
    rows = await db.execute_fetchall(
        "SELECT id FROM highlights WHERE client_id = ? OR id = ?",
        (entity_id, entity_id),
    )
    values = (
        book["id"],
        entity_id,
        str(payload.get("book_title") or book["title"]),
        str(payload.get("book_author") or book.get("author") or ""),
        str(payload.get("chapter") or ""),
        str(payload.get("cfi") or ""),
        str(payload.get("highlight_text") or ""),
        str(payload.get("note") or ""),
        json.dumps(payload.get("tags") or [], ensure_ascii=False),
        str(payload.get("color") or "yellow"),
        str(payload.get("created_at") or now),
        float(payload.get("progress_percent") or 0),
        now,
        now,
        str(payload.get("status") or ("reflected" if payload.get("note") else "raw")),
        book.get("knowledge_book_id"),
    )
    if rows:
        await db.execute(
            """
            UPDATE highlights SET
                book_id=?, client_id=?, book_title=?, book_author=?, chapter=?,
                cfi=?, highlight_text=?, note=?, tags=?, color=?, created_at=?,
                progress_percent=?, received_at=COALESCE(received_at, ?),
                updated_at=?, status=?, knowledge_book_id=?
            WHERE id=?
            """,
            (*values, rows[0]["id"]),
        )
    else:
        await db.execute(
            """
            INSERT INTO highlights
                (book_id, client_id, book_title, book_author, chapter, cfi,
                 highlight_text, note, tags, color, created_at, progress_percent,
                 received_at, updated_at, status, knowledge_book_id, id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (*values, str(uuid.uuid4())),
        )


def _highlight_to_dict(row: aiosqlite.Row) -> dict:
    item = dict(row)
    try:
        item["tags"] = json.loads(item.get("tags") or "[]")
    except (TypeError, json.JSONDecodeError):
        item["tags"] = []
    return item


async def delete_library_book(book_id: str) -> bool:
    """Delete a server book and all reader/AI data after staging its file."""
    book = await get_library_book(book_id, include_knowledge=False)
    if not book:
        return False
    source = (BOOKS_DIR / book["filename"]).resolve()
    trash_dir = BOOKS_DIR.parent / ".trash"
    trash_dir.mkdir(parents=True, exist_ok=True)
    staged = trash_dir / f"{book_id}.epub"
    if source.is_file():
        shutil.move(str(source), str(staged))

    db = await _connect()
    try:
        await db.execute("DELETE FROM highlights WHERE book_id = ?", (book_id,))
        await db.execute("DELETE FROM library_books WHERE id = ?", (book_id,))
        await db.commit()
    except Exception:
        await db.rollback()
        if staged.is_file():
            shutil.move(str(staged), str(source))
        raise
    finally:
        await db.close()

    if book.get("knowledge_book_id"):
        from knowledge import delete_knowledge_book

        await delete_knowledge_book(book["knowledge_book_id"])
    staged.unlink(missing_ok=True)
    return True
