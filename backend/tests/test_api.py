"""Tests for FastAPI endpoints (backend/main.py)."""

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
import aiosqlite
from fastapi.testclient import TestClient

# --- Setup: override DB_PATH before importing main ---
import database as db_module
import config as config_module

_test_db_dir = tempfile.mkdtemp()
_test_db_path = Path(_test_db_dir) / "test_marginalia.db"
db_module.DB_PATH = _test_db_path
db_module.NOTES_JSON_PATH = Path(_test_db_dir) / "notes.json"
config_module.settings.feishu_webhook_url = ""

# Defer main import until after DB_PATH patch
from main import app


@pytest.fixture(autouse=True)
def reset_db():
    """Reset database before each test."""
    try:
        if _test_db_path.exists():
            os.unlink(_test_db_path)
    except (PermissionError, OSError):
        pass
    async def _init():
        await db_module.init_db()
        async with aiosqlite.connect(str(_test_db_path)) as db:
            await db.execute("DELETE FROM highlights")
            await db.execute("DELETE FROM drafts")
            await db.commit()
        if db_module.NOTES_JSON_PATH.exists():
            db_module.NOTES_JSON_PATH.unlink()
    asyncio.get_event_loop().run_until_complete(_init())
    yield
    try:
        if _test_db_path.exists():
            os.unlink(_test_db_path)
        if db_module.NOTES_JSON_PATH.exists():
            db_module.NOTES_JSON_PATH.unlink()
    except (PermissionError, OSError):
        pass


@pytest.fixture
def client():
    return TestClient(app)


class TestHealth:
    def test_health_check(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["service"] == "marginalia"


class TestSyncHighlights:
    def test_sync_success(self, client):
        payload = {
            "highlights": [
                {
                    "book_title": "沉思录",
                    "book_author": "马可",
                    "highlight_text": "宇宙是变化，人生是看法。",
                    "chapter": "卷四",
                    "color": "yellow",
                    "progress_percent": 35,
                }
            ]
        }
        resp = client.post("/api/highlights", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["received"] == 1
        assert len(data["ids"]) == 1

    def test_sync_multiple_highlights(self, client):
        payload = {
            "highlights": [
                {"book_title": "A", "highlight_text": "1"},
                {"book_title": "A", "highlight_text": "2"},
                {"book_title": "A", "highlight_text": "3"},
            ]
        }
        resp = client.post("/api/highlights", json=payload)
        assert resp.status_code == 200
        assert resp.json()["received"] == 3

    def test_sync_empty_highlights_422(self, client):
        resp = client.post("/api/highlights", json={"highlights": []})
        assert resp.status_code == 422

    def test_sync_missing_field_422(self, client):
        payload = {"highlights": [{"book_title": "X"}]}  # missing highlight_text
        resp = client.post("/api/highlights", json=payload)
        assert resp.status_code == 422


class TestListHighlights:
    def test_list_empty(self, client):
        resp = client.get("/api/highlights")
        assert resp.status_code == 200
        data = resp.json()
        assert data["highlights"] == []
        assert data["count"] == 0

    def test_list_after_sync(self, client):
        # First sync some highlights
        payload = {
            "highlights": [
                {"book_title": "论语", "highlight_text": "学而时习之"},
            ]
        }
        client.post("/api/highlights", json=payload)

        resp = client.get("/api/highlights")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["highlights"][0]["book_title"] == "论语"

    def test_list_filter_book_title(self, client):
        # Sync highlights from different books
        client.post("/api/highlights", json={
            "highlights": [
                {"book_title": "论语", "highlight_text": "学而"},
                {"book_title": "孟子", "highlight_text": "仁者"},
            ]
        })
        resp = client.get("/api/highlights", params={"book_title": "论语"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["highlights"][0]["book_title"] == "论语"

    def test_list_pagination(self, client):
        # Add 3 highlights
        highlights = [
            {"book_title": "X", "highlight_text": f"text{i}"} for i in range(3)
        ]
        client.post("/api/highlights", json={"highlights": highlights})

        resp = client.get("/api/highlights", params={"limit": 2, "offset": 0})
        assert resp.json()["count"] == 2


class TestHighlightCrud:
    def test_sync_with_client_id_can_get_single_highlight(self, client):
        payload = {
            "highlights": [
                {
                    "id": "local-1",
                    "book_title": "论语",
                    "highlight_text": "学而时习之",
                    "note": "初始笔记",
                }
            ]
        }
        sync_resp = client.post("/api/highlights", json=payload)
        assert sync_resp.status_code == 200
        sync_data = sync_resp.json()
        assert sync_data["items"][0]["client_id"] == "local-1"

        resp = client.get("/api/highlights/local-1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == sync_data["ids"][0]
        assert data["client_id"] == "local-1"
        assert data["note"] == "初始笔记"

    def test_sync_same_client_id_updates_instead_of_inserting(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {
                    "id": "local-1",
                    "book_title": "论语",
                    "highlight_text": "学而时习之",
                    "note": "旧笔记",
                }
            ]
        })
        resp = client.post("/api/highlights", json={
            "highlights": [
                {
                    "id": "local-1",
                    "book_title": "论语",
                    "highlight_text": "学而时习之",
                    "note": "新笔记",
                    "tags": ["儒学"],
                }
            ]
        })
        assert resp.status_code == 200
        assert resp.json()["items"][0]["action"] == "updated"

        list_resp = client.get("/api/highlights")
        data = list_resp.json()
        assert data["count"] == 1
        assert data["highlights"][0]["note"] == "新笔记"
        assert data["highlights"][0]["tags"] == ["儒学"]

    def test_patch_highlight_updates_export(self, client):
        sync_resp = client.post("/api/highlights", json={
            "highlights": [
                {"id": "local-2", "book_title": "孟子", "highlight_text": "仁者爱人"}
            ]
        })
        server_id = sync_resp.json()["ids"][0]

        resp = client.patch(
            f"/api/highlights/{server_id}",
            json={"note": "核心观点", "tags": ["儒学"], "color": "blue"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["note"] == "核心观点"
        assert data["tags"] == ["儒学"]
        assert data["color"] == "blue"

        export_resp = client.get("/api/notes/export")
        exported = export_resp.json()
        assert exported[0]["note"] == "核心观点"
        assert exported[0]["tags"] == ["儒学"]

    def test_patch_empty_update_422(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {"id": "local-3", "book_title": "庄子", "highlight_text": "逍遥游"}
            ]
        })
        resp = client.patch("/api/highlights/local-3", json={})
        assert resp.status_code == 422

    def test_delete_highlight_removes_from_list_and_export(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {"id": "local-4", "book_title": "大学", "highlight_text": "明明德"}
            ]
        })

        resp = client.request("DELETE", "/api/highlights/local-4", json={"client_id": "local-4"})
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        assert client.get("/api/highlights/local-4").status_code == 404
        assert client.get("/api/highlights").json()["count"] == 0
        assert client.get("/api/notes/export").json() == []

    def test_delete_legacy_highlight_by_exact_match(self, client):
        created_at = "2026-07-04T12:00:00Z"
        client.post("/api/highlights", json={
            "highlights": [
                {
                    "book_title": "旧书",
                    "cfi": "epubcfi(/6/2)",
                    "highlight_text": "旧划线",
                    "created_at": created_at,
                }
            ]
        })

        resp = client.request("DELETE", "/api/highlights/local-old", json={
            "book_title": "旧书",
            "cfi": "epubcfi(/6/2)",
            "highlight_text": "旧划线",
            "created_at": created_at,
        })
        assert resp.status_code == 200
        assert client.get("/api/highlights").json()["count"] == 0

    def test_missing_highlight_crud_404(self, client):
        assert client.get("/api/highlights/missing").status_code == 404
        assert client.patch("/api/highlights/missing", json={"note": "x"}).status_code == 404
        assert client.delete("/api/highlights/missing").status_code == 404


class TestBookQA:
    def test_ask_book_success_with_mocked_llm(self, client):
        async def fake_answer(**kwargs):
            assert kwargs["question"] == "这一章在讲什么？"
            assert kwargs["book_title"] == "沉思录"
            assert kwargs["highlights"][0]["highlight_text"] == "宇宙是变化"
            return "这章在说明变化和判断的关系。"

        with patch("llm.answer_book_question_with_llm", fake_answer):
            resp = client.post("/api/books/ask", json={
                "question": "这一章在讲什么？",
                "book_title": "沉思录",
                "book_author": "马可",
                "chapter": "卷四",
                "progress_percent": 35,
                "highlights": [
                    {
                        "highlight_text": "宇宙是变化",
                        "note": "斯多葛核心",
                        "tags": ["斯多葛"],
                        "chapter": "卷四",
                        "progress_percent": 35,
                    }
                ],
            })

        assert resp.status_code == 200
        assert resp.json() == {"answer": "这章在说明变化和判断的关系。"}

    def test_ask_book_empty_question_422(self, client):
        resp = client.post("/api/books/ask", json={"question": "   "})
        assert resp.status_code == 422

    def test_ask_book_requires_llm_config(self, client):
        import config

        old_base_url = config.settings.llm_base_url
        old_api_key = config.settings.llm_api_key
        old_model = config.settings.llm_model
        config.settings.llm_base_url = ""
        config.settings.llm_api_key = ""
        config.settings.llm_model = ""
        try:
            resp = client.post("/api/books/ask", json={
                "question": "这本书在讲什么？",
                "book_title": "沉思录",
            })
        finally:
            config.settings.llm_base_url = old_base_url
            config.settings.llm_api_key = old_api_key
            config.settings.llm_model = old_model

        assert resp.status_code == 422


class TestCreationWorkspace:
    def test_materials_filter_by_book_tag_and_status(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {
                    "id": "m-1",
                    "book_title": "沉思录",
                    "highlight_text": "宇宙是变化",
                    "note": "有感悟",
                    "tags": ["哲学"],
                },
                {
                    "id": "m-2",
                    "book_title": "论语",
                    "highlight_text": "学而",
                    "tags": ["儒学"],
                },
            ]
        })

        resp = client.get("/api/materials", params={
            "book_title": "沉思录",
            "tag": "哲学",
            "status": "reflected",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["materials"][0]["client_id"] == "m-1"

    def test_generate_draft_requires_llm_config(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {"id": "g-1", "book_title": "沉思录", "highlight_text": "宇宙是变化"}
            ]
        })
        resp = client.post("/api/drafts/generate", json={
            "target": "video",
            "highlight_ids": ["g-1"],
        })
        assert resp.status_code == 422

    def test_generate_draft_success_with_mocked_llm(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {
                    "id": "g-2",
                    "book_title": "沉思录",
                    "highlight_text": "宇宙是变化",
                    "note": "人生也是解释",
                }
            ]
        })

        async def fake_generate(**kwargs):
            return {
                "title": "变化中的人生",
                "content": "这是一段视频号口播稿",
                "metadata": {"estimated_seconds": 60},
            }

        with patch("llm.generate_draft_with_llm", fake_generate):
            resp = client.post("/api/drafts/generate", json={
                "target": "video",
                "highlight_ids": ["g-2"],
                "topic": "变化",
            })

        assert resp.status_code == 200
        draft = resp.json()
        assert draft["title"] == "变化中的人生"
        assert draft["target"] == "video"
        assert draft["source_highlight_ids"] == ["g-2"]

        list_resp = client.get("/api/drafts")
        assert list_resp.json()["count"] == 1

    def test_draft_crud(self, client):
        import database

        draft = asyncio.get_event_loop().run_until_complete(database.create_draft(
            target="article",
            title="初稿",
            content="正文",
            source_highlight_ids=[],
            metadata={},
        ))

        resp = client.patch(f"/api/drafts/{draft['id']}", json={
            "title": "改后标题",
            "content": "改后正文",
        })
        assert resp.status_code == 200
        assert resp.json()["title"] == "改后标题"

        assert client.get(f"/api/drafts/{draft['id']}").status_code == 200
        assert client.delete(f"/api/drafts/{draft['id']}").status_code == 200
        assert client.get(f"/api/drafts/{draft['id']}").status_code == 404

    def test_obsidian_export_book(self, client, tmp_path):
        import config

        client.post("/api/highlights", json={
            "highlights": [
                {
                    "id": "o-1",
                    "book_title": "沉思录",
                    "book_author": "马可",
                    "highlight_text": "宇宙是变化",
                    "note": "重点",
                }
            ]
        })
        old_path = config.settings.obsidian_vault_path
        config.settings.obsidian_vault_path = str(tmp_path)
        try:
            resp = client.post("/api/obsidian/export", json={
                "kind": "book",
                "book_title": "沉思录",
            })
        finally:
            config.settings.obsidian_vault_path = old_path

        assert resp.status_code == 200
        path = Path(resp.json()["path"])
        assert path.exists()
        assert "宇宙是变化" in path.read_text(encoding="utf-8")


class TestGenerateScript:
    def _sync_and_get_ids(self, client, highlights):
        resp = client.post("/api/highlights", json={"highlights": highlights})
        return resp.json()["ids"]

    def test_generate_script_success(self, client):
        ids = self._sync_and_get_ids(client, [
            {
                "book_title": "沉思录",
                "highlight_text": "宇宙是变化，人生是看法。",
                "note": "斯多葛核心",
                "tags": ["哲学"],
                "progress_percent": 35,
            },
            {
                "book_title": "沉思录",
                "highlight_text": "一日之始就对自己说。",
                "note": "",
                "progress_percent": 15,
            },
        ])

        resp = client.post("/api/generate-script", json={"highlight_ids": ids})
        assert resp.status_code == 200
        data = resp.json()
        assert data["book_title"] == "沉思录"
        assert data["source_count"] <= len(ids)
        assert len(data["hook"]) > 0
        assert len(data["body"]) > 0
        assert len(data["cta"]) > 0
        assert isinstance(data["duration_estimate_seconds"], int)

    def test_generate_script_no_ids_422(self, client):
        resp = client.post("/api/generate-script", json={"highlight_ids": []})
        assert resp.status_code == 422

    def test_generate_script_not_found(self, client):
        resp = client.post(
            "/api/generate-script",
            json={"highlight_ids": ["nonexistent-uuid"]},
        )
        assert resp.status_code == 404


class TestNotesExport:
    def test_export_empty(self, client):
        resp = client.get("/api/notes/export")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert data == []

    def test_export_after_sync(self, client):
        client.post("/api/highlights", json={
            "highlights": [
                {
                    "book_title": "论语",
                    "highlight_text": "学而时习之",
                    "note": "学习与温习",
                    "tags": ["儒学"],
                }
            ]
        })
        # Trigger export
        resp = client.get("/api/notes/export")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 1
        entry = data[0]
        assert "book_title" in entry
        assert "highlight_text" in entry
        assert "note" in entry
        assert "tags" in entry
        assert "created_at" in entry


# --- Cleanup ---
def teardown_module():
    """Remove temp directory after all tests."""
    import shutil
    try:
        if _test_db_dir and Path(_test_db_dir).exists():
            shutil.rmtree(_test_db_dir, ignore_errors=True)
    except Exception:
        pass  # directory may already be cleaned up
