@echo off
chcp 65001 >nul
title Shopee Affiliate Hub - Servidor Local
cd /d "%~dp0"

echo ==================================================
echo   Shopee Affiliate Hub V2.1 - Iniciando no Windows
echo ==================================================

where node >nul 2>&1
if errorlevel 1 (
  echo [INFO] Node.js nao encontrado. Abrindo instalador automatico...
  call "%~dp0INSTALAR_FACIL_WINDOWS.bat"
  exit /b %errorlevel%
)

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
    echo [ERRO] Falha ao rodar npm install.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo [INFO] Compilando sistema ^(dist\index.js^)...
  call npm run build
  if errorlevel 1 (
    echo [ERRO] Falha ao compilar o projeto.
    pause
    exit /b 1
  )
)

echo [INFO] Aguardando servidor ficar pronto para abrir http://localhost:3000/admin ...
start /B "" powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 25; $i++) { Start-Sleep -Seconds 1; try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { Start-Process 'http://localhost:3000/admin'; break } } catch {} }"

echo [INFO] Mantenha esta janela aberta (pode minimizar) enquanto o robo estiver rodando.
node dist/index.js
pause
