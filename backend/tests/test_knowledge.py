"""Tests for the persistent EPUB knowledge base."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

import database
import knowledge

FIXTURE_EPUB = (
    Path(__file__).parents[2] / "frontend" / "tests" / "fixtures" / "multichapter.epub"
)


@pytest.fixture
def knowledge_db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "knowledge.db")
    monkeypatch.setattr(knowledge, "KNOWLEDGE_DIR", tmp_path / "knowledge")
    asyncio.run(database.init_db())
    asyncio.run(knowledge.init_knowledge_db())
    return tmp_path


def test_extracts_spine_order_and_overlapping_chunks():
    sections = knowledge._extract_sections(FIXTURE_EPUB)
    assert [item["chapter"] for item in sections] == [
        "Chapter 1",
        "Chapter 2",
        "Chapter 3",
    ]
    chunks = knowledge._chunk_sections(sections)
    assert len(chunks) > 3
    assert [chunk["ordinal"] for chunk in chunks] == list(range(len(chunks)))
    chapter_one = [chunk for chunk in chunks if chunk["chapter"] == "Chapter 1"]
    assert chapter_one[0]["text"][-knowledge.CHUNK_OVERLAP :] in chapter_one[1]["text"]


def test_register_index_retrieve_and_dedupe(knowledge_db, monkeypatch):
    async def no_queue(_book_id):
        return None

    async def fake_embeddings(texts):
        return [
            [0.0, 1.0] if "chapter 3" in text.lower() else [1.0, 0.0]
            for text in texts
        ]

    monkeypatch.setattr(knowledge, "enqueue_index", no_queue)
    monkeypatch.setattr(knowledge, "_embed_texts", fake_embeddings)
    monkeypatch.setattr(knowledge.settings, "embedding_model", "test-embedding")
    content = FIXTURE_EPUB.read_bytes()
    book = asyncio.run(
        knowledge.register_uploaded_book(content, "fixture.epub", "Fixture", "Tester")
    )
    asyncio.run(knowledge.index_book(book["id"]))
    ready = asyncio.run(knowledge.get_book(book["id"]))
    assert ready["status"] == "ready"
    assert ready["chunk_count"] > 3
    duplicate = asyncio.run(
        knowledge.register_uploaded_book(content, "duplicate.epub", "Other", "Other")
    )
    assert duplicate["id"] == book["id"]
    sources = asyncio.run(
        knowledge.retrieve_sources(book["id"], "Chapter 3", {"chapter": "Chapter 3"}, [])
    )
    assert sources[0]["chapter"] == "Chapter 3"


def test_conversation_messages_and_cascade_delete(knowledge_db):
    now = knowledge._now()

    async def prepare():
        db = await knowledge._connect()
        try:
            await db.execute(
                """
                INSERT INTO qa_books
                    (id, content_hash, title, original_filename, source_path,
                     source_kind, status, created_at, updated_at)
                VALUES ('book-1','hash-1','Book','book.epub','book.epub',
                        'server','ready',?,?)
                """,
                (now, now),
            )
            await db.commit()
        finally:
            await db.close()

    asyncio.run(prepare())
    conversation = asyncio.run(knowledge.create_conversation("book-1"))
    asyncio.run(knowledge._insert_message(conversation["id"], "user", "问题"))
    assert asyncio.run(knowledge.list_messages(conversation["id"]))[0]["content"] == "问题"
    assert asyncio.run(knowledge.delete_knowledge_book("book-1")) is True
    assert asyncio.run(knowledge.get_conversation(conversation["id"])) is None


def test_stream_persists_answer_and_valid_citations(knowledge_db, monkeypatch):
    now = knowledge._now()

    async def prepare():
        db = await knowledge._connect()
        try:
            await db.execute(
                """
                INSERT INTO qa_books
                    (id,content_hash,title,original_filename,source_path,
                     source_kind,status,created_at,updated_at)
                VALUES ('book-2','hash-2','Book','book.epub','book.epub',
                        'server','ready',?,?)
                """,
                (now, now),
            )
            await db.commit()
        finally:
            await db.close()

    asyncio.run(prepare())
    conversation = asyncio.run(knowledge.create_conversation("book-2"))
    citation = {
        "label": "B1",
        "source_type": "book",
        "source_id": "chunk-1",
        "chapter": "Chapter 1",
        "href": "chapter-1.xhtml",
        "cfi": "",
        "quote": "Evidence",
        "anchor_text": "Evidence",
    }

    async def fake_retrieve(*_args, **_kwargs):
        return [citation]

    async def fake_stream(_messages):
        yield "答案"
        yield " [B1]"

    monkeypatch.setattr(knowledge, "retrieve_sources", fake_retrieve)
    monkeypatch.setattr(knowledge, "_stream_chat", fake_stream)

    async def collect():
        result = []
        async for event in knowledge.stream_answer(conversation["id"], "问题", {}, []):
            result.append(event)
        return result

    events = asyncio.run(collect())
    assert any("event: delta" in event for event in events)
    assert any("event: citations" in event and '"B1"' in event for event in events)
    messages = asyncio.run(knowledge.list_messages(conversation["id"]))
    assert messages[-1]["content"] == "答案 [B1]"
    assert messages[-1]["citations"][0]["source_id"] == "chunk-1"


def test_chinese_fts_recall(knowledge_db):
    """FTS recall must work for Chinese text (trigram tokenizer)."""
    if knowledge._FTS_TOKENIZER != "trigram":
        pytest.skip("trigram tokenizer unavailable")

    text = "斯多葛派的预演法是在清晨提醒自己今天可能遇到的困难。"

    async def prepare():
        db = await knowledge._connect()
        try:
            now = knowledge._now()
            await db.execute(
                """
                INSERT INTO qa_books
                    (id, content_hash, title, original_filename, source_path,
                     source_kind, status, created_at, updated_at)
                VALUES ('book-zh','hash-zh','书','book.epub','book.epub',
                        'server','ready',?,?)
                """,
                (now, now),
            )
            await db.execute(
                """
                INSERT INTO qa_chunks
                    (id, book_id, run_id, ordinal, text, anchor_text, embedding)
                VALUES ('chunk-zh','book-zh','run-1',0,?,?,?)
                """,
                (text, text[:8], knowledge._pack_vector([1.0, 0.0])),
            )
            await db.execute(
                "INSERT INTO qa_chunks_fts(chunk_id, book_id, text) VALUES ('chunk-zh','book-zh',?)",
                (text,),
            )
            await db.commit()
        finally:
            await db.close()

    asyncio.run(prepare())

    terms = knowledge._fts_query_terms("什么是预演法？")
    assert terms, "expected trigram windows for the CJK question"

    async def query():
        db = await knowledge._connect()
        try:
            match = " OR ".join(f'"{term}"' for term in terms)
            return await db.execute_fetchall(
                "SELECT chunk_id FROM qa_chunks_fts"
                " WHERE qa_chunks_fts MATCH ? AND book_id='book-zh'",
                (match,),
            )
        finally:
            await db.close()

    rows = asyncio.run(query())
    assert [row["chunk_id"] for row in rows] == ["chunk-zh"]


def test_fts_migrates_from_unicode61(knowledge_db):
    """A legacy unicode61 FTS table is rebuilt with the probed tokenizer."""
    if knowledge._FTS_TOKENIZER != "trigram":
        pytest.skip("trigram tokenizer unavailable")

    async def legacy():
        db = await knowledge._connect()
        try:
            await db.execute("DROP TABLE qa_chunks_fts")
            await db.execute(
                "CREATE VIRTUAL TABLE qa_chunks_fts USING fts5("
                "chunk_id UNINDEXED, book_id UNINDEXED, text, tokenize='unicode61')"
            )
            await db.execute(
                """
                INSERT INTO qa_books
                    (id, content_hash, title, original_filename, source_path,
                     source_kind, status, created_at, updated_at)
                VALUES ('b1','h1','书','book.epub','book.epub','server','ready',?,?)
                """,
                (knowledge._now(), knowledge._now()),
            )
            await db.execute(
                """
                INSERT INTO qa_chunks
                    (id, book_id, run_id, ordinal, text, anchor_text, embedding)
                VALUES ('c1','b1','r1',0,'预演法的实践','预演法',?)
                """,
                (knowledge._pack_vector([1.0, 0.0]),),
            )
            await db.commit()
        finally:
            await db.close()

    asyncio.run(legacy())
    asyncio.run(knowledge.init_knowledge_db())

    async def check():
        db = await knowledge._connect()
        try:
            sql_rows = await db.execute_fetchall(
                "SELECT sql FROM sqlite_master WHERE name='qa_chunks_fts'"
            )
            count_rows = await db.execute_fetchall("SELECT COUNT(*) c FROM qa_chunks_fts")
            return sql_rows[0]["sql"], count_rows[0]["c"]
        finally:
            await db.close()

    sql, count = asyncio.run(check())
    assert "tokenize='trigram'" in sql
    assert count == 1, "existing chunks must be backfilled after migration"


def test_rejects_invalid_epub_without_deleting_parent(knowledge_db, monkeypatch):
    async def no_queue(_book_id):
        return None

    monkeypatch.setattr(knowledge, "enqueue_index", no_queue)
    with pytest.raises(knowledge.KnowledgeError) as exc:
        asyncio.run(knowledge.register_uploaded_book(b"not-an-epub", "bad.epub"))
    assert exc.value.code == "invalid_epub"
    assert knowledge_db.exists()
    assert (knowledge_db / "knowledge").exists()


def test_refuses_unsafe_upload_directory_delete(knowledge_db):
    with pytest.raises(RuntimeError, match="unsafe knowledge path"):
        knowledge._remove_upload_dir(knowledge_db)
    assert knowledge_db.exists()


def test_embedding_service_failure_has_stable_error(monkeypatch):
    class OfflineClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            raise httpx.ConnectError("offline")

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(knowledge.settings, "embedding_base_url", "http://127.0.0.1:1/v1")
    monkeypatch.setattr(knowledge.settings, "embedding_api_key", "ollama")
    monkeypatch.setattr(knowledge.settings, "embedding_model", "test-embedding")
    monkeypatch.setattr(knowledge.httpx, "AsyncClient", lambda **_kwargs: OfflineClient())
    monkeypatch.setattr(knowledge.asyncio, "sleep", no_sleep)

    with pytest.raises(knowledge.KnowledgeError) as exc:
        asyncio.run(knowledge._embed_texts(["hello"]))

    assert exc.value.code == "embedding_unavailable"
    assert exc.value.status_code == 503


def test_model_change_marks_ready_index_outdated(knowledge_db, monkeypatch):
    now = knowledge._now()

    async def prepare():
        db = await knowledge._connect()
        try:
            await db.execute(
                """
                INSERT INTO qa_books
                    (id,content_hash,title,original_filename,source_path,
                     source_kind,status,embedding_model,index_version,created_at,updated_at)
                VALUES ('book-old','hash-old','Book','book.epub','book.epub',
                        'server','ready','old-model',?,?,?)
                """,
                (knowledge.INDEX_VERSION, now, now),
            )
            await db.commit()
        finally:
            await db.close()

    asyncio.run(prepare())
    monkeypatch.setattr(knowledge.settings, "embedding_model", "new-model")
    asyncio.run(knowledge.init_knowledge_db())

    book = asyncio.run(knowledge.get_book("book-old"))
    assert book["status"] == "outdated"
