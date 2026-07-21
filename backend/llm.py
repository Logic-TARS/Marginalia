"""OpenAI-compatible draft generation client."""

from __future__ import annotations

import json
from typing import Any

import httpx

from config import settings


class LLMConfigError(RuntimeError):
    """Raised when LLM settings are missing."""


_MAX_INPUT_LEN = 500


def _sanitize_input(value: str) -> str:
    """Strip control characters and enforce length limit."""
    cleaned = "".join(ch for ch in value if ch.isprintable() or ch in "\n\r\t")
    return cleaned[:_MAX_INPUT_LEN].strip()


async def generate_draft_with_llm(
    target: str,
    highlights: list[dict],
    topic: str = "",
    tone: str = "",
    extra_instruction: str = "",
) -> dict:
    """Generate a video/article draft through an OpenAI-compatible endpoint."""
    if not settings.llm_base_url or not settings.llm_api_key or not settings.llm_model:
        raise LLMConfigError("LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are required")

    messages = [
        {"role": "system", "content": _system_prompt(target)},
        {"role": "user", "content": _user_prompt(target, highlights, topic, tone, extra_instruction)},
    ]
    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
    }

    url = f"{settings.llm_base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()

    content = data["choices"][0]["message"]["content"]
    return _parse_llm_json(content, target)


async def answer_book_question_with_llm(
    question: str,
    book_title: str = "",
    book_author: str = "",
    chapter: str = "",
    progress_percent: float = 0.0,
    highlights: list[dict] | None = None,
) -> str:
    """Answer a question about the current book from reader context."""
    if not settings.llm_base_url or not settings.llm_api_key or not settings.llm_model:
        raise LLMConfigError("LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are required")

    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": _book_qa_system_prompt()},
            {
                "role": "user",
                "content": _book_qa_user_prompt(
                    question=question,
                    book_title=book_title,
                    book_author=book_author,
                    chapter=chapter,
                    progress_percent=progress_percent,
                    highlights=highlights or [],
                ),
            },
        ],
        "temperature": 0.4,
    }

    url = f"{settings.llm_base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()

    return str(data["choices"][0]["message"]["content"]).strip()


def _system_prompt(target: str) -> str:
    if target == "article":
        return (
            "你是一个中文公众号写作编辑。基于用户的读书划线和个人感悟，"
            "生成结构清晰、适合公众号发布的 Markdown 稿件。必须返回 JSON。"
        )
    return (
        "你是一个中文短视频脚本编辑。基于用户的读书划线和个人感悟，"
        "生成适合视频号口播的稿件。必须返回 JSON。"
    )


def _book_qa_system_prompt() -> str:
    return (
        "你是一个中文读书导师，帮助用户理解正在读的书。"
        "只基于用户提供的书籍信息、当前阅读位置、划线和感悟回答；"
        "如果上下文不足，要明确说明哪些信息不足，再给出谨慎的解释。"
        "回答要清晰、具体，优先使用要点和简短例子。"
    )


def _book_qa_user_prompt(
    question: str,
    book_title: str,
    book_author: str,
    chapter: str,
    progress_percent: float,
    highlights: list[dict],
) -> str:
    material_lines = []
    for i, h in enumerate(highlights[:80], 1):
        material_lines.append(
            "\n".join([
                f"划线 {i}",
                f"章节：{h.get('chapter', '')}",
                f"进度：{h.get('progress_percent', 0)}%",
                f"原文：{h.get('highlight_text', '')}",
                f"我的感悟：{h.get('note', '')}",
                f"标签：{'、'.join(h.get('tags', []))}",
            ])
        )

    return "\n\n".join([
        f"问题：{_sanitize_input(question)}",
        f"书名：{_sanitize_input(book_title)}",
        f"作者：{_sanitize_input(book_author)}",
        f"当前章节：{_sanitize_input(chapter)}",
        f"当前进度：{progress_percent}%",
        "划线和感悟：",
        "\n\n".join(material_lines) or "暂无划线和感悟。",
    ])


def _user_prompt(
    target: str,
    highlights: list[dict],
    topic: str,
    tone: str,
    extra_instruction: str,
) -> str:
    material_lines = []
    for i, h in enumerate(highlights, 1):
        material_lines.append(
            "\n".join([
                f"素材 {i}",
                f"书名：{h.get('book_title', '')}",
                f"作者：{h.get('book_author', '')}",
                f"章节：{h.get('chapter', '')}",
                f"原文：{h.get('highlight_text', '')}",
                f"我的感悟：{h.get('note', '')}",
                f"标签：{'、'.join(h.get('tags', []))}",
            ])
        )

    if target == "article":
        output_shape = (
            "返回 JSON：title, summary, content, metadata。"
            "content 必须是 Markdown 正文，包含小标题、引用块和结尾引导。"
        )
    else:
        output_shape = (
            "返回 JSON：title, hook, content, storyboard, cta, metadata。"
            "content 是口播稿，storyboard 是画面建议数组，metadata 包含 estimated_seconds。"
        )

    return "\n\n".join([
        f"目标：{target}",
        f"主题：{_sanitize_input(topic) or '请从素材中提炼'}",
        f"语气：{_sanitize_input(tone) or '真诚、清晰、有个人思考'}",
        f"额外要求：{_sanitize_input(extra_instruction) or '无'}",
        output_shape,
        "素材：",
        "\n\n".join(material_lines),
    ])


def _parse_llm_json(content: str, target: str) -> dict[str, Any]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = {"title": "未命名稿件", "content": content, "metadata": {}}

    title = str(parsed.get("title") or ("公众号稿件" if target == "article" else "视频号稿件"))
    if target == "video":
        body = parsed.get("content") or "\n\n".join(
            part for part in [
                parsed.get("hook", ""),
                parsed.get("body", ""),
                parsed.get("cta", ""),
            ] if part
        )
    else:
        body = parsed.get("content") or parsed.get("body") or ""

    metadata = parsed.get("metadata") if isinstance(parsed.get("metadata"), dict) else {}
    for key in ("summary", "hook", "storyboard", "cta"):
        if key in parsed:
            metadata[key] = parsed[key]

    return {"title": title, "content": str(body), "metadata": metadata}
