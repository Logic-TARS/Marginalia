"""Marginalia API — FastAPI application."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import (
    init_db,
    save_highlights,
    get_all_highlights,
    get_highlights_by_ids,
)
from models import HighlightCreate, SyncRequest, SyncResponse, ScriptRequest, ScriptResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("marginalia")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    await init_db()
    logger.info("Database initialized")
    yield


app = FastAPI(
    title="Marginalia API",
    description="E-book highlights → Feishu → Short Video Agent",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow all origins for MVP
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    2. Fire-and-forget forward to Feishu webhook
    3. Return assigned IDs
    """
    if not request.highlights:
        raise HTTPException(status_code=422, detail="No highlights provided")

    try:
        highlights_dicts = [h.model_dump() for h in request.highlights]
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid highlight data: {e}")

    ids = await save_highlights(highlights_dicts)
    logger.info(f"Saved {len(ids)} highlights")

    # Fire-and-forget: push to Feishu webhook (don't block the response)
    if settings.feishu_webhook_url:
        asyncio.create_task(_send_to_feishu(highlights_dicts, ids))

    return SyncResponse(received=len(ids), ids=ids)


# ── List highlights ─────────────────────────────────────
@app.get("/api/highlights")
async def list_highlights(
    book_title: str | None = None,
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


# ── Internal: Feishu forwarding ─────────────────────────
async def _send_to_feishu(highlights: list[dict], ids: list[str]) -> None:
    """Fire-and-forget: send highlights to Feishu webhook."""
    try:
        from feishu import send_to_feishu_webhook
        success = await send_to_feishu_webhook(highlights)
        if success:
            from database import mark_feishu_synced
            await mark_feishu_synced(ids)
            logger.info(f"Feishu webhook sent for {len(ids)} highlights")
        else:
            logger.warning("Feishu webhook returned non-200")
    except Exception as e:
        logger.error(f"Feishu webhook failed: {e}")


# ── Run ─────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
