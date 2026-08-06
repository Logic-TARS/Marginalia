"""Tests for chat and embedding configuration isolation."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import dotenv


CONFIG_PATH = Path(__file__).parents[1] / "config.py"


def _load_settings(monkeypatch, values: dict[str, str]):
    names = {
        "LLM_BASE_URL",
        "LLM_API_KEY",
        "LLM_MODEL",
        "LLM_EMBEDDING_MODEL",
        "EMBEDDING_BASE_URL",
        "EMBEDDING_API_KEY",
        "EMBEDDING_MODEL",
        "CORS_ORIGINS",
        "ALLOWED_HOSTS",
        "MAX_EPUB_UPLOAD_MB",
        "TTS_ENABLED",
        "TTS_PROVIDER",
        "TTS_STORAGE_PATH",
        "TTS_DEFAULT_VOICE",
        "TTS_MAX_CONCURRENCY",
        "TTS_MAX_RETRIES",
        "TTS_SEGMENT_MAX_CHARS",
        "TTS_REQUEST_TIMEOUT",
        "TTS_CACHE_RETENTION_DAYS",
        "TTS_MAX_TASKS_PER_CLIENT",
        "TTS_CREATE_RATE_LIMIT_PER_MINUTE",
        "TTS_MIN_AUDIO_BYTES",
    }
    for name in names:
        monkeypatch.delenv(name, raising=False)
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *_args, **_kwargs: False)

    spec = importlib.util.spec_from_file_location("config_under_test", CONFIG_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.settings


def test_chat_and_embedding_endpoints_are_independent(monkeypatch):
    settings = _load_settings(
        monkeypatch,
        {
            "LLM_BASE_URL": "https://chat.example/v1/",
            "LLM_API_KEY": "chat-key",
            "LLM_MODEL": "chat-model",
            "EMBEDDING_BASE_URL": "http://127.0.0.1:11434/v1/",
            "EMBEDDING_API_KEY": "ollama",
            "EMBEDDING_MODEL": "embedding-model",
        },
    )

    assert settings.llm_base_url == "https://chat.example/v1"
    assert settings.llm_model == "chat-model"
    assert settings.embedding_base_url == "http://127.0.0.1:11434/v1"
    assert settings.embedding_api_key == "ollama"
    assert settings.embedding_model == "embedding-model"


def test_legacy_embedding_model_and_endpoint_fallback(monkeypatch):
    settings = _load_settings(
        monkeypatch,
        {
            "LLM_BASE_URL": "https://legacy.example/v1",
            "LLM_API_KEY": "legacy-key",
            "LLM_EMBEDDING_MODEL": "legacy-embedding",
        },
    )

    assert settings.embedding_base_url == "https://legacy.example/v1"
    assert settings.embedding_api_key == "legacy-key"
    assert settings.embedding_model == "legacy-embedding"
    assert settings.llm_embedding_model == "legacy-embedding"


def test_api_keys_ignore_inline_annotations(monkeypatch):
    settings = _load_settings(
        monkeypatch,
        {
            "LLM_API_KEY": "sk-chat annotation",
            "EMBEDDING_API_KEY": "ollama local-only",
        },
    )

    assert settings.llm_api_key == "sk-chat"
    assert settings.embedding_api_key == "ollama"


def test_production_security_settings_are_parsed(monkeypatch):
    settings = _load_settings(
        monkeypatch,
        {
            "CORS_ORIGINS": "https://read.zengziyang.com",
            "ALLOWED_HOSTS": "read.zengziyang.com, localhost,127.0.0.1",
            "MAX_EPUB_UPLOAD_MB": "90",
        },
    )

    assert settings.cors_origin_list == ["https://read.zengziyang.com"]
    assert settings.allowed_host_list == [
        "read.zengziyang.com",
        "localhost",
        "127.0.0.1",
    ]
    assert settings.max_epub_upload_mb == 90


def test_security_defaults_are_local_only(monkeypatch):
    settings = _load_settings(monkeypatch, {})

    assert settings.allowed_host_list == ["localhost", "127.0.0.1", "testserver"]
    assert settings.max_epub_upload_mb == 90


def test_tts_defaults_and_environment_overrides(monkeypatch):
    defaults = _load_settings(monkeypatch, {})
    assert defaults.tts_enabled is True
    assert defaults.tts_provider == "edge-tts"
    assert defaults.tts_default_voice == "zh-CN-XiaoxiaoNeural"
    assert defaults.tts_max_concurrency == 3
    assert defaults.tts_segment_max_chars == 1000

    configured = _load_settings(monkeypatch, {
        "TTS_ENABLED": "false",
        "TTS_MAX_CONCURRENCY": "4",
        "TTS_MAX_RETRIES": "2",
        "TTS_SEGMENT_MAX_CHARS": "800",
        "TTS_REQUEST_TIMEOUT": "45",
        "TTS_CACHE_RETENTION_DAYS": "7",
    })
    assert configured.tts_enabled is False
    assert configured.tts_max_concurrency == 4
    assert configured.tts_max_retries == 2
    assert configured.tts_segment_max_chars == 800
    assert configured.tts_request_timeout == 45
    assert configured.tts_cache_retention_days == 7
