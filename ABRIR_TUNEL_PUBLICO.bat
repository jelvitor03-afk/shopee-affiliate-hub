@echo off
title Shopee Affiliate Hub - Tunel Publico HTTPS
cd /d "%~dp0"

echo ==================================================
echo   Abrindo Tunel Publico HTTPS (Cloudflare Tunnel)
echo ==================================================

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo [INFO] cloudflared nao encontrado. Tentando instalar via winget...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo [ERRO] Nao foi possivel instalar automaticamente.
    echo Baixe manualmente: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    pause
    exit /b 1
  )
)

echo [INFO] Copie a URL https://...trycloudflare.com que vai aparecer abaixo
echo [INFO] e cole no campo "URL Publica Atual" do painel /admin e na Meta!
echo.
cloudflared tunnel --url http://localhost:3000
pause
