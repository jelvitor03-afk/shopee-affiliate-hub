@echo off
chcp 65001 >nul
title Shopee Affiliate Hub - Instalador Facil (Windows)
cd /d "%~dp0"

echo ==================================================
echo   Shopee Affiliate Hub V2.1 - Instalacao Facil
echo ==================================================
echo.

REM 1. Verifica ou instala Node.js LTS
where node >nul 2>&1
if errorlevel 1 (
  echo [1/5] Node.js nao encontrado. Tentando instalar OpenJS.NodeJS.LTS via winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [ERRO] winget nao disponivel neste Windows.
    echo Baixe e instale manualmente o Node.js LTS em: https://nodejs.org
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs;%PATH%"
  where node >nul 2>&1
  if errorlevel 1 (
    echo [AVISO] Node.js instalado! Feche esta janela e abra o INSTALAR_FACIL_WINDOWS.bat novamente.
    pause
    exit /b 0
  )
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js detectado: %%v

REM 2. Verifica ou instala FFmpeg (necessario para audio OGG/Opus no WhatsApp)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [2/5] FFmpeg nao encontrado. Tentando instalar Gyan.FFmpeg via winget...
  where winget >nul 2>&1
  if not errorlevel 1 (
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
  ) else (
    echo [AVISO] Instale o FFmpeg manualmente para enviar notas de voz OGG/Opus.
  )
) else (
  echo [OK] FFmpeg detectado.
)

REM 3. Verifica Python e instala Edge-TTS gratuito (voz neural pt-BR local)
where python >nul 2>&1
if not errorlevel 1 (
  python -m edge_tts --version >nul 2>&1
  if errorlevel 1 (
    echo [3/5] Instalando Edge-TTS gratuito para voz neural pt-BR...
    python -m pip install edge-tts --quiet
  )
  echo [OK] Python / Edge-TTS pronto.
) else (
  echo [3/5] Python nao encontrado ^(opcional - necessario apenas para Edge-TTS ou Voicebox local^).
)

REM 4. Cria .env a partir do .env.example (nunca sobrescreve .env existente) e gera SESSION_SECRET
echo [4/5] Preparando configuracao .env...
if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    node -e "const fs=require('fs'),c=require('crypto');let t=fs.readFileSync('.env','utf8');if(/^SESSION_SECRET=\s*$/m.test(t)){t=t.replace(/^SESSION_SECRET=\s*$/m,'SESSION_SECRET='+c.randomBytes(24).toString('hex'));fs.writeFileSync('.env',t,'utf8');}"
    echo [OK] Arquivo .env criado com SESSION_SECRET aleatorio.
  )
) else (
  echo [OK] Arquivo .env existente preservado.
)

REM 5. Instala dependencias Node e compila o sistema
echo [5/5] Instalando pacotes e compilando ^(dist/^)...
call npm install
if errorlevel 1 (
  echo [ERRO] Falha no npm install. Confira sua conexao com a internet.
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo [ERRO] Falha ao compilar TypeScript ^(npm run build^).
  pause
  exit /b 1
)

echo.
echo ==================================================
echo   INSTALACAO CONCLUIDA COM SUCESSO!
echo ==================================================
echo   - Para iniciar sempre: clique 2x em INICIAR_SISTEMA.bat
echo   - Senha padrao no .env: ADMIN_PASSWORD=troque-esta-senha
echo   - Depois de entrar no painel, abra a aba:
echo     "Passo a Passo (Como Usar)"
echo ==================================================
echo.
set /p START_NOW="Deseja abrir o sistema agora? (S/N): "
if /I "%START_NOW%"=="S" (
  call "%~dp0INICIAR_SISTEMA.bat"
)
exit /b 0
