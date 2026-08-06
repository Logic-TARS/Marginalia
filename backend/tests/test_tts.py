"""Unit tests for text cleanup, segmentation, cache identity, and TTS tasks."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

import books_api
import tts
from config import settings


FIXTURE = Path(__file__).parents[2] / "frontend" / "tests" / "fixtures" / "multichapter.epub"


def test_html_and_markdown_cleanup_removes_non_content():
    source = """
    <style>.hidden { display: none }</style><script>steal()</script>
    <nav>上一页 下一页</nav><p># **第一段**  保留，标点！</p>
    <button>购买</button><p aria-hidden="true">不可见</p>
    <p>[链接文字](https://example.com) ![封面](cover.jpg)</p>
    """
    cleaned = tts.clean_text(source)
    assert "steal" not in cleaned
    assert "上一页" not in cleaned
    assert "购买" not in cleaned
    assert "不可见" not in cleaned
    assert "第一段" in cleaned
    assert "保留，标点！" in cleaned
    assert "链接文字" in cleaned
    assert "cover.jpg" not in cleaned


def test_chinese_segmentation_prefers_sentences_and_skips_empty_text():
    paragraphs = ["", "第一句。" * 30, "第二个自然段！", "   "]
    segments = tts.split_text(paragraphs, max_chars=100)
    assert segments
    assert all(segment.strip() for segment in segments)
    assert all(len(segment) <= 100 for segment in segments)
    assert "".join(segment.replace("\n", "") for segment in segments) == "第一句。" * 30 + "第二个自然段！"
    assert tts.split_text("\n \n", max_chars=100) == []

    descriptors = tts.split_text_with_offsets(paragraphs, max_chars=100)
    cleaned = tts.clean_text("<p>" + ("第一句。" * 30) + "</p><p>第二个自然段！</p>")
    assert [item["index"] for item in descriptors] == list(range(len(descriptors)))
    assert all(cleaned[item["chapterStart"]:item["chapterEnd"]] == item["text"] for item in descriptors)


def test_word_boundaries_map_to_segment_character_and_time_offsets():
    cues = tts.TTSManager._word_cues(
        "重复词，重复词结束。",
        [
            {"text": "重复词", "offset": 1_000_000, "duration": 500_000},
            {"text": "重复词", "offset": 2_000_000, "duration": 600_000},
            {"text": "结束", "offset": 3_000_000, "duration": 700_000},
        ],
    )
    assert [cue["start"] for cue in cues] == [0, 4, 7]
    assert cues[0]["startMs"] == 100
    assert cues[0]["durationMs"] == 50
    assert cues[-1]["end"] == 9


def test_extreme_sentence_splits_near_commas_before_hard_cut():
    text = ("很长的分句，" * 30) + "结束"
    segments = tts.split_text([text], max_chars=100)
    assert len(segments) > 1
    assert all(len(segment) <= 100 for segment in segments)
    assert segments[0].endswith("，")


def test_cache_key_and_content_hash_change_with_inputs():
    first_hash = tts.content_hash("同一章节")
    second_hash = tts.content_hash("同一章节已修改")
    assert first_hash != second_hash
    base = tts.make_cache_key("book", "chapter", first_hash, "voice", 1.0, "edge-tts")
    assert base == tts.make_cache_key("book", "chapter", first_hash, "voice", 1.0, "edge-tts")
    assert base != tts.make_cache_key("book", "chapter", second_hash, "voice", 1.0, "edge-tts")
    assert base != tts.make_cache_key("book", "chapter", first_hash, "other", 1.0, "edge-tts")
    assert base != tts.make_cache_key("book", "chapter", first_hash, "voice", 1.25, "edge-tts")


def test_parameter_validation():
    tts.TTSManager._validate_parameters("zh-CN-XiaoxiaoNeural", 1.25)
    with pytest.raises(tts.TTSError) as voice_error:
        tts.TTSManager._validate_parameters("arbitrary-voice", 1.0)
    assert voice_error.value.code == "invalid_voice"
    with pytest.raises(tts.TTSError) as rate_error:
        tts.TTSManager._validate_parameters("zh-CN-XiaoxiaoNeural", 1.1)
    assert rate_error.value.code == "invalid_rate"


def test_extract_chapter_rejects_missing_chapter():
    with pytest.raises(tts.TTSError) as error:
        tts.extract_chapter(FIXTURE, "missing.xhtml")
    assert error.value.code == "chapter_not_found"


def test_duplicate_tasks_cache_hit_and_retry_only_failed_segment(tmp_path, monkeypatch):
    books_dir = tmp_path / "books"
    books_dir.mkdir()
    (books_dir / "book.epub").write_bytes(FIXTURE.read_bytes())
    monkeypatch.setattr(books_api, "BOOKS_DIR", books_dir)
    monkeypatch.setattr(settings, "tts_enabled", True)
    monkeypatch.setattr(settings, "tts_provider", "edge-tts")
    monkeypatch.setattr(settings, "tts_segment_max_chars", 100)
    monkeypatch.setattr(settings, "tts_min_audio_bytes", 8)
    monkeypatch.setattr(settings, "tts_max_retries", 2)
    monkeypatch.setattr(settings, "tts_max_concurrency", 2)
    monkeypatch.setattr(tts, "_RETRY_DELAYS", (0, 0, 0))

    manager = tts.TTSManager()
    manager.storage_path = tmp_path / "tts"
    book = {"id": "book-id", "filename": "book.epub"}
    calls = 0

    async def flaky_synthesize(_text, target, _voice, _rate):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionError("temporary edge failure")
        target.write_bytes(b"ID3" + b"audio-data")

    manager._synthesize_segment = flaky_synthesize

    async def scenario():
        first = await manager.create_or_get(
            book=book,
            chapter_id="chapter-1.xhtml",
            voice="zh-CN-XiaoxiaoNeural",
            rate=1.0,
            client_id="client-a",
        )
        duplicate = await manager.create_or_get(
            book=book,
            chapter_id="chapter-1.xhtml",
            voice="zh-CN-XiaoxiaoNeural",
            rate=1.0,
            client_id="client-a",
        )
        assert duplicate["taskId"] == first["taskId"]
        assert len(manager._workers) == 1
        worker = manager._workers[first["taskId"]]
        await worker
        completed = await manager.get_task(first["taskId"])
        assert completed["status"] == "completed"
        assert completed["completedSegments"] == completed["segmentCount"]
        assert calls == completed["segmentCount"] + 2

        # A new manager simulates a service restart and must reuse the files.
        restarted = tts.TTSManager()
        restarted.storage_path = manager.storage_path

        async def must_not_run(*_args):
            raise AssertionError("completed cache should not synthesize again")

        restarted._synthesize_segment = must_not_run
        cache_hit = await restarted.create_or_get(
            book=book,
            chapter_id="chapter-1.xhtml",
            voice="zh-CN-XiaoxiaoNeural",
            rate=1.0,
            client_id="client-b",
        )
        assert cache_hit["taskId"] == first["taskId"]
        assert cache_hit["status"] == "completed"
        await restarted.stop()
        await manager.stop()

    asyncio.run(scenario())


def test_missing_timing_cache_is_regenerated_and_public_task_has_cues(tmp_path, monkeypatch):
    books_dir = tmp_path / "books"
    books_dir.mkdir()
    (books_dir / "book.epub").write_bytes(FIXTURE.read_bytes())
    monkeypatch.setattr(books_api, "BOOKS_DIR", books_dir)
    monkeypatch.setattr(settings, "tts_enabled", True)
    monkeypatch.setattr(settings, "tts_provider", "edge-tts")
    monkeypatch.setattr(settings, "tts_segment_max_chars", 100)
    monkeypatch.setattr(settings, "tts_min_audio_bytes", 4)
    monkeypatch.setattr(settings, "tts_max_retries", 0)

    manager = tts.TTSManager()
    manager.storage_path = tmp_path / "tts"
    calls = 0

    async def synthesize(text, target, _voice, _rate):
        nonlocal calls
        calls += 1
        target.write_bytes(b"ID3audio")
        return [{
            "text": text[:1], "start": 0, "end": 1,
            "startMs": 0, "durationMs": 120,
        }]

    manager._synthesize_segment = synthesize
    book = {"id": "timed-book", "filename": "book.epub"}

    async def scenario():
        created = await manager.create_or_get(
            book=book,
            chapter_id="chapter-1.xhtml",
            voice="zh-CN-XiaoxiaoNeural",
            rate=1.0,
            client_id="timed-client",
        )
        await manager._workers[created["taskId"]]
        completed = await manager.get_task(created["taskId"])
        assert completed["cacheSchemaVersion"] == tts.TTS_CACHE_SCHEMA_VERSION
        assert completed["segments"][0]["text"]
        assert completed["segments"][0]["chapterEnd"] > completed["segments"][0]["chapterStart"]
        assert completed["segments"][0]["cues"][0]["durationMs"] == 120

        metadata, cache_dir = manager.tasks[created["taskId"]]
        timing_path = cache_dir / metadata["segments"][0]["timingFilename"]
        timing_path.unlink()
        before_retry = calls
        retried = await manager.create_or_get(
            book=book,
            chapter_id="chapter-1.xhtml",
            voice="zh-CN-XiaoxiaoNeural",
            rate=1.0,
            client_id="timed-client",
        )
        await manager._workers[retried["taskId"]]
        repaired = await manager.get_task(retried["taskId"])
        assert repaired["status"] == "completed"
        assert calls == before_retry + 1
        assert repaired["segments"][0]["cues"]
        await manager.stop()

    asyncio.run(scenario())


def test_failed_task_can_be_retried(tmp_path, monkeypatch):
    books_dir = tmp_path / "books"
    books_dir.mkdir()
    (books_dir / "book.epub").write_bytes(FIXTURE.read_bytes())
    monkeypatch.setattr(books_api, "BOOKS_DIR", books_dir)
    monkeypatch.setattr(settings, "tts_enabled", True)
    monkeypatch.setattr(settings, "tts_provider", "edge-tts")
    monkeypatch.setattr(settings, "tts_min_audio_bytes", 4)
    monkeypatch.setattr(settings, "tts_max_retries", 0)

    manager = tts.TTSManager()
    manager.storage_path = tmp_path / "tts"
    book = {"id": "retry-book", "filename": "book.epub"}

    async def always_fail(*_args):
        raise TimeoutError("generation timeout")

    async def succeed(_text, target, _voice, _rate):
        target.write_bytes(b"ID3audio")

    async def scenario():
        manager._synthesize_segment = always_fail
        failed = await manager.create_or_get(
            book=book,
            chapter_id="chapter-2.xhtml",
            voice="zh-CN-YunxiNeural",
            rate=1.5,
            client_id="retry-client",
        )
        await manager._workers[failed["taskId"]]
        assert (await manager.get_task(failed["taskId"]))["status"] == "failed"

        manager._synthesize_segment = succeed
        retried = await manager.create_or_get(
            book=book,
            chapter_id="chapter-2.xhtml",
            voice="zh-CN-YunxiNeural",
            rate=1.5,
            client_id="retry-client",
        )
        await manager._workers[retried["taskId"]]
        assert (await manager.get_task(retried["taskId"]))["status"] == "completed"
        await manager.stop()

    asyncio.run(scenario())
