# Shopee Affiliate Hub (Windows Sem Docker)

Central única em **Node.js + TypeScript + SQLite nativo (`node:sqlite`)** para rodar no Windows sem Docker, sem C++ build tools e com tudo configurável direto pelo painel web `/admin`.

## O que este projeto faz

1. **Tracker Shopee → Meta CAPI (`/go/:slug`)**:
   - Captura `fbclid`, `_fbp`, `_fbc`, IP e User-Agent quando o lead clica no anúncio do Facebook/Instagram.
   - Gera o link encurtado na Shopee Affiliate API passando um `click_id` alfanumérico em `subIds`.
   - A cada 15 minutos consulta `conversionReport` na Shopee (incluindo pedidos pendentes antes dos 2 dias do painel) e dispara o evento `Purchase` para a API de Conversões da Meta com deduplicação por `order_id`.
2. **Grupo de Achadinhos Automático (`@whiskeysockets/baileys`)**:
   - Conecta via QR Code direto dentro do painel `/admin`.
   - Busca ofertas na Shopee (`productOfferV2`), gera texto curto (com IA ou modelo pronto), evita produtos repetidos no SQLite e posta imagem + legenda + link no grupo com simulação de digitação e janela de horário configurável.
3. **Atendimento X1 com IA e Botões Clicáveis (WhatsApp Cloud API oficial)**:
   - Recebe mensagens em `/webhook/whatsapp`, responde com Gemini ou OpenAI mantendo histórico curto no SQLite e envia até **3 botões interativos** (limite oficial de 20 caracteres garantido).
   - Ao clicar em um botão, o lead recebe na hora o texto + link de afiliado configurado no painel.

---

## Parte 1 — Para o Jel (Rodar no Windows e Subir no GitHub)

### 1. Pré-requisitos no Windows
- **Node.js 22.13+** (recomendado Node 24 LTS) — já inclui `node:sqlite`.
- **Git for Windows** (e opcionalmente `gh` CLI).

### 2. Iniciar com 2 cliques
1. Dê duplo clique em **`INICIAR_SISTEMA.bat`** (ou rode no terminal `npm install` e depois `npm run dev`).
2. O painel abre automaticamente em `http://localhost:3000/admin`.
3. Senha inicial padrão: `troque-esta-senha` (altere no arquivo `.env` em `ADMIN_PASSWORD=...`).

### 3. Deixar online com link `https://` para a Meta e Anúncios
1. Com o servidor aberto, dê duplo clique em **`ABRIR_TUNEL_PUBLICO.bat`**.
2. Ele gera uma URL pública temporária do Cloudflare Tunnel (`https://xxxx.trycloudflare.com`).
3. Desative o modo de suspensão do Windows enquanto o computador estiver servindo o sistema.

### 4. Subir no GitHub (para ela baixar ou fazer deploy em nuvem depois)
No terminal dentro desta pasta:
```powershell
git remote add origin https://github.com/SEU_USUARIO/shopee-affiliate-hub.git
git push -u origin main
```
*(Ou use `gh repo create shopee-affiliate-hub --private --source=. --push` se estiver logado no GitHub CLI.)*

> Nunca suba o arquivo `.env` nem a pasta `data/` (o `.gitignore` já protege ambos).

---

## Parte 2 — Para a Operação (Colar Chaves e Configurar no Painel `/admin`)

Você **não precisa mexer em código**. Entre em `/admin` e siga esta ordem:

1. **Aba "Visão Geral"**:
   - Cole a URL pública do túnel (`https://...trycloudflare.com`) em **URL Pública Atual** e clique em **Salvar URL**.
   - Copie a **URL de Callback do Webhook** e o **Token de Verificação** para colar no painel da Meta.
2. **Aba "Meta Pixel & Shopee"**:
   - Cole o **Meta Pixel ID** e o **Token da API de Conversões (CAPI)**.
   - Cole o **Shopee AppId** e **Shopee App Secret** (aprovados no painel de Afiliados da Shopee).
   - Clique em **Salvar Chaves** e depois em **Testar Pixel (CAPI)**.
   - Crie seus links rastreáveis `/go/apelido` para usar nos anúncios de Facebook/Instagram.
3. **Aba "Grupo de Achadinhos"**:
   - Clique em **Conectar / Gerar QR Code** e escaneie com um chip dedicado de WhatsApp.
   - Clique em **Buscar Meus Grupos**, escolha o grupo de achadinhos e salve o intervalo e palavras-chave.
4. **Aba "X1 com IA & Botões"**:
   - Cole o **Permanent Token** e **Phone Number ID** da WhatsApp Cloud API (Meta for Developers).
   - Cole a chave da IA (Gemini ou OpenAI), ajuste o prompt e edite os **3 botões** (máximo de 20 caracteres no título) com os links dos seus produtos/grupo.

---

## Parte 3 — Deploy Futuro em Nuvem (Opcional)
Quando quiser tirar do PC e rodar 24h em nuvem (Railway, Render, EasyPanel ou Coolify):
- Conecte o repositório do GitHub usando o `Dockerfile` incluso.
- Monte um volume persistente na pasta `/app/data` (para não perder o SQLite nem o login do WhatsApp).
- Defina `ADMIN_PASSWORD`, `PUBLIC_BASE_URL` e `PORT=3000`.
