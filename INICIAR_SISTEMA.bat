@echo off
title Shopee Affiliate Hub - Servidor Local
cd /d "%~dp0"

echo ==================================================
echo   Shopee Affiliate Hub - Iniciando no Windows
echo ==================================================

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [INFO] Arquivo .env criado a partir do .env.example.
  )
)

if not exist "node_modules" (
  echo [INFO] Instalando dependencias pela primeira vez...
  call npm install
  if errorlevel 1 (
    echo [ERRO] Falha ao rodar npm install. Verifique se o Node.js esta instalado.
    pause
    exit /b 1
  )
)

echo [INFO] Abrindo painel em http://localhost:3000/admin ...
start "" "http://localhost:3000/admin"

echo [INFO] Mantenha esta janela aberta enquanto o robo estiver rodando.
call npm run dev
pause
