"""Pydantic models for the Marginalia API."""

from datetime import datetime
from typing import Optional
import uuid

from pydantic import BaseModel, Field


class HighlightCreate(BaseModel):
    """Incoming highlight from the frontend reader."""
    book_title: str
    book_author: str = ""
    chapter: str = ""
    cfi: str = ""
    highlight_text: str
    note: str = ""
    tags: list[str] = []
    color: str = "yellow"
    created_at: Optional[datetime] = None
    progress_percent: float = 0.0


class Highlight(HighlightCreate):
    """Full highlight record with server-generated fields."""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    received_at: datetime = Field(default_factory=datetime.utcnow)
    synced_to_feishu: bool = False


class SyncRequest(BaseModel):
    """Batch sync request from the client."""
    highlights: list[HighlightCreate]


class SyncResponse(BaseModel):
    """Response returned after a successful sync."""
    received: int
    ids: list[str]


class ScriptRequest(BaseModel):
    """Request to generate a video script from highlights."""
    book_title: str = ""
    highlight_ids: list[str] = []


class ScriptResponse(BaseModel):
    """Generated video script output."""
    book_title: str
    script: str
    hook: str
    body: str
    cta: str
    duration_estimate_seconds: int
    source_count: int
