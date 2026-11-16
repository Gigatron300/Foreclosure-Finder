@echo off
title Court Docs Helper - Setup
cd /d "%~dp0"
echo.
echo  Court Docs Helper - Setup
echo  -------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Step 1 of 3: Node.js is needed and is not installed. Installing it now...
  echo.
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo.
    echo  Node.js could not be installed automatically.
    echo  Download and install it from https://nodejs.org  ^(the LTS version^), then run Setup again.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo  Node.js is installed. Close this window and double-click Setup again to finish.
  echo.
  pause
  exit /b 0
)

echo  Step 1 of 3: Node.js found.
echo  Step 2 of 3: Downloading what the helper needs ^(about a minute^)...
call npm install --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo  The download failed. Check the internet connection and run Setup again.
  echo.
  pause
  exit /b 1
)

echo  Step 3 of 3: Choose the PROPERTIES folder ^(a window will open; it may be behind this one^)...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup.ps1"
echo.
pause
