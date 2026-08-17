"""Tests for full-text search (database.search_highlights, /api/search)
and the get_materials tag pagination fix."""

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

import database


# Helper: run coroutines synchronously (no pytest-asyncio needed).
# Use a fresh loop each time: other test modules may close the default loop.
def run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


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


@pytest.fixture
def seeded_db(temp_db, sample_highlights):
    run(database.save_highlights(sample_highlights))
    return temp_db


class TestSearchHighlights:
    def test_chinese_note_hit(self, seeded_db):
        results = run(database.search_highlights("预演法"))
        assert len(results) == 1
        assert results[0]["book_title"] == "沉思录"

    def test_chinese_highlight_text_hit(self, seeded_db):
        results = run(database.search_highlights("不亦说乎"))
        assert len(results) == 1
        assert results[0]["book_title"] == "论语"

    def test_tag_hit(self, seeded_db):
        results = run(database.search_highlights("斯多葛"))
        assert len(results) == 1
        assert results[0]["chapter"] == "卷二"

    def test_book_title_hit(self, seeded_db):
        results = run(database.search_highlights("沉思录"))
        assert len(results) == 3

    def test_two_char_query_works(self, seeded_db):
        # trigram cannot index 2-char tokens; LIKE fallback must still match
        results = run(database.search_highlights("论语"))
        assert len(results) == 1

    def test_single_char_query_returns_empty(self, seeded_db):
        assert run(database.search_highlights("学")) == []

    def test_empty_query_returns_empty(self, seeded_db):
        assert run(database.search_highlights("")) == []
        assert run(database.search_highlights("   ")) == []

    def test_no_match_returns_empty(self, seeded_db):
        assert run(database.search_highlights("量子引力波")) == []

    def test_book_title_filter(self, seeded_db):
        results = run(database.search_highlights("沉思录", book_title="论语"))
        assert results == []
        results = run(database.search_highlights("学", book_title=""))
        assert results == []

    def test_update_syncs_fts(self, seeded_db):
        hit = run(database.search_highlights("预演法"))[0]
        run(database.update_highlight(hit["id"], {"note": "每日清晨的心理演习"}))
        assert run(database.search_highlights("预演法")) == []
        assert len(run(database.search_highlights("心理演习"))) == 1

    def test_delete_syncs_fts(self, seeded_db):
        hit = run(database.search_highlights("预演法"))[0]
        assert run(database.delete_highlight(hit["id"])) is True
        assert run(database.search_highlights("预演法")) == []

    def test_snippet_contains_mark(self, seeded_db):
        if database._FTS_TOKENIZER != "trigram":
            pytest.skip("trigram tokenizer unavailable")
        results = run(database.search_highlights("不亦说乎"))
        assert "<mark>" in (results[0].get("highlight_snippet") or "")

    def test_fts_backfill_on_existing_data(self, temp_db, sample_highlights):
        # Insert data, drop the FTS table, then re-init: rebuild must backfill.
        run(database.save_highlights(sample_highlights))

        import aiosqlite

        async def rebuild():
            async with aiosqlite.connect(temp_db) as db:
                await db.execute("DROP TABLE highlights_fts")
                await db.commit()
            await database.init_db()

        run(rebuild())
        assert len(run(database.search_highlights("预演法"))) == 1


class TestMaterialsTagPagination:
    def test_tag_filter_applies_before_pagination(self, temp_db):
        items = [
            {
                "book_title": f"书{i}",
                "highlight_text": f"内容{i}",
                "note": "",
                "tags": ["目标"] if i % 2 == 0 else ["其他"],
                "cfi": f"c{i}",
            }
            for i in range(10)
        ]
        run(database.save_highlights(items))

        page1 = run(database.get_materials(tag="目标", limit=3, offset=0))
        page2 = run(database.get_materials(tag="目标", limit=3, offset=3))
        assert len(page1) == 3
        assert len(page2) == 2  # 5 tagged items total, not lost to post-filtering
        for row in page1 + page2:
            assert "目标" in row["tags"]

    def test_tag_substring_match(self, temp_db):
        run(database.save_highlights([
            {"book_title": "书", "highlight_text": "内容", "tags": ["深度学习"], "cfi": "c1"},
        ]))
        assert len(run(database.get_materials(tag="学习"))) == 1


class TestSearchEndpoint:
    @pytest.fixture
    def client(self, seeded_db):
        from fastapi.testclient import TestClient
        from main import app

        return TestClient(app)

    def test_search_endpoint(self, client):
        resp = client.get("/api/search", params={"q": "预演法"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["results"][0]["book_title"] == "沉思录"

    def test_search_endpoint_no_match(self, client):
        resp = client.get("/api/search", params={"q": "量子引力波"})
        assert resp.status_code == 200
        assert resp.json()["count"] == 0
