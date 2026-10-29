@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (echo Устанавливаю зависимости... & call npm install --no-audit --no-fund)
node index.mjs run %*
pause
