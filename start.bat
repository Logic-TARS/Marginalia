@echo off
setlocal EnableExtensions
title Marginalia

set "PROJECT_ROOT=%~dp0"
set "VENV_DIR=%PROJECT_ROOT%.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "PORT=8720"

echo.
echo ================================
echo   Marginalia - EPUB Reader
echo ================================
echo.

if not exist "%VENV_PYTHON%" (
    echo [INFO] Creating project virtual environment...
    set "BOOTSTRAP_PYTHON=python"
    python -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>&1
    if errorlevel 1 (
        py -3.11 -c "import sys" >nul 2>&1
        if errorlevel 1 (
            echo [ERROR] Python 3.11 is required to create .venv.
            pause
            exit /b 1
        )
        set "BOOTSTRAP_PYTHON=py -3.11"
    )
    %BOOTSTRAP_PYTHON% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create .venv.
        pause
        exit /b 1
    )
)

"%VENV_PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] .venv must use Python 3.11. Remove it manually and run this script again.
    pause
    exit /b 1
)

if not exist "%PROJECT_ROOT%.env" (
    echo [INFO] Creating .env from .env.example...
    copy "%PROJECT_ROOT%.env.example" "%PROJECT_ROOT%.env" >nul
)

echo [INFO] Checking isolated dependencies...
"%VENV_PYTHON%" -c "import fastapi, ebooklib, bs4, multipart, pytest" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing dependencies into .venv...
    "%VENV_PYTHON%" -m pip install -r "%PROJECT_ROOT%backend\requirements.txt"
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies into .venv.
        pause
        exit /b 1
    )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo [ERROR] Port %PORT% is already in use. Stop the existing service first.
    pause
    exit /b 1
)

cd /d "%PROJECT_ROOT%backend"
echo [INFO] Python: %VENV_PYTHON%
echo [INFO] Starting server: http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
"%VENV_PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port %PORT%

pause
exit /b %errorlevel%
