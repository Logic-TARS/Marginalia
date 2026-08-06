"""On-demand chapter narration with edge-tts and a local file cache."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import json
import logging
import os
import posixpath
import re
import shutil
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from bs4 import BeautifulSoup
from ebooklib import ITEM_DOCUMENT, epub

from config import settings

logger = logging.getLogger("marginalia.tts")

# Confirmed against edge-tts 7.2.8 list_voices on 2026-08-06.
CHINESE_VOICES = (
    {
        "id": "zh-CN-XiaoxiaoNeural",
        "name": "晓晓（女声）",
        "gender": "Female",
        "locale": "zh-CN",
    },
    {
        "id": "zh-CN-YunxiNeural",
        "name": "云希（男声）",
        "gender": "Male",
        "locale": "zh-CN",
    },
)
ALLOWED_VOICE_IDS = {voice["id"] for voice in CHINESE_VOICES}
ALLOWED_RATES = (0.75, 1.0, 1.25, 1.5, 2.0)
TASK_STATES = {"pending", "generating", "completed", "failed"}
TTS_CACHE_SCHEMA_VERSION = 2
_RETRY_DELAYS = (1, 3, 8)
_BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption"}
_INVISIBLE_PATTERN = re.compile(
    r"(^|[-_\s])(nav|menu|toolbar|breadcrumb|pagination|controls?|buttons?)([-_\s]|$)",
    re.IGNORECASE,
)


class TTSError(RuntimeError):
    """A client-safe TTS error with an HTTP status and stable code."""

    def __init__(self, message: str, status_code: int = 422, code: str = "tts_error"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_href(value: str) -> str:
    value = unquote(str(value or "")).split("#", 1)[0].replace("\\", "/").strip()
    while value.startswith("./"):
        value = value[2:]
    normalized = posixpath.normpath(value)
    return "" if normalized == "." else normalized.lstrip("/")


def _strip_markdown(value: str) -> str:
    value = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)", "", value)
    value = re.sub(r"(`{1,3}|\*{1,3}|_{1,3}|~~)(.*?)\1", r"\2", value)
    value = re.sub(r"<https?://[^>]+>", "", value)
    return value


def _normalize_text(value: str) -> str:
    value = html.unescape(value).replace("\u00a0", " ").replace("\u3000", " ")
    value = _strip_markdown(value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    value = re.sub(r"[ \t\f\v]+", " ", value)
    value = re.sub(r"\s*\n\s*", "\n", value)
    return value.strip()


def clean_text_to_paragraphs(source: str) -> list[str]:
    """Remove unsafe/non-content HTML and Markdown while preserving punctuation."""
    if not source:
        return []
    soup = BeautifulSoup(source, "html.parser")
    for tag in soup([
        "script", "style", "noscript", "nav", "form", "button", "input", "select",
        "textarea", "svg", "canvas", "iframe", "audio", "video", "footer",
    ]):
        tag.decompose()
    for tag in list(soup.find_all(True)):
        attrs = " ".join(
            str(tag.get(attr, "")) for attr in ("id", "class", "role")
        )
        style = str(tag.get("style", ""))
        if (
            tag.has_attr("hidden")
            or str(tag.get("aria-hidden", "")).lower() == "true"
            or "display:none" in style.replace(" ", "").lower()
            or "visibility:hidden" in style.replace(" ", "").lower()
            or _INVISIBLE_PATTERN.search(attrs)
        ):
            tag.decompose()

    paragraphs: list[str] = []
    for node in soup.find_all(_BLOCK_TAGS):
        if any(parent.name in _BLOCK_TAGS for parent in node.parents):
            continue
        text = _normalize_text(node.get_text(" ", strip=True))
        if node.name == "figcaption" and re.fullmatch(r"(?:图|图片|插图|image)\s*\d*", text, re.I):
            continue
        if text:
            paragraphs.append(text)
    if not paragraphs:
        paragraphs = [
            cleaned
            for part in soup.get_text("\n", strip=True).splitlines()
            if (cleaned := _normalize_text(part))
        ]
    return paragraphs


def clean_text(source: str) -> str:
    """Return canonical cleaned text used for hashing and synthesis."""
    return "\n".join(clean_text_to_paragraphs(source))


def _sentence_units(text: str) -> list[str]:
    units = re.findall(r".*?(?:[。！？!?；;]+[”’\"』」】）)]*|$)", text, re.DOTALL)
    return [unit.strip() for unit in units if unit.strip()]


def _split_extreme_unit(text: str, max_chars: int) -> list[str]:
    result: list[str] = []
    remaining = text.strip()
    while len(remaining) > max_chars:
        lower = max(max_chars // 2, 1)
        window = remaining[lower : max_chars + 1]
        candidates = [match.end() + lower for match in re.finditer(r"[，,、：:\s]", window)]
        cut = candidates[-1] if candidates else max_chars
        result.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        result.append(remaining)
    return result


def _split_long_paragraph(paragraph: str, max_chars: int) -> list[str]:
    pieces: list[str] = []
    buffer = ""
    for unit in _sentence_units(paragraph):
        if len(unit) > max_chars:
            if buffer:
                pieces.append(buffer)
                buffer = ""
            pieces.extend(_split_extreme_unit(unit, max_chars))
        elif not buffer or len(buffer) + len(unit) <= max_chars:
            buffer += unit
        else:
            pieces.append(buffer)
            buffer = unit
    if buffer:
        pieces.append(buffer)
    return pieces


def split_text(paragraphs: list[str] | str, max_chars: int = 1000) -> list[str]:
    """Split cleaned text by paragraphs, sentences, then commas as a last resort."""
    if max_chars < 100:
        raise ValueError("max_chars must be at least 100")
    source_paragraphs = paragraphs.splitlines() if isinstance(paragraphs, str) else paragraphs
    normalized = [_normalize_text(item) for item in source_paragraphs]
    normalized = [item for item in normalized if item]
    segments: list[str] = []
    buffer = ""
    for paragraph in normalized:
        pieces = [paragraph] if len(paragraph) <= max_chars else _split_long_paragraph(paragraph, max_chars)
        for piece in pieces:
            candidate = f"{buffer}\n{piece}" if buffer else piece
            if len(candidate) <= max_chars:
                buffer = candidate
            else:
                if buffer:
                    segments.append(buffer)
                buffer = piece
    if buffer:
        segments.append(buffer)
    return [segment for segment in segments if segment.strip()]


def split_text_with_offsets(
    paragraphs: list[str] | str, max_chars: int = 1000
) -> list[dict[str, Any]]:
    """Return synthesis segments with stable offsets in the cleaned chapter text."""
    source_paragraphs = paragraphs.splitlines() if isinstance(paragraphs, str) else paragraphs
    normalized = [_normalize_text(item) for item in source_paragraphs]
    normalized = [item for item in normalized if item]
    chapter_text = "\n".join(normalized)
    segment_texts = split_text(normalized, max_chars)
    descriptors: list[dict[str, Any]] = []
    cursor = 0
    for index, text in enumerate(segment_texts):
        start = chapter_text.find(text, cursor)
        if start < 0:
            # Long paragraphs may be trimmed around a split point. A forward-only
            # search still keeps duplicate passages mapped in reading order.
            start = chapter_text.find(text)
        if start < 0:
            raise RuntimeError(f"无法定位第 {index + 1} 个朗读分段")
        end = start + len(text)
        descriptors.append(
            {
                "index": index,
                "text": text,
                "chapterStart": start,
                "chapterEnd": end,
            }
        )
        cursor = end
    return descriptors


def content_hash(cleaned: str) -> str:
    return hashlib.sha256(cleaned.encode("utf-8")).hexdigest()


def make_cache_key(
    book_id: str,
    chapter_id: str,
    text_hash: str,
    voice: str,
    rate: float,
    provider: str = "edge-tts",
) -> str:
    canonical = json.dumps(
        [
            book_id,
            chapter_id,
            text_hash,
            voice,
            f"{rate:.2f}",
            provider,
            TTS_CACHE_SCHEMA_VERSION,
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _chapter_storage_id(chapter_id: str) -> str:
    return hashlib.sha256(chapter_id.encode("utf-8")).hexdigest()[:24]


def _rate_storage_id(rate: float) -> str:
    return f"{rate:.2f}".replace(".", "_")


def edge_rate(rate: float) -> str:
    percent = round((rate - 1.0) * 100)
    return f"{percent:+d}%"


def extract_chapter(path: Path, chapter_id: str) -> tuple[str, list[str]]:
    """Read one spine document by href. No filesystem path comes from the client."""
    requested = _normalize_href(chapter_id)
    if not requested or requested.startswith("../") or "\x00" in requested:
        raise TTSError("章节标识无效", 422, "invalid_chapter_id")
    try:
        book = epub.read_epub(str(path), options={"ignore_ncx": True})
    except Exception as exc:
        raise TTSError("EPUB 无法读取", 422, "invalid_epub") from exc
    for idref, _linear in book.spine:
        item = book.get_item_with_id(idref)
        if not item or item.get_type() != ITEM_DOCUMENT:
            continue
        href = _normalize_href(str(item.get_name()))
        if href != requested and not href.endswith("/" + requested):
            continue
        paragraphs = clean_text_to_paragraphs(
            item.get_content().decode("utf-8", errors="replace")
        )
        return href, paragraphs
    raise TTSError("章节不存在", 404, "chapter_not_found")


class TTSManager:
    """Deduplicated in-process task manager backed by atomic metadata files."""

    def __init__(self) -> None:
        self.storage_path = Path(settings.tts_storage_path)
        self.tasks: dict[str, tuple[dict[str, Any], Path]] = {}
        self._task_texts: dict[str, list[str]] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()
        self._semaphore: asyncio.Semaphore | None = None
        self._started = False
        self._client_active: defaultdict[str, set[str]] = defaultdict(set)
        self._client_requests: defaultdict[str, deque[float]] = defaultdict(deque)

    async def start(self) -> None:
        if self._started:
            return
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._semaphore = asyncio.Semaphore(max(1, settings.tts_max_concurrency))
        self.tasks.clear()
        for metadata_path in self.storage_path.rglob("metadata.json"):
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                task_id = str(metadata["taskId"])
                if metadata.get("status") not in TASK_STATES:
                    raise ValueError("invalid status")
                if metadata["status"] in {"pending", "generating"}:
                    metadata["status"] = "failed"
                    metadata["error"] = "服务已重启，请重新发起朗读"
                    metadata["updatedAt"] = _now()
                    self._write_metadata(metadata_path.parent, metadata)
                self.tasks[task_id] = (metadata, metadata_path.parent)
            except Exception as exc:
                logger.warning("Ignoring damaged TTS metadata %s: %s", metadata_path, exc)
        self._started = True

    async def stop(self) -> None:
        workers = list(self._workers.values())
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        self._workers.clear()
        self._started = False

    def _cache_dir(
        self, book_id: str, chapter_id: str, text_hash: str, voice: str, rate: float
    ) -> Path:
        return (
            self.storage_path
            / book_id
            / _chapter_storage_id(chapter_id)
            / text_hash
            / voice
            / _rate_storage_id(rate)
            / f"v{TTS_CACHE_SCHEMA_VERSION}"
        )

    @staticmethod
    def _write_metadata(cache_dir: Path, metadata: dict[str, Any]) -> None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        temp = cache_dir / ".metadata.tmp"
        temp.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, cache_dir / "metadata.json")

    @staticmethod
    def _validate_parameters(voice: str, rate: float) -> None:
        if voice not in ALLOWED_VOICE_IDS:
            raise TTSError("不支持该声音", 422, "invalid_voice")
        if not any(abs(rate - allowed) < 0.001 for allowed in ALLOWED_RATES):
            raise TTSError("语速必须是 0.75、1.0、1.25、1.5 或 2.0", 422, "invalid_rate")

    def _check_rate_limit(self, client_id: str) -> None:
        now = time.monotonic()
        requests = self._client_requests[client_id]
        while requests and requests[0] < now - 60:
            requests.popleft()
        if len(requests) >= settings.tts_create_rate_limit_per_minute:
            raise TTSError("朗读请求过于频繁，请稍后重试", 429, "rate_limited")
        requests.append(now)

    async def create_or_get(
        self,
        *,
        book: dict[str, Any],
        chapter_id: str,
        voice: str,
        rate: float,
        client_id: str,
    ) -> dict[str, Any]:
        if not settings.tts_enabled:
            raise TTSError("自动朗读功能已关闭", 503, "tts_disabled")
        if settings.tts_provider != "edge-tts":
            raise TTSError("TTS 服务配置不可用", 503, "tts_provider_unavailable")
        self._validate_parameters(voice, rate)
        await self.start()

        from books_api import BOOKS_DIR

        source_path = (BOOKS_DIR / str(book["filename"])).resolve()
        if not source_path.is_relative_to(BOOKS_DIR.resolve()) or not source_path.is_file():
            raise TTSError("书籍文件不存在", 404, "book_file_missing")
        canonical_chapter, paragraphs = await asyncio.to_thread(
            extract_chapter, source_path, chapter_id
        )
        cleaned = "\n".join(paragraphs)
        if not cleaned.strip():
            raise TTSError("该章节没有可朗读的正文", 422, "empty_chapter")
        segment_descriptors = split_text_with_offsets(
            paragraphs, settings.tts_segment_max_chars
        )
        if not segment_descriptors:
            raise TTSError("该章节没有可朗读的正文", 422, "empty_chapter")
        digest = content_hash(cleaned)
        task_id = make_cache_key(
            str(book["id"]), canonical_chapter, digest, voice, rate, settings.tts_provider
        )
        cache_dir = self._cache_dir(
            str(book["id"]), canonical_chapter, digest, voice, rate
        )

        async with self._lock:
            existing = self._load_task(task_id, cache_dir)
            if existing:
                metadata, _path = existing
                self._repair_missing_files(metadata, cache_dir)
                if metadata["status"] == "completed":
                    metadata["lastAccessedAt"] = _now()
                    self._write_metadata(cache_dir, metadata)
                    logger.info("TTS cache hit task=%s book=%s chapter=%s", task_id, book["id"], canonical_chapter)
                    return self.public_task(metadata, cache_dir)
                if metadata["status"] in {"pending", "generating"} and task_id in self._workers:
                    logger.info("TTS task merged task=%s", task_id)
                    return self.public_task(metadata, cache_dir)

            self._check_rate_limit(client_id)
            active = self._client_active[client_id]
            active.intersection_update({key for key, worker in self._workers.items() if not worker.done()})
            if len(active) >= settings.tts_max_tasks_per_client:
                raise TTSError("同时生成的章节过多，请等待当前任务完成", 429, "too_many_tasks")

            now = _now()
            if existing:
                metadata = existing[0]
                metadata.update({"status": "pending", "error": None, "updatedAt": now})
                for segment in metadata.get("segments", []):
                    filename = str(segment.get("filename") or "")
                    if not filename or not (cache_dir / filename).is_file():
                        segment["status"] = "pending"
                        segment.pop("size", None)
                metadata["completedSegments"] = sum(
                    1 for item in metadata["segments"] if item.get("status") == "ready"
                )
            else:
                metadata = {
                    "taskId": task_id,
                    "bookId": str(book["id"]),
                    "chapterId": canonical_chapter,
                    "contentHash": digest,
                    "voice": voice,
                    "rate": rate,
                    "ttsProvider": settings.tts_provider,
                    "status": "pending",
                    "cacheSchemaVersion": TTS_CACHE_SCHEMA_VERSION,
                    "segmentCount": len(segment_descriptors),
                    "completedSegments": 0,
                    "segments": [
                        {
                            **descriptor,
                            "filename": f"segment-{int(descriptor['index']) + 1:03d}.mp3",
                            "timingFilename": f"segment-{int(descriptor['index']) + 1:03d}.timing.json",
                            "status": "pending",
                        }
                        for descriptor in segment_descriptors
                    ],
                    "createdAt": now,
                    "updatedAt": now,
                    "lastAccessedAt": now,
                    "error": None,
                }
            self._write_metadata(cache_dir, metadata)
            self.tasks[task_id] = (metadata, cache_dir)
            self._task_texts[task_id] = [
                str(descriptor["text"]) for descriptor in segment_descriptors
            ]
            active.add(task_id)
            source_stat = source_path.stat()
            source_signature = (source_stat.st_size, source_stat.st_mtime_ns)
            worker = asyncio.create_task(
                self._generate_task(task_id, source_path, source_signature, client_id),
                name=f"tts-{task_id[:12]}",
            )
            self._workers[task_id] = worker
            logger.info("TTS task created task=%s book=%s chapter=%s segments=%d", task_id, book["id"], canonical_chapter, len(segment_descriptors))
            return self.public_task(metadata, cache_dir)

    def _load_task(self, task_id: str, cache_dir: Path | None = None) -> tuple[dict, Path] | None:
        existing = self.tasks.get(task_id)
        if existing:
            return existing
        if cache_dir:
            path = cache_dir / "metadata.json"
            try:
                metadata = json.loads(path.read_text(encoding="utf-8"))
                if metadata.get("taskId") != task_id:
                    return None
                self.tasks[task_id] = (metadata, cache_dir)
                return metadata, cache_dir
            except (OSError, json.JSONDecodeError, TypeError):
                return None
        return None

    @staticmethod
    def _read_timing_file(path: Path) -> list[dict[str, Any]] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            cues = payload.get("cues") if isinstance(payload, dict) else None
            if not isinstance(cues, list):
                return None
            return [cue for cue in cues if isinstance(cue, dict)]
        except (OSError, json.JSONDecodeError, TypeError):
            return None

    def _repair_missing_files(self, metadata: dict, cache_dir: Path) -> None:
        changed = False
        completed = 0
        schema_valid = metadata.get("cacheSchemaVersion") == TTS_CACHE_SCHEMA_VERSION
        for segment in metadata.get("segments", []):
            index = int(segment.get("index", -1))
            filename = str(segment.get("filename") or "")
            timing_filename = str(segment.get("timingFilename") or "")
            path = cache_dir / filename
            timing_path = cache_dir / timing_filename
            valid = (
                schema_valid
                and filename == f"segment-{index + 1:03d}.mp3"
                and timing_filename == f"segment-{index + 1:03d}.timing.json"
                and isinstance(segment.get("text"), str)
                and isinstance(segment.get("chapterStart"), int)
                and isinstance(segment.get("chapterEnd"), int)
                and path.is_file()
                and path.stat().st_size > 0
                and self._read_timing_file(timing_path) is not None
            )
            if segment.get("status") == "ready" and not valid:
                segment["status"] = "pending"
                segment.pop("size", None)
                changed = True
            if segment.get("status") == "ready" and valid:
                completed += 1
        if metadata.get("completedSegments") != completed:
            metadata["completedSegments"] = completed
            changed = True
        if metadata.get("status") == "completed" and completed != metadata.get("segmentCount"):
            metadata["status"] = "failed"
            metadata["error"] = "朗读缓存文件缺失，请重新生成"
            changed = True
        if changed:
            metadata["updatedAt"] = _now()
            self._write_metadata(cache_dir, metadata)

    async def _generate_task(
        self,
        task_id: str,
        source_path: Path,
        source_signature: tuple[int, int],
        client_id: str,
    ) -> None:
        metadata, cache_dir = self.tasks[task_id]
        try:
            metadata["status"] = "generating"
            metadata["updatedAt"] = _now()
            self._write_metadata(cache_dir, metadata)
            texts = self._task_texts[task_id]
            for index, text in enumerate(texts):
                segment = metadata["segments"][index]
                target = cache_dir / segment["filename"]
                if segment.get("status") == "ready" and target.is_file() and target.stat().st_size > 0:
                    continue
                current_stat = source_path.stat()
                current_signature = (current_stat.st_size, current_stat.st_mtime_ns)
                if current_signature != source_signature:
                    _chapter, current_paragraphs = await asyncio.to_thread(
                        extract_chapter, source_path, metadata["chapterId"]
                    )
                    if content_hash("\n".join(current_paragraphs)) != metadata["contentHash"]:
                        raise TTSError("章节内容已变化，请重新发起朗读", 409, "chapter_changed")
                    source_signature = current_signature
                timing_target = cache_dir / str(segment["timingFilename"])
                await self._generate_with_retry(
                    text, target, timing_target, metadata, index
                )
                segment["status"] = "ready"
                segment["size"] = target.stat().st_size
                metadata["completedSegments"] = sum(
                    1 for item in metadata["segments"] if item.get("status") == "ready"
                )
                metadata["updatedAt"] = _now()
                self._write_metadata(cache_dir, metadata)
                logger.info("TTS segment completed task=%s segment=%d", task_id, index)
            metadata["status"] = "completed"
            metadata["error"] = None
            metadata["updatedAt"] = _now()
            self._write_metadata(cache_dir, metadata)
            logger.info("TTS task completed task=%s", task_id)
        except asyncio.CancelledError:
            metadata["status"] = "failed"
            metadata["error"] = "服务已停止，请重新发起朗读"
            metadata["updatedAt"] = _now()
            self._write_metadata(cache_dir, metadata)
            raise
        except Exception as exc:
            metadata["status"] = "failed"
            metadata["error"] = str(exc)[:500] or "语音生成失败"
            metadata["updatedAt"] = _now()
            self._write_metadata(cache_dir, metadata)
            logger.exception("TTS task failed task=%s", task_id)
        finally:
            self._client_active[client_id].discard(task_id)
            self._task_texts.pop(task_id, None)
            self._workers.pop(task_id, None)

    async def _generate_with_retry(
        self,
        text: str,
        target: Path,
        timing_target: Path,
        metadata: dict,
        index: int,
    ) -> None:
        last_error: Exception | None = None
        attempts = max(0, settings.tts_max_retries) + 1
        for attempt in range(attempts):
            temp = target.with_suffix(".mp3.tmp")
            timing_temp = timing_target.with_suffix(".json.tmp")
            temp.unlink(missing_ok=True)
            timing_temp.unlink(missing_ok=True)
            try:
                logger.info("TTS segment start task=%s segment=%d attempt=%d", metadata["taskId"], index, attempt + 1)
                assert self._semaphore is not None
                async with self._semaphore:
                    cues = await asyncio.wait_for(
                        self._synthesize_segment(
                            text, temp, metadata["voice"], float(metadata["rate"])
                        ),
                        timeout=settings.tts_request_timeout,
                    )
                if not temp.is_file() or temp.stat().st_size < settings.tts_min_audio_bytes:
                    raise RuntimeError("生成的音频文件为空或损坏")
                timing_temp.write_text(
                    json.dumps({"cues": cues or []}, ensure_ascii=False),
                    encoding="utf-8",
                )
                os.replace(temp, target)
                os.replace(timing_temp, timing_target)
                return
            except asyncio.CancelledError:
                temp.unlink(missing_ok=True)
                timing_temp.unlink(missing_ok=True)
                raise
            except Exception as exc:
                temp.unlink(missing_ok=True)
                timing_temp.unlink(missing_ok=True)
                last_error = exc
                if attempt >= attempts - 1:
                    break
                delay = _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]
                logger.warning("TTS segment retry task=%s segment=%d delay=%ss error=%s", metadata["taskId"], index, delay, exc)
                await asyncio.sleep(delay)
        logger.error("TTS segment failed task=%s segment=%d error=%s", metadata["taskId"], index, last_error)
        raise RuntimeError(f"第 {index + 1} 段生成失败：{last_error}") from last_error

    @staticmethod
    def _word_cues(text: str, boundaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        cues: list[dict[str, Any]] = []
        cursor = 0
        for boundary in boundaries:
            spoken = str(boundary.get("text") or "")
            if not spoken:
                continue
            start = text.find(spoken, cursor)
            if start < 0:
                start = text.find(spoken)
            if start < 0:
                logger.warning("Could not map TTS boundary text=%r", spoken)
                continue
            end = start + len(spoken)
            cues.append(
                {
                    "text": spoken,
                    "start": start,
                    "end": end,
                    "startMs": max(0, round(float(boundary.get("offset") or 0) / 10_000)),
                    "durationMs": max(0, round(float(boundary.get("duration") or 0) / 10_000)),
                }
            )
            cursor = end
        return cues

    async def _synthesize_segment(
        self, text: str, target: Path, voice: str, rate: float
    ) -> list[dict[str, Any]]:
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("edge-tts 未安装") from exc
        communicator = edge_tts.Communicate(
            text, voice, rate=edge_rate(rate), boundary="WordBoundary"
        )
        boundaries: list[dict[str, Any]] = []
        with target.open("wb") as audio:
            async for message in communicator.stream():
                if message["type"] == "audio":
                    audio.write(message["data"])
                elif message["type"] == "WordBoundary":
                    boundaries.append(dict(message))
        return self._word_cues(text, boundaries)

    async def get_task(self, task_id: str) -> dict[str, Any]:
        await self.start()
        task = self._load_task(task_id)
        if not task:
            raise TTSError("朗读任务不存在", 404, "task_not_found")
        metadata, cache_dir = task
        self._repair_missing_files(metadata, cache_dir)
        return self.public_task(metadata, cache_dir)

    async def get_audio(self, task_id: str, segment_index: int) -> tuple[Path, dict]:
        await self.start()
        task = self._load_task(task_id)
        if not task:
            raise TTSError("朗读任务不存在", 404, "task_not_found")
        metadata, cache_dir = task
        if segment_index < 0 or segment_index >= int(metadata.get("segmentCount", 0)):
            raise TTSError("音频段不存在", 404, "segment_not_found")
        segment = metadata["segments"][segment_index]
        expected = f"segment-{segment_index + 1:03d}.mp3"
        if segment.get("filename") != expected or segment.get("status") != "ready":
            raise TTSError("音频段尚未生成", 409, "segment_not_ready")
        path = (cache_dir / expected).resolve()
        if not path.is_relative_to(cache_dir.resolve()) or not path.is_file() or path.stat().st_size <= 0:
            self._repair_missing_files(metadata, cache_dir)
            raise TTSError("音频缓存缺失，请重新生成", 410, "audio_missing")
        metadata["lastAccessedAt"] = _now()
        self._write_metadata(cache_dir, metadata)
        return path, metadata

    @staticmethod
    def public_task(metadata: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
        ready_segments = []
        for segment in metadata.get("segments", []):
            index = int(segment.get("index", -1))
            filename = str(segment.get("filename") or "")
            path = cache_dir / filename
            timing_filename = str(segment.get("timingFilename") or "")
            timing_path = cache_dir / timing_filename
            cues = TTSManager._read_timing_file(timing_path)
            if (
                segment.get("status") == "ready"
                and index >= 0
                and path.is_file()
                and path.stat().st_size > 0
                and cues is not None
            ):
                ready_segments.append(
                    {
                        "index": index,
                        "status": "ready",
                        "size": path.stat().st_size,
                        "audioUrl": f"/api/tts/tasks/{metadata['taskId']}/segments/{index}",
                        "text": str(segment.get("text") or ""),
                        "chapterStart": int(segment.get("chapterStart") or 0),
                        "chapterEnd": int(segment.get("chapterEnd") or 0),
                        "cues": cues,
                    }
                )
        return {
            "taskId": metadata["taskId"],
            "cacheSchemaVersion": metadata.get("cacheSchemaVersion", 1),
            "bookId": metadata["bookId"],
            "chapterId": metadata["chapterId"],
            "status": metadata["status"],
            "segmentCount": metadata["segmentCount"],
            "completedSegments": len(ready_segments),
            "segments": ready_segments,
            "voice": metadata["voice"],
            "rate": metadata["rate"],
            "error": metadata.get("error"),
            "createdAt": metadata.get("createdAt"),
            "updatedAt": metadata.get("updatedAt"),
        }

    async def cleanup(self, retention_days: int | None = None) -> dict[str, int]:
        await self.start()
        days = settings.tts_cache_retention_days if retention_days is None else max(0, retention_days)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        removed = 0
        reclaimed = 0
        for task_id, (metadata, cache_dir) in list(self.tasks.items()):
            if metadata.get("status") in {"pending", "generating"} or task_id in self._workers:
                continue
            timestamp = metadata.get("lastAccessedAt") or metadata.get("updatedAt") or metadata.get("createdAt")
            try:
                accessed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
            except (TypeError, ValueError):
                accessed = datetime.fromtimestamp(0, timezone.utc)
            if accessed >= cutoff:
                continue
            try:
                size = sum(path.stat().st_size for path in cache_dir.rglob("*") if path.is_file())
                root = self.storage_path.resolve()
                target = cache_dir.resolve()
                if not target.is_relative_to(root) or target == root:
                    continue
                shutil.rmtree(target)
                self.tasks.pop(task_id, None)
                removed += 1
                reclaimed += size
            except OSError as exc:
                logger.warning("TTS cache cleanup failed path=%s error=%s", cache_dir, exc)
        logger.info("TTS cache cleanup removed=%d reclaimed_bytes=%d", removed, reclaimed)
        return {"removed": removed, "reclaimedBytes": reclaimed}


tts_manager = TTSManager()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean expired Marginalia TTS cache")
    parser.add_argument("--cleanup", action="store_true", help="remove expired cache entries")
    parser.add_argument("--days", type=int, default=None, help="override retention days")
    args = parser.parse_args()
    if not args.cleanup:
        parser.error("use --cleanup")
    print(json.dumps(asyncio.run(tts_manager.cleanup(args.days)), ensure_ascii=False))
