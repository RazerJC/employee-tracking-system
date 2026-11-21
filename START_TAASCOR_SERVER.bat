@echo off
setlocal
title TAASCOR Attendance Monitoring System
cd /d "%~dp0"
node server.js --open-local
set "server_exit=%errorlevel%"
if not "%server_exit%"=="0" pause
exit /b %server_exit%
