@echo off
title Toonflow Dev
echo ==========================================
echo Starting Toonflow in Dev Mode...
echo ==========================================
cd /d "%~dp0"
bun run dev
pause
