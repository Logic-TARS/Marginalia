"""Markdown export helpers for Obsidian vaults."""

from __future__ import annotations

import re
from pathlib import Path

from config import settings


class ObsidianConfigError(RuntimeError):
    """Raised when the Obsidian vault path is missing or invalid."""


def export_book_materials(book_title: str, highlights: list[dict]) -> Path:
    """Write one book's highlights and reflections to Obsidian Markdown."""
    vault = _vault_path()
    target_dir = vault / "Marginalia" / "Books"
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{_safe_filename(book_title or '未命名书籍')}.md"

    first = highlights[0] if highlights else {}
    lines = [
        "---",
        "type: book-notes",
        f"book: {_yaml_scalar(book_title or '未命名书籍')}",
        f"author: {_yaml_scalar(first.get('book_author', ''))}",
        "source: marginalia",
        "tags:",
        "  - reading",
        "  - book",
        "---",
        "",
        f"# {book_title or '未命名书籍'}",
        "",
        f"作者：{first.get('book_author', '') or '未知作者'}",
        "",
    ]

    current_chapter = None
    for h in highlights:
        chapter = h.get("chapter") or "未分章"
        if chapter != current_chapter:
            lines.extend([f"## {chapter}", ""])
            current_chapter = chapter
        lines.extend([
            f"### {h.get('progress_percent', 0)}%",
            "",
            f"> {h.get('highlight_text', '')}",
            "",
        ])
        if h.get("note"):
            lines.extend([f"我的感悟：{h.get('note')}", ""])
        tags = _format_tags(h.get("tags", []))
        if tags:
            lines.extend([f"标签：{tags}", ""])
        lines.extend([f"时间：{h.get('created_at', '')}", "", "---", ""])

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def export_draft(draft: dict, highlights: list[dict]) -> Path:
    """Write one generated draft to Obsidian Markdown."""
    vault = _vault_path()
    target_dir = vault / "Marginalia" / "Drafts"
    target_dir.mkdir(parents=True, exist_ok=True)
    prefix = "视频号" if draft.get("target") == "video" else "公众号"
    path = target_dir / f"{_safe_filename(prefix + '-' + draft.get('title', '未命名稿件'))}.md"

    source_ids = draft.get("source_highlight_ids", [])
    lines = [
        "---",
        "type: content-draft",
        f"target: {draft.get('target', '')}",
        f"title: {_yaml_scalar(draft.get('title', ''))}",
        "source: marginalia",
        "source_highlight_ids:",
        *[f"  - {sid}" for sid in source_ids],
        f"created: {draft.get('created_at', '')}",
        f"updated: {draft.get('updated_at', '')}",
        "---",
        "",
        f"# {draft.get('title', '未命名稿件')}",
        "",
        draft.get("content", ""),
        "",
        "## 来源素材",
        "",
    ]
    for h in highlights:
        lines.extend([
            f"- 《{h.get('book_title', '')}》{h.get('chapter', '')}",
            f"  > {h.get('highlight_text', '')}",
        ])
        if h.get("note"):
            lines.append(f"  感悟：{h.get('note')}")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _vault_path() -> Path:
    if not settings.obsidian_vault_path:
        raise ObsidianConfigError("OBSIDIAN_VAULT_PATH is required")
    path = Path(settings.obsidian_vault_path).expanduser()
    if not path.exists() or not path.is_dir():
        raise ObsidianConfigError("OBSIDIAN_VAULT_PATH must be an existing directory")
    return path


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", value).strip().strip(".")
    return cleaned[:120] or "untitled"


def _yaml_scalar(value: str) -> str:
    return '"' + str(value).replace('"', '\\"') + '"'


def _format_tags(tags: list[str]) -> str:
    return " ".join("#" + re.sub(r"\s+", "-", str(tag).strip()) for tag in tags if str(tag).strip())
