@echo off
title TAASCOR Attendance Monitoring System
color 0b
echo ======================================================================
echo             TAASCOR ATTENDANCE MONITORING SYSTEM
echo ======================================================================
echo.
echo [1/3] Checking environment...
cd /d "c:\Users\LENOVO\Desktop\TAASCOR ATTENDACE MONITORING"

echo [2/3] Opening browser at http://localhost:3000/login ...
start http://localhost:3000/login

echo [3/3] Starting TAASCOR Server on Port 3000...
echo.
echo Press Ctrl+C anytime to stop the server.
echo ======================================================================
echo.

:loop
node server.js
echo.
echo [WARNING] Server stopped. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
