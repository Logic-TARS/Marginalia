"""Marginalia API — FastAPI application."""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from typing import Optional

from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from config import settings
from database import (
    init_db,
    upsert_highlights,
    get_all_highlights,
    get_materials,
    get_highlights_by_ids,
    get_highlight,
    update_highlight,
    delete_highlight,
    create_draft,
    list_drafts,
    get_draft,
    update_draft,
    delete_draft,
)
from models import (
    BookSyncRequest,
    BookQARequest,
    BookQAResponse,
    ConversationCreate,
    DraftGenerateRequest,
    DraftUpdate,
    HighlightDelete,
    HighlightUpdate,
    ObsidianExportRequest,
    QAStreamRequest,
    SyncRequest,
    SyncResponse,
    ScriptRequest,
    ScriptResponse,
)
from books_api import serve_book
from database import export_all_to_json

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("marginalia")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    await init_db()
    from knowledge import init_knowledge_db, start_index_worker, stop_index_worker

    await init_knowledge_db()
    from library import init_library_db, reconcile_legacy_books

    await init_library_db()
    await reconcile_legacy_books()
    await start_index_worker()
    logger.info("Database initialized; Python executable: %s", sys.executable)
    try:
        yield
    finally:
        await stop_index_worker()


app = FastAPI(
    title="Marginalia API",
    description="E-book highlights → Notes Library → Creation Agent",
    version="0.1.0",
    lifespan=lifespan,
)

# Browser access is restricted to configured origins in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.allowed_host_list,
)


@app.middleware("http")
async def add_private_api_cache_headers(request: Request, call_next):
    """Prevent API responses from being stored by browsers or edge caches."""
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["CDN-Cache-Control"] = "no-store"
        response.headers["Cloudflare-CDN-Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


# ── Health ──────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "marginalia"}


# ── Sync highlights ─────────────────────────────────────
@app.post("/api/highlights", response_model=SyncResponse)
async def sync_highlights(request: SyncRequest):
    """
    Receive highlights from the frontend reader.
    1. Validate and save to SQLite
    2. Refresh the standard JSON notes export
    3. Return assigned IDs
    """
    if not request.highlights:
        raise HTTPException(status_code=422, detail="No highlights provided")

    try:
        highlights_dicts = [h.model_dump() for h in request.highlights]
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid highlight data: {e}")

    items = await upsert_highlights(highlights_dicts)
    ids = [item["id"] for item in items]
    logger.info(f"Saved {len(ids)} highlights")

    # Keep the standard JSON export in sync with SQLite.
    asyncio.create_task(_export_notes())

    return SyncResponse(received=len(ids), ids=ids, items=items)


# ── List highlights ─────────────────────────────────────
@app.get("/api/highlights")
async def list_highlights(
    book_title: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """
    List stored highlights.
    Optional: filter by book_title (partial match).
    """
    highlights = await get_all_highlights(
        book_title=book_title, limit=limit, offset=offset
    )
    return {"highlights": highlights, "count": len(highlights)}


@app.get("/api/materials")
async def list_materials(
    book_title: Optional[str] = None,
    tag: Optional[str] = None,
    status: Optional[str] = None,
    has_note: Optional[bool] = None,
    limit: int = 200,
    offset: int = 0,
):
    """List highlight materials for the creation workspace."""
    materials = await get_materials(
        book_title=book_title,
        tag=tag,
        status=status,
        has_note=has_note,
        limit=limit,
        offset=offset,
    )
    return {"materials": materials, "count": len(materials)}


# ── Single highlight CRUD ───────────────────────────────
@app.get("/api/highlights/{highlight_id}")
async def get_highlight_endpoint(highlight_id: str):
    highlight = await get_highlight(highlight_id)
    if not highlight:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return highlight


@app.patch("/api/highlights/{highlight_id}")
async def update_highlight_endpoint(highlight_id: str, request: HighlightUpdate):
    data = request.model_dump(exclude_unset=True)
    data = {k: v for k, v in data.items() if v is not None}
    if not data:
        raise HTTPException(status_code=422, detail="No update fields provided")

    highlight = await update_highlight(highlight_id, data)
    if not highlight:
        raise HTTPException(status_code=404, detail="Highlight not found")

    asyncio.create_task(_export_notes())
    return highlight


@app.delete("/api/highlights/{highlight_id}")
async def delete_highlight_endpoint(
    highlight_id: str,
    request: Optional[HighlightDelete] = Body(default=None),
):
    legacy_match = request.model_dump(exclude_none=True) if request else None
    deleted = await delete_highlight(highlight_id, legacy_match)
    if not deleted:
        raise HTTPException(status_code=404, detail="Highlight not found")

    asyncio.create_task(_export_notes())
    return {"deleted": True, "id": highlight_id}


# ── Book Q&A ────────────────────────────────────────────
@app.post("/api/books/ask", response_model=BookQAResponse)
async def ask_book_question(request: BookQARequest):
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Question is required")

    try:
        from knowledge import KnowledgeError, answer_once, find_ready_book

        book_id = request.knowledge_book_id
        if not book_id:
            book = await find_ready_book(request.book_title, request.book_author)
            if not book:
                raise KnowledgeError("请先为这本书建立 AI 索引", 409, "index_not_ready")
            book_id = book["id"]
        result = await answer_once(
            book_id=book_id,
            question=question,
            conversation_id=request.conversation_id,
            location={
                "chapter": request.chapter,
                "progress_percent": request.progress_percent,
            },
            local_highlights=[h.model_dump() for h in request.highlights],
        )
    except KnowledgeError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": str(e)})
    except Exception as e:
        logger.exception("Book Q&A failed")
        raise HTTPException(status_code=502, detail=f"Book Q&A failed: {e}")

    return BookQAResponse(**result)


# ── Persistent knowledge base ────────────────────────────
@app.post("/api/knowledge/books/upload", status_code=202)
async def upload_knowledge_book(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    author: str = Form(default=""),
):
    from knowledge import KnowledgeError, public_book, register_uploaded_book

    if not file.filename or not file.filename.lower().endswith(".epub"):
        raise HTTPException(status_code=415, detail="Only .epub files are supported")
    content = await file.read(settings.max_epub_upload_mb * 1024 * 1024 + 1)
    try:
        return public_book(await register_uploaded_book(content, file.filename, title, author))
    except KnowledgeError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": str(e)})


@app.post("/api/knowledge/books/from-server", status_code=202)
async def index_server_book(filename: str = Body(embed=True)):
    from knowledge import KnowledgeError, public_book, register_server_book

    try:
        return public_book(await register_server_book(filename))
    except KnowledgeError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": str(e)})


@app.get("/api/knowledge/books/{book_id}")
async def get_knowledge_book_endpoint(book_id: str):
    from knowledge import get_book, public_book

    book = await get_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    return public_book(book)


@app.post("/api/knowledge/books/{book_id}/reindex", status_code=202)
async def reindex_knowledge_book_endpoint(book_id: str):
    from knowledge import KnowledgeError, public_book, reindex_book

    try:
        return public_book(await reindex_book(book_id))
    except KnowledgeError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": str(e)})


@app.delete("/api/knowledge/books/{book_id}")
async def delete_knowledge_book_endpoint(book_id: str):
    from knowledge import delete_knowledge_book

    if not await delete_knowledge_book(book_id):
        raise HTTPException(status_code=404, detail="Book not found")
    return {"deleted": True, "id": book_id}


@app.get("/api/knowledge/books/{book_id}/conversations")
async def list_book_conversations(book_id: str):
    from knowledge import list_conversations

    conversations = await list_conversations(book_id)
    return {"conversations": conversations, "count": len(conversations)}


@app.post("/api/knowledge/books/{book_id}/conversations", status_code=201)
async def create_book_conversation(book_id: str, request: ConversationCreate):
    from knowledge import KnowledgeError, create_conversation

    try:
        return await create_conversation(book_id, request.title)
    except KnowledgeError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": str(e)})


@app.delete("/api/knowledge/conversations/{conversation_id}")
async def delete_book_conversation(conversation_id: str):
    from knowledge import delete_conversation

    if not await delete_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"deleted": True, "id": conversation_id}


@app.get("/api/knowledge/conversations/{conversation_id}/messages")
async def get_conversation_messages(
    conversation_id: str, limit: int = 100, before: Optional[str] = None
):
    from knowledge import get_conversation, list_messages

    if not await get_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = await list_messages(conversation_id, limit=limit, before=before)
    return {"messages": messages, "count": len(messages)}


@app.post("/api/knowledge/conversations/{conversation_id}/messages/stream")
async def stream_conversation_message(conversation_id: str, request: QAStreamRequest):
    from knowledge import get_conversation, stream_answer

    if not await get_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not request.content.strip():
        raise HTTPException(status_code=422, detail="Question is required")
    return StreamingResponse(
        stream_answer(
            conversation_id,
            request.content,
            request.current_location.model_dump(),
            [item.model_dump() for item in request.local_highlights],
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Generate video script ───────────────────────────────
@app.post("/api/generate-script", response_model=ScriptResponse)
async def generate_script(request: ScriptRequest):
    """
    Generate a short video script from selected highlights.
    Uses the "editing-first, shooting-second" approach:
    hook → body (highlights + commentary) → CTA.
    """
    if not request.highlight_ids:
        raise HTTPException(status_code=422, detail="No highlight IDs provided")

    highlights = await get_highlights_by_ids(request.highlight_ids)

    if not highlights:
        raise HTTPException(status_code=404, detail="No highlights found for given IDs")

    from agent import generate_script as agent_generate
    result = agent_generate(highlights)

    return ScriptResponse(
        book_title=result["book_title"],
        script=result["script"],
        hook=result["hook"],
        body=result["body"],
        cta=result["cta"],
        duration_estimate_seconds=result["duration_estimate_seconds"],
        source_count=result["source_count"],
    )


# ── Creation drafts ────────────────────────────────────
@app.post("/api/drafts/generate")
async def generate_draft(request: DraftGenerateRequest):
    if request.target not in {"video", "article"}:
        raise HTTPException(status_code=422, detail="target must be video or article")
    if not request.highlight_ids:
        raise HTTPException(status_code=422, detail="No highlight IDs provided")

    highlights = await get_highlights_by_ids(request.highlight_ids)
    if not highlights:
        raise HTTPException(status_code=404, detail="No highlights found for given IDs")

    try:
        from llm import LLMConfigError, generate_draft_with_llm

        generated = await generate_draft_with_llm(
            target=request.target,
            highlights=highlights,
            topic=request.topic,
            tone=request.tone,
            extra_instruction=request.extra_instruction,
        )
    except LLMConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Draft generation failed")
        raise HTTPException(status_code=502, detail=f"Draft generation failed: {e}")

    draft = await create_draft(
        target=request.target,
        title=generated["title"],
        content=generated["content"],
        source_highlight_ids=request.highlight_ids,
        metadata=generated.get("metadata", {}),
    )
    for highlight_id in request.highlight_ids:
        await update_highlight(highlight_id, {"status": "used"})
    return draft


@app.get("/api/drafts")
async def get_drafts(target: Optional[str] = None, limit: int = 100, offset: int = 0):
    drafts = await list_drafts(target=target, limit=limit, offset=offset)
    return {"drafts": drafts, "count": len(drafts)}


@app.get("/api/drafts/{draft_id}")
async def get_draft_endpoint(draft_id: str):
    draft = await get_draft(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    return draft


@app.patch("/api/drafts/{draft_id}")
async def update_draft_endpoint(draft_id: str, request: DraftUpdate):
    data = request.model_dump(exclude_unset=True)
    data = {k: v for k, v in data.items() if v is not None}
    if not data:
        raise HTTPException(status_code=422, detail="No update fields provided")

    draft = await update_draft(draft_id, data)
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found")
    return draft


@app.delete("/api/drafts/{draft_id}")
async def delete_draft_endpoint(draft_id: str):
    deleted = await delete_draft(draft_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Draft not found")
    return {"deleted": True, "id": draft_id}


@app.post("/api/obsidian/export")
async def export_to_obsidian(request: ObsidianExportRequest):
    try:
        from obsidian import ObsidianConfigError, export_book_materials, export_draft

        if request.kind == "book":
            if not request.book_title:
                raise HTTPException(status_code=422, detail="book_title is required")
            highlights = await get_materials(book_title=request.book_title, limit=100000)
            path = export_book_materials(request.book_title, highlights)
        elif request.kind == "draft":
            if not request.draft_id:
                raise HTTPException(status_code=422, detail="draft_id is required")
            draft = await get_draft(request.draft_id)
            if not draft:
                raise HTTPException(status_code=404, detail="Draft not found")
            highlights = await get_highlights_by_ids(draft.get("source_highlight_ids", []))
            path = export_draft(draft, highlights)
            await update_draft(request.draft_id, {"exported_to_obsidian": True})
        else:
            raise HTTPException(status_code=422, detail="kind must be book or draft")
    except ObsidianConfigError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {"exported": True, "path": str(path)}


# ── Server-side EPUB books ─────────────────────────────
@app.get("/api/books")
async def get_books():
    """List canonical EPUBs in the persistent server library."""
    from library import list_library_books

    return {"books": await list_library_books()}


@app.post("/api/books/upload", status_code=202)
async def upload_server_book(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    author: str = Form(default=""),
):
    from library import upload_library_book

    content = await file.read(settings.max_epub_upload_mb * 1024 * 1024 + 1)
    book, created = await upload_library_book(
        content, file.filename or "book.epub", title, author
    )
    return {"book": book, "created": created}


@app.get("/api/books/{book_id}/file")
async def get_server_book_file(book_id: str):
    from library import serve_library_book

    return await serve_library_book(book_id)


@app.get("/api/books/{book_id}/sync")
async def get_server_book_sync(book_id: str):
    from library import get_book_state

    return await get_book_state(book_id)


@app.post("/api/books/{book_id}/sync")
async def sync_server_book(book_id: str, request: BookSyncRequest):
    from library import sync_book_state

    return await sync_book_state(
        book_id, [operation.model_dump() for operation in request.operations]
    )


@app.delete("/api/books/{book_id}")
async def delete_server_book(book_id: str):
    from library import delete_library_book

    if not await delete_library_book(book_id):
        raise HTTPException(status_code=404, detail="Book not found")
    return {"deleted": True, "id": book_id}


@app.get("/api/books/{filename:path}")
async def get_book(filename: str):
    """Legacy filename-based EPUB endpoint."""
    return serve_book(filename)


# ── Notes export ──────────────────────────────────────
@app.get("/api/notes/export")
async def export_notes():
    """Export all highlights as a standard JSON file."""
    path = await export_all_to_json()
    from fastapi.responses import FileResponse
    return FileResponse(
        path=str(path),
        media_type="application/json",
        filename="notes.json",
    )


async def _export_notes() -> None:
    """Fire-and-forget: write notes to JSON file."""
    try:
        path = await export_all_to_json()
        logger.info(f"Notes exported to {path}")
    except Exception as e:
        logger.error(f"Notes export failed: {e}")


# ── Static files (frontend) ──────────────────────────────
frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")


# ── Run ─────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8720, reload=True)
