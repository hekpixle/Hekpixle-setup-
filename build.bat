@echo off
setlocal
chcp 65001 >nul
title Hekpixle - Build Installer
cd /d "%~dp0"
echo ==============================================
echo   Hekpixle - building the Windows installer
echo   Folder: %CD%
echo ==============================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo Administrator permission is needed once so Windows can unpack the build tools.
  echo A permission window will open - press Yes.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set CSC_IDENTITY_AUTO_DISCOVERY=false

if not exist "package.json" (
  echo [ERROR] package.json not found in this folder.
  echo If you opened this file from inside the ZIP, first right-click the ZIP
  echo and choose "Extract All", then run build.bat from the extracted folder.
  goto fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Download the LTS version from https://nodejs.org
  echo then close this window and run build.bat again.
  goto fail
)
echo Node version:
call node -v
echo.

echo [1/2] Installing dependencies - this can take a few minutes...
call npm install
if errorlevel 1 goto fail

echo.
echo [2/2] Building the Windows installer - the first run downloads Electron, please wait...
call npm run dist > build-log.txt 2>&1
if errorlevel 1 (
  type build-log.txt
  echo.
  echo The full log was saved in build-log.txt - send it to me.
  goto fail
)
type build-log.txt

echo.
if exist "release" rmdir /s /q "release"
mkdir "release"
copy /y "dist\Hekpixle-Setup-*.exe" "release\" >nul
if not exist "release\Hekpixle-Setup-0.13.1.exe" (
  echo [ERROR] The installer file was not produced. See build-log.txt
  goto fail
)
echo ==============================================
echo   Done! ONE file is ready:
echo   release\Hekpixle-Setup-0.13.1.exe
echo   (this single file installs the app - nothing else is needed)
echo ==============================================
start "" "%~dp0release"
pause
exit /b 0

:fail
echo.
echo Build failed. Read the messages above, then press any key.
pause
exit /b 1
