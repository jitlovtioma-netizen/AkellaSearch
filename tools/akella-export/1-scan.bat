@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Установите Node.js LTS с https://nodejs.org и запустите снова. & pause & exit /b 1)
if not exist node_modules (echo Устанавливаю зависимости... & call npm install --no-audit --no-fund)
node index.mjs scan %*
pause
