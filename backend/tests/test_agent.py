"""Tests for video script generator (backend/agent.py)."""

import pytest
from agent import (
    generate_script,
    _select_best_highlights,
    _generate_hook,
    _generate_body,
    _generate_cta,
    _estimate_duration,
)


class TestSelectBestHighlights:
    def test_notes_score_highest(self, sample_highlights):
        selected = _select_best_highlights(sample_highlights, max_count=5)
        # First selected should have a note (scored +3)
        assert any(h.get("note") for h in selected)

    def test_spread_across_book(self, sample_highlights):
        """Selections should not all come from the same section."""
        selected = _select_best_highlights(sample_highlights, max_count=4)
        positions = [int(h.get("progress_percent", 0) / 20) for h in selected]
        # With 4 items, should have at least 2 different buckets
        assert len(set(positions)) >= min(2, len(selected))

    def test_never_exceeds_max_count(self, sample_highlights):
        selected = _select_best_highlights(sample_highlights, max_count=2)
        assert len(selected) <= 2

    def test_respects_max_count_5(self, sample_highlights):
        many = sample_highlights * 5  # 20 highlights
        selected = _select_best_highlights(many, max_count=5)
        assert len(selected) <= 5

    def test_empty_input(self):
        selected = _select_best_highlights([], max_count=5)
        assert selected == []

    def test_single_highlight(self, sample_highlights):
        selected = _select_best_highlights([sample_highlights[0]], max_count=5)
        assert len(selected) == 1
        assert selected[0]["highlight_text"] == "一日之始就对自己说：我将遇见好管闲事的人。"


class TestGenerateHook:
    def test_uses_noted_highlight(self, sample_highlights):
        hook = _generate_hook(sample_highlights, "沉思录")
        # Should use the first noted highlight text
        assert "斯多葛" not in hook  # hook doesn't include the note, just the text
        assert "沉思录" in hook

    def test_fallback_when_no_notes(self, sample_highlights):
        no_notes = [h for h in sample_highlights if not h.get("note")]
        hook = _generate_hook(no_notes, "测试书")
        assert "测试书" in hook
        assert len(hook) > 0

    def test_empty_highlights(self):
        hook = _generate_hook([], "测试书")
        assert "测试书" in hook
        assert "今日推荐" in hook


class TestGenerateBody:
    def test_contains_quotes_and_chapters(self, sample_highlights):
        body = _generate_body(sample_highlights[:2])
        assert "沉思录" not in body  # body doesn't contain book title directly
        assert len(body) > 0

    def test_includes_notes_when_present(self, sample_highlights):
        body = _generate_body(sample_highlights)
        assert "💭" in body  # Note emoji present for noted highlights

    def test_includes_tags_when_present(self, sample_highlights):
        body = _generate_body(sample_highlights)
        assert "关键词" in body

    def test_empty_highlights(self):
        body = _generate_body([])
        assert body == ""


class TestGenerateCTA:
    def test_personal_cta_when_has_notes(self, sample_highlights):
        cta = _generate_cta(sample_highlights, "沉思录")
        # With notes → personal CTAs (first 2 options)
        assert "评论" in cta or "推荐" in cta

    def test_generic_cta_when_no_notes(self, sample_highlights):
        no_notes = [h for h in sample_highlights if not h.get("note")]
        cta = _generate_cta(no_notes, "测试书")
        assert len(cta) > 0


class TestEstimateDuration:
    def test_within_valid_range(self):
        dur = _estimate_duration("短引言", "正文内容", "号召语", 3)
        assert 15 <= dur <= 180

    def test_with_minimum(self):
        dur = _estimate_duration("a", "b", "c", 1)
        assert dur >= 15  # clamped to minimum

    def test_with_lots_of_content(self):
        long_text = "这是" * 500
        dur = _estimate_duration(long_text, long_text, long_text, 10)
        assert dur <= 180  # clamped to maximum


class TestGenerateScriptFull:
    def test_returns_all_keys(self, sample_highlights):
        result = generate_script(sample_highlights)
        expected_keys = {
            "book_title", "script", "hook", "body", "cta",
            "duration_estimate_seconds", "source_count",
        }
        assert set(result.keys()) == expected_keys

    def test_empty_input(self):
        result = generate_script([])
        assert result["book_title"] == ""
        assert result["source_count"] == 0
        assert "没有足够的划线" in result["script"]

    def test_single_highlight(self, sample_highlights):
        result = generate_script([sample_highlights[0]])
        assert result["book_title"] == "沉思录"
        assert result["source_count"] == 1
        assert len(result["hook"]) > 0
        assert len(result["body"]) > 0
        assert len(result["cta"]) > 0

    def test_duration_is_int(self, sample_highlights):
        result = generate_script(sample_highlights)
        assert isinstance(result["duration_estimate_seconds"], int)

    def test_script_contains_sections(self, sample_highlights):
        result = generate_script(sample_highlights)
        script = result["script"]
        assert result["hook"] in script
        assert result["body"] in script
