@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Marginalia

set "DEFAULT_PORT=8720"
set "PORT=%DEFAULT_PORT%"
set "FALLBACK_PORTS=8721 8722 8723 8724 8725"

echo.
echo ================================
echo   Marginalia - EPUB Reader
echo ================================
echo.

:: Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Please install Python 3.12+
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
)

:: Switch to backend directory
cd /d "%~dp0backend"

:: Copy .env if not exists
if not exist ".env" (
    echo [INFO] Creating .env from .env.example...
    copy "..\.env.example" ".env" >nul
)

:: Check and install dependencies
echo [INFO] Checking dependencies...
pip show fastapi >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Installing dependencies, please wait...
    pip install -r requirements.txt -q
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
    echo [INFO] Dependencies installed
)

:: Pick an available port, or reuse an already running server.
call :is_port_busy %PORT%
if "%PORT_BUSY%"=="1" (
    call :is_server_ready %PORT%
    if "!SERVER_READY!"=="1" (
        echo [INFO] Marginalia is already running: http://localhost:%PORT%
        echo [INFO] Opening browser...
        start "" "http://localhost:%PORT%"
        goto :done
    )

    echo [WARN] Port %PORT% is already in use. Looking for a fallback port...
    set "PORT="
    for %%P in (%FALLBACK_PORTS%) do (
        call :is_port_busy %%P
        if "!PORT_BUSY!"=="0" if not defined PORT set "PORT=%%P"
    )
)

if not defined PORT (
    echo [ERROR] No available port found. Tried %DEFAULT_PORT% %FALLBACK_PORTS%
    pause
    exit /b 1
)

:: Open browser
echo [INFO] Opening browser...
start "" "http://localhost:%PORT%"

:: Start server
echo.
echo [INFO] Starting server: http://localhost:%PORT%
echo [INFO] Press Ctrl+C to stop
echo.

python -m uvicorn main:app --host 127.0.0.1 --port %PORT% --reload

:done
pause
exit /b 0

:is_port_busy
set "PORT_BUSY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %~1 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 set "PORT_BUSY=1"
exit /b 0

:is_server_ready
set "SERVER_READY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%~1/' -TimeoutSec 3; if ($response.Content -like '*Marginalia*') { exit 0 } } catch { }; exit 1" >nul 2>&1
if %errorlevel% equ 0 set "SERVER_READY=1"
exit /b 0
