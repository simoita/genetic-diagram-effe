@echo off
chcp 65001 >nul
title Diagramma Cascata - Server Locale
cd /d "%~dp0"

echo.
echo ==========================================
echo   Avvio server Diagramma Cascata...
echo ==========================================
echo.

:: Pulisce la porta 8000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo [1/2] Avvio del server...
start /b python -m http.server 8000 --bind 0.0.0.0

timeout /t 2 >nul

echo [2/2] Apertura del browser...
start "" "http://localhost:8000/runme.html"

echo.
echo ==========================================
echo   SERVER ATTIVO sulla porta 8000
echo ==========================================
echo.
echo   Chiudi questa finestra per fermare il server.
echo ==========================================
echo.
pause