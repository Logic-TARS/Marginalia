"""
Short video script generator for Marginalia.

Takes e-book highlights and produces a video script outline using an
"editing-first, shooting-second" approach — the script determines the
pacing and structure before any footage is planned.

Output structure:
  1. HOOK (3-5s)    — most striking highlight or question
  2. BODY (40-55s)  — 3-5 highlights with brief commentary
  3. CTA  (5-10s)   — call to action / reflection
"""

import logging
import random
from datetime import datetime, timezone

logger = logging.getLogger("marginalia.agent")

# Approximate reading speed for Chinese voiceover
CHARS_PER_SECOND = 4.0  # average Chinese speech rate
SECONDS_PER_HIGHLIGHT = 12  # including pause + transition


def generate_script(highlights: list[dict]) -> dict:
    """
    Generate a short video script from a list of highlights.

    Args:
        highlights: list of highlight dicts from the database.
                   Each has: highlight_text, note, tags, book_title, chapter, etc.

    Returns:
        dict with: book_title, script (full), hook, body, cta,
                   duration_estimate_seconds, source_count
    """
    if not highlights:
        return {
            "book_title": "",
            "script": "没有足够的划线来生成脚本。",
            "hook": "",
            "body": "",
            "cta": "",
            "duration_estimate_seconds": 0,
            "source_count": 0,
        }

    book_title = highlights[0].get("book_title", "未知书籍")

    # Sort by progress (reading order) — keeps narrative flow
    sorted_highlights = sorted(
        highlights, key=lambda h: h.get("progress_percent", 0)
    )

    # Pick up to 5 highlights for the script
    selected = _select_best_highlights(sorted_highlights, max_count=5)

    # Generate each section
    hook = _generate_hook(selected, book_title)
    body = _generate_body(selected)
    cta = _generate_cta(selected, book_title)

    # Assemble full script
    script_parts = [hook, "", body]
    if cta:
        script_parts.extend(["", cta])

    full_script = "\n".join(script_parts)

    # Estimate duration
    duration = _estimate_duration(hook, body, cta, len(selected))

    return {
        "book_title": book_title,
        "script": full_script,
        "hook": hook,
        "body": body,
        "cta": cta,
        "duration_estimate_seconds": duration,
        "source_count": len(selected),
    }


def _select_best_highlights(highlights: list[dict], max_count: int = 5) -> list[dict]:
    """
    Select the best highlights for a script.
    Prioritizes: highlights with notes > highlights with tags > plain highlights.
    Then picks from across the book (spread out by progress).
    """
    # Score each highlight
    scored = []
    for h in highlights:
        score = 0
        if h.get("note"):
            score += 3  # Notes add commentary potential
        if h.get("tags"):
            score += 2  # Tags add thematic hooks
        text_len = len(h.get("highlight_text", ""))
        if 15 <= text_len <= 120:
            score += 1  # Good length for quoting
        scored.append((score, h))

    # Sort by score (desc), then pick
    scored.sort(key=lambda x: x[0], reverse=True)

    selected = []
    used_positions = set()

    for _, h in scored:
        if len(selected) >= max_count:
            break
        # Avoid clustering at the same progress point
        pos = int(h.get("progress_percent", 0) / 20)  # bucket into 5ths of the book
        if pos not in used_positions or len(selected) < 3:
            selected.append(h)
            used_positions.add(pos)

    # Re-sort by progress for narrative flow
    selected.sort(key=lambda h: h.get("progress_percent", 0))
    return selected


def _generate_hook(highlights: list[dict], book_title: str) -> str:
    """
    Generate the hook — the first 3-5 seconds.
    Goal: grab attention with a powerful quote or provocative question.
    """
    if not highlights:
        return f"# 今日推荐：《{book_title}》"

    # Find the most striking highlight (with note if possible) for the hook
    best = None
    for h in highlights:
        if h.get("note"):
            best = h
            break
    if not best:
        best = highlights[0]

    text = best.get("highlight_text", "").strip()

    # Build hook
    hook_lines = [
        f"「{text}」",
        f"—— 《{book_title}》",
    ]

    return "\n".join(hook_lines)


def _generate_body(highlights: list[dict]) -> str:
    """
    Generate the body — 3-5 highlights with brief commentary.
    Each highlight gets:
      - The quote (read aloud)
      - Optional: personal note / reflection
      - Optional: tag-based thematic connection
    """
    if not highlights:
        return ""

    body_lines = ["# 金句精选\n"]

    for i, h in enumerate(highlights, 1):
        text = h.get("highlight_text", "").strip()
        note = h.get("note", "").strip()
        tags = h.get("tags", [])
        chapter = h.get("chapter", "")

        # Quote
        body_lines.append(f"## {i}. ")
        if chapter:
            body_lines.append(f"*{chapter}*  ")
        body_lines.append(f"「{text}」")

        # Commentary
        if note:
            body_lines.append(f"")
            body_lines.append(f"💭 {note}")

        # Tags as transitions
        if tags and i < len(highlights):
            tag_str = " · ".join(tags)
            body_lines.append(f"")
            body_lines.append(f"*关键词：{tag_str}*")

        body_lines.append("")

    return "\n".join(body_lines)


def _generate_cta(highlights: list[dict], book_title: str) -> str:
    """
    Generate the call to action — final 5-10 seconds.
    Options (picked randomly for variety):
      - Reflection question
      - Recommendation
      - Next action
    """
    # Gather all tags for topic
    all_tags = []
    for h in highlights:
        all_tags.extend(h.get("tags", []))
    all_tags = list(set(all_tags))[:3]

    topic_str = " · ".join(all_tags) if all_tags else "阅读"

    ctas = [
        f"# 你的想法？\n\n这本书里还有哪些让你触动的句子？\n欢迎在评论区分享 👇",
        f"# 推荐阅读\n\n《{book_title}》—— 关于{topic_str}的一本好书\n值得你花时间去读 ✨",
        f"# 今日思考\n\n{topic_str} — 这个问题值得我们多想想\n保存这条视频，下次翻开这本书时再来看 💡",
        f"# 行动起来\n\n今天选一句去实践，而不只是划线\n共勉 🤝",
    ]

    # Pick based on whether there are notes (personal reflection → reflection CTA)
    has_notes = any(h.get("note") for h in highlights)
    if has_notes:
        return random.choice(ctas[:2])  # More personal CTAs
    return random.choice(ctas)


def _estimate_duration(hook: str, body: str, cta: str, highlight_count: int) -> int:
    """
    Estimate video duration in seconds based on Chinese speech rate.
    """
    total_chars = len(hook) + len(body) + len(cta)

    # Speech time
    speech_seconds = total_chars / CHARS_PER_SECOND

    # Add transition time between highlights
    transition_seconds = max(0, highlight_count - 1) * 2

    # Add intro/outro buffer
    buffer_seconds = 5

    total = speech_seconds + transition_seconds + buffer_seconds

    # Clamp to realistic short-video range
    return max(15, min(180, int(total)))


# ── CLI entry point ─────────────────────────────────────
if __name__ == "__main__":
    """
    Quick test: generate a script from sample highlights.
    Usage: python agent.py
    """
    sample = [
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷二",
            "highlight_text": "一日之始就对自己说：我将遇见好管闲事的人、忘恩负义的人、傲慢的人、欺诈的人、嫉妒的人和孤僻的人。",
            "note": "斯多葛派的预演法，每天提醒自己世界不完美",
            "tags": ["斯多葛", "心态"],
            "color": "yellow",
            "progress_percent": 15,
        },
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷四",
            "highlight_text": "宇宙是变化，人生是看法。",
            "note": "极其浓缩的哲理 — 我们能控制的只有自己的判断",
            "tags": ["金句", "哲学"],
            "color": "blue",
            "progress_percent": 35,
        },
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷六",
            "highlight_text": "不要像仿佛你将活一千年那样行动。死亡窥伺着你。当你活着，当它是在你的力量范围之内，行善吧。",
            "note": "",
            "tags": ["行动", "死亡"],
            "color": "green",
            "progress_percent": 55,
        },
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷七",
            "highlight_text": "适应你命中注定的环境，爱你命中注定所要遇到的人，但是要用心。",
            "note": "Amor Fati — 热爱命运",
            "tags": ["斯多葛", "接纳"],
            "color": "pink",
            "progress_percent": 72,
        },
    ]

    result = generate_script(sample)

    print("=" * 50)
    print(f"📖 {result['book_title']}")
    print(f"⏱ 预计时长: {result['duration_estimate_seconds']} 秒")
    print(f"📝 引用划线: {result['source_count']} 条")
    print("=" * 50)
    print()
    print(result["script"])
