"""Tests for SQLite database layer (backend/database.py)."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

import database


# Helper: run coroutines synchronously (no pytest-asyncio needed)
def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def mock_settings():
    """Prevent config reads during database tests."""
    with patch("database.settings") as mock:
        yield mock


@pytest.fixture
def temp_db():
    """Create a temporary SQLite database and override DB_PATH."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    db_path = tmp.name
    tmp.close()

    orig_path = database.DB_PATH
    database.DB_PATH = Path(db_path)

    run(database.init_db())

    yield db_path

    os.unlink(db_path)
    database.DB_PATH = orig_path


class TestDatabase:
    def test_init_db_creates_table(self, temp_db):
        import aiosqlite

        async def check():
            async with aiosqlite.connect(temp_db) as db:
                cursor = await db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='highlights'"
                )
                row = await cursor.fetchone()
                assert row is not None

        run(check())

    def test_save_and_get_all(self, temp_db, sample_highlights):
        ids = run(database.save_highlights(sample_highlights))
        assert len(ids) == len(sample_highlights)
        for hid in ids:
            assert isinstance(hid, str)

        all_h = run(database.get_all_highlights())
        assert len(all_h) == len(sample_highlights)

    def test_save_preserves_data(self, temp_db, sample_highlights):
        run(database.save_highlights([sample_highlights[0]]))
        all_h = run(database.get_all_highlights())
        assert all_h[0]["book_title"] == "沉思录"
        assert all_h[0]["note"] == "斯多葛派的预演法"

    def test_get_by_ids(self, temp_db, sample_highlights):
        ids = run(database.save_highlights(sample_highlights))
        result = run(database.get_highlights_by_ids(ids[:2]))
        assert len(result) == 2

    def test_get_by_ids_empty(self, temp_db):
        result = run(database.get_highlights_by_ids([]))
        assert result == []

    def test_get_by_ids_not_found(self, temp_db, sample_highlights):
        run(database.save_highlights(sample_highlights))
        result = run(database.get_highlights_by_ids(["nonexistent"]))
        assert result == []

    def test_filter_by_book_title(self, temp_db, sample_highlights):
        run(database.save_highlights(sample_highlights))
        result = run(database.get_all_highlights(book_title="论语"))
        assert len(result) == 1
        assert result[0]["book_title"] == "论语"

    def test_mark_feishu_synced(self, temp_db, sample_highlights):
        ids = run(database.save_highlights([sample_highlights[0]]))
        run(database.mark_feishu_synced(ids))
        result = run(database.get_highlights_by_ids(ids))
        assert result[0]["synced_to_feishu"] is True

    def test_tags_roundtrip(self, temp_db):
        h = [{"book_title": "X", "highlight_text": "Y", "tags": ["哲学", "斯多葛"]}]
        ids = run(database.save_highlights(h))
        result = run(database.get_highlights_by_ids(ids))
        assert result[0]["tags"] == ["哲学", "斯多葛"]

    def test_tags_empty_list(self, temp_db):
        h = [{"book_title": "X", "highlight_text": "Y", "tags": []}]
        ids = run(database.save_highlights(h))
        result = run(database.get_highlights_by_ids(ids))
        assert result[0]["tags"] == []

    def test_mark_feishu_synced_empty(self, temp_db):
        run(database.mark_feishu_synced([]))

    def test_export_all_to_json(self, temp_db, sample_highlights):
        run(database.save_highlights(sample_highlights))
        path = run(database.export_all_to_json())
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert len(data) == len(sample_highlights)
        for key in ("book_title", "highlight_text", "note", "tags"):
            assert key in data[0]
        assert isinstance(data[0]["tags"], list)
