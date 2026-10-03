@echo off
title Toonflow Server
echo ==========================================
echo Starting Toonflow Server...
echo ==========================================
cd /d "%~dp0"
bun run start:server
pause
