"""Shared test fixtures for Marginalia backend tests."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Ensure backend package is importable
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture
def sample_highlights():
    """Reusable sample highlight data for tests."""
    return [
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷二",
            "highlight_text": "一日之始就对自己说：我将遇见好管闲事的人。",
            "note": "斯多葛派的预演法",
            "tags": ["斯多葛", "心态"],
            "color": "yellow",
            "progress_percent": 15,
            "cfi": "epubcfi(/6/4!/4/2)",
        },
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷四",
            "highlight_text": "宇宙是变化，人生是看法。",
            "note": "",
            "tags": ["金句"],
            "color": "blue",
            "progress_percent": 35,
            "cfi": "epubcfi(/6/4!/4/4)",
        },
        {
            "book_title": "沉思录",
            "book_author": "马可·奥勒留",
            "chapter": "卷六",
            "highlight_text": "不要像仿佛你将活一千年那样行动。",
            "note": "",
            "tags": [],
            "color": "green",
            "progress_percent": 55,
            "cfi": "epubcfi(/6/4!/4/6)",
        },
        {
            "book_title": "论语",
            "book_author": "孔子",
            "chapter": "学而篇",
            "highlight_text": "学而时习之，不亦说乎。",
            "note": "学习与温习并重",
            "tags": ["儒学", "学习"],
            "color": "pink",
            "progress_percent": 10,
            "cfi": "epubcfi(/6/2!/4/2)",
        },
    ]
