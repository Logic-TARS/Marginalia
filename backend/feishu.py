"""Feishu (Lark) webhook integration for Marginalia.

MVP: Uses Feishu custom bot webhook — simple HTTP POST, no OAuth needed.
Future: Bitable integration via lark-cli for structured storage.
"""

import logging

import httpx

from config import settings

logger = logging.getLogger("marginalia.feishu")


async def send_to_feishu_webhook(highlights: list[dict]) -> bool:
    """
    Send highlights to a Feishu group via custom bot webhook.

    Builds an interactive card message with:
    - Header: book title + sync time
    - Body: each highlight (text, note, tags, progress)

    Falls back to plain text if card construction fails.
    """
    if not settings.feishu_webhook_url:
        logger.warning("Feishu webhook URL not configured, skipping")
        return False

    try:
        card = _build_card(highlights)
    except Exception as e:
        logger.error(f"Failed to build Feishu card: {e}")
        card = _build_text_fallback(highlights)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(settings.feishu_webhook_url, json=card)
            if resp.status_code == 200:
                body = resp.json()
                if body.get("code") == 0 or body.get("StatusCode") == 0:
                    return True
                logger.warning(f"Feishu API error: {body}")
            else:
                logger.warning(f"Feishu webhook HTTP {resp.status_code}: {resp.text}")
            return False
    except httpx.TimeoutException:
        logger.error("Feishu webhook timeout")
        return False
    except Exception as e:
        logger.error(f"Feishu webhook request failed: {e}")
        return False


def _build_card(highlights: list[dict]) -> dict:
    """
    Build a Feishu interactive card (v2).

    Card structure:
    ┌─────────────────────────────┐
    │ 📖 书名                    │
    │ 共 N 条划线               │
    ├─────────────────────────────┤
    │ 💛 "划线原文…"            │
    │    📝 笔记内容             │
    │    🏷 金句 反思            │
    │    📍 进度 45%             │
    ├─────────────────────────────┤
    │ 💚 "另一条划线…"          │
    │    ...                     │
    └─────────────────────────────┘
    """
    if not highlights:
        return {"msg_type": "text", "content": {"text": "收到空的划线数据"}}

    # Group by book
    book_title = highlights[0].get("book_title", "未知书籍")

    # Build card header
    header = {
        "title": {
            "tag": "plain_text",
            "content": f"📖 {book_title}",
        },
        "template": "blue",
    }

    # Build elements — one note block per highlight
    elements = []

    # Summary divider
    elements.append({
        "tag": "div",
        "text": {
            "tag": "lark_md",
            "content": f"**共 {len(highlights)} 条划线** · {_now_str()}",
        },
    })
    elements.append({"tag": "hr"})

    for h in highlights[:10]:  # Cap at 10 highlights per card
        text = h.get("highlight_text", "")
        note = h.get("note", "")
        tags = h.get("tags", [])
        color = h.get("color", "yellow")
        progress = h.get("progress_percent", 0)

        color_emoji = {"yellow": "💛", "green": "💚", "blue": "💙", "pink": "💗"}.get(color, "💛")

        # Highlight text
        lines = [f"{color_emoji} \"{text}\""]

        # Note if present
        if note:
            lines.append(f"📝 {note}")

        # Tags if present
        if tags:
            tag_line = " ".join(f"`{t}`" for t in tags)
            lines.append(tag_line)

        # Progress
        lines.append(f"📍 进度 {int(progress)}%")

        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": "\n".join(lines),
            },
        })
        elements.append({"tag": "hr"})

    # Remove trailing <hr> and add note if truncated
    if elements and elements[-1].get("tag") == "hr":
        elements.pop()

    if len(highlights) > 10:
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"*…还有 {len(highlights) - 10} 条划线未显示*",
            },
        })

    return {
        "msg_type": "interactive",
        "card": {
            "header": header,
            "elements": elements,
        },
    }


def _build_text_fallback(highlights: list[dict]) -> dict:
    """Plain text fallback message."""
    book_title = highlights[0].get("book_title", "未知书籍")
    lines = [f"📖 {book_title} — {len(highlights)} 条新划线\n"]
    for h in highlights[:5]:
        lines.append(f"• {h.get('highlight_text', '')[:80]}")
        if h.get("note"):
            lines.append(f"  笔记: {h['note'][:100]}")
        lines.append("")
    return {
        "msg_type": "text",
        "content": {"text": "\n".join(lines)},
    }


def _now_str() -> str:
    """Get current time as short string."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    # UTC+8 for China
    try:
        from datetime import timedelta
        now = now + timedelta(hours=8)
    except Exception:
        pass
    return now.strftime("%H:%M")
