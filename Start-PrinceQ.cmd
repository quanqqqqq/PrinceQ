@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missingnode
node scripts\check-node.mjs
if errorlevel 1 goto failed
if exist node_modules goto database
call npm.cmd ci
if errorlevel 1 goto failed
:database
call npm.cmd run db:setup
if errorlevel 1 goto failed
echo Open http://127.0.0.1:28641 after both services are ready.
echo Keep this window open. Press Ctrl+C to stop PrinceQ.
call npm.cmd run dev
if errorlevel 1 goto failed
exit /b 0
:missingnode
echo Install Node.js 24 x64, then reopen this launcher.
:failed
echo PrinceQ did not start successfully. Review the error above.
pause
exit /b 1
