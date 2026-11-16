@echo off
title Court Docs Helper
cd /d "%~dp0"
node scripts\court-docs-helper.js
echo.
echo The helper has stopped. Press any key to close this window.
pause >nul
