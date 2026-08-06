"""Application configuration loaded from environment variables."""

import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent / ".env")


def _env_token(name: str, fallback: str = "") -> str:
    """Read an API token without accidentally including an inline annotation."""
    value = os.getenv(name, fallback).strip()
    return value.split(maxsplit=1)[0] if value else ""


def _env_bool(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    """Settings with defaults, reads from .env via os.environ."""

    # Database
    database_url: str = os.getenv(
        "DATABASE_URL",
        f"sqlite+aiosqlite:///{Path(__file__).parent / 'data' / 'marginalia.db'}"
    )

    # CORS
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")
    allowed_hosts: str = os.getenv(
        "ALLOWED_HOSTS", "localhost,127.0.0.1,testserver"
    )

    # OpenAI-compatible chat endpoint
    llm_base_url: str = os.getenv("LLM_BASE_URL", "").rstrip("/")
    llm_api_key: str = _env_token("LLM_API_KEY")
    llm_model: str = os.getenv("LLM_MODEL", "")

    # OpenAI-compatible embedding endpoint. The LLM_* fallbacks preserve
    # compatibility with deployments that used one endpoint for both jobs.
    embedding_base_url: str = os.getenv(
        "EMBEDDING_BASE_URL", os.getenv("LLM_BASE_URL", "")
    ).rstrip("/")
    embedding_api_key: str = _env_token(
        "EMBEDDING_API_KEY", _env_token("LLM_API_KEY")
    )
    embedding_model: str = os.getenv(
        "EMBEDDING_MODEL", os.getenv("LLM_EMBEDDING_MODEL", "")
    )
    # Deprecated compatibility alias for third-party imports.
    llm_embedding_model: str = embedding_model

    # Knowledge base
    max_epub_upload_mb: int = int(os.getenv("MAX_EPUB_UPLOAD_MB", "90"))

    # Text-to-speech
    tts_enabled: bool = _env_bool("TTS_ENABLED", True)
    tts_provider: str = os.getenv("TTS_PROVIDER", "edge-tts").strip().lower()
    tts_storage_path: str = os.getenv(
        "TTS_STORAGE_PATH", str(Path(__file__).parent / "data" / "tts")
    )
    tts_default_voice: str = os.getenv(
        "TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural"
    ).strip()
    tts_max_concurrency: int = max(1, int(os.getenv("TTS_MAX_CONCURRENCY", "3")))
    tts_max_retries: int = max(0, int(os.getenv("TTS_MAX_RETRIES", "3")))
    tts_segment_max_chars: int = max(
        100, min(1500, int(os.getenv("TTS_SEGMENT_MAX_CHARS", "1000")))
    )
    tts_request_timeout: float = max(
        5.0, float(os.getenv("TTS_REQUEST_TIMEOUT", "120"))
    )
    tts_cache_retention_days: int = max(
        0, int(os.getenv("TTS_CACHE_RETENTION_DAYS", "30"))
    )
    tts_max_tasks_per_client: int = max(
        1, int(os.getenv("TTS_MAX_TASKS_PER_CLIENT", "2"))
    )
    tts_create_rate_limit_per_minute: int = max(
        1, int(os.getenv("TTS_CREATE_RATE_LIMIT_PER_MINUTE", "10"))
    )
    tts_min_audio_bytes: int = max(
        1, int(os.getenv("TTS_MIN_AUDIO_BYTES", "128"))
    )

    # Obsidian export
    obsidian_vault_path: str = os.getenv("OBSIDIAN_VAULT_PATH", "")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.allowed_hosts.split(",") if host.strip()]


settings = Settings()
