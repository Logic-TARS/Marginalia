"""Pydantic models for the Marginalia API."""

from datetime import datetime
from typing import Optional
import uuid

from pydantic import BaseModel, Field


class HighlightCreate(BaseModel):
    """Incoming highlight from the frontend reader."""
    id: Optional[str] = None
    client_id: Optional[str] = None
    book_title: str
    book_author: str = ""
    chapter: str = ""
    cfi: str = ""
    highlight_text: str
    note: str = ""
    tags: list[str] = Field(default_factory=list)
    color: str = "yellow"
    created_at: Optional[datetime] = None
    progress_percent: float = 0.0
    status: str = "raw"


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
    items: list[dict] = Field(default_factory=list)


class HighlightUpdate(BaseModel):
    """Editable highlight fields."""
    book_title: Optional[str] = None
    book_author: Optional[str] = None
    chapter: Optional[str] = None
    cfi: Optional[str] = None
    highlight_text: Optional[str] = None
    note: Optional[str] = None
    tags: Optional[list[str]] = None
    color: Optional[str] = None
    progress_percent: Optional[float] = None
    status: Optional[str] = None


class HighlightDelete(BaseModel):
    """Optional legacy-match fields for deleting old synced rows."""
    client_id: Optional[str] = None
    server_id: Optional[str] = None
    book_title: Optional[str] = None
    cfi: Optional[str] = None
    highlight_text: Optional[str] = None
    created_at: Optional[datetime] = None


class DraftGenerateRequest(BaseModel):
    """Request for generating a content draft from selected highlights."""
    target: str
    highlight_ids: list[str]
    topic: str = ""
    tone: str = ""
    extra_instruction: str = ""


class DraftUpdate(BaseModel):
    """Editable draft fields."""
    title: Optional[str] = None
    content: Optional[str] = None
    metadata: Optional[dict] = None


class BookQAHighlight(BaseModel):
    """Reader context item for book Q&A."""
    highlight_text: str = ""
    note: str = ""
    tags: list[str] = Field(default_factory=list)
    chapter: str = ""
    progress_percent: float = 0.0


class BookQARequest(BaseModel):
    """Question about the current book and local reading notes."""
    question: str
    book_title: str = ""
    book_author: str = ""
    chapter: str = ""
    progress_percent: float = 0.0
    highlights: list[BookQAHighlight] = Field(default_factory=list)


class BookQAResponse(BaseModel):
    """Answer returned by the book understanding assistant."""
    answer: str


class ObsidianExportRequest(BaseModel):
    """Export a book's materials or one draft into an Obsidian vault."""
    kind: str
    book_title: Optional[str] = None
    draft_id: Optional[str] = None


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
