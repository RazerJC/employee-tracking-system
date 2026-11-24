@echo off
setlocal
title TAASCOR Attendance Monitoring System
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" -Open
set "server_exit=%errorlevel%"
if not "%server_exit%"=="0" pause
exit /b %server_exit%
