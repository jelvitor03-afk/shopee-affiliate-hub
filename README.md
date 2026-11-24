# Shopee Affiliate Hub V2.1 (Windows Sem Docker)

Central completa em **Node.js + TypeScript + SQLite nativo (`node:sqlite`)** para afiliados Shopee rodarem direto no Windows — **sem Docker**, **sem C++ build tools** e com **Passo a Passo interativo** dentro do próprio painel `/admin`.

---

## O que vem pronto na versão V2.1

1. **Painel Campanhas ROI sem Pixel (`Afiliado Dash` via `sub_id` + Meta Marketing API)**:
   - Cruza investimento, cliques e orçamento da Meta com as comissões da Shopee (`conversionReport` + `sub_id`) em tempo real.
   - Mostra **8 KPIs** no topo (`Investimento`, `Total de Comissões`, `Lucro`, `ROAS`, `Total de Pedidos`, `Cliques no Anúncio`, `Cliques no Link`, `CPC Médio`).
   - Tabela ordenável com chave **Status (`ACTIVE`/`PAUSED`)**, edição rápida de **Orçamento**, seletor **Colunas**, botão **Vincular** para gerar link com `sub_id` em 1 clique e **Modo Demo** para explorar antes de conectar as chaves reais.
2. **Atendimento X1 Híbrido + Voz Real `OGG/Opus` + Trava `RAG + Jev`**:
   - Funciona **com ou sem API da Meta**: escolha **Baileys (QR Code grátis no privado com opções `1, 2, 3`)** ou **WhatsApp Cloud API oficial** (botões clicáveis de até 20 caracteres + assinatura `X-Hub-Signature-256`).
   - IA configurável entre nuvem (**Gemini / Groq / OpenRouter / OpenAI**) ou 100% local (**Ollama `:11434` / LM Studio `:1234`**).
   - **Voz e Áudio**: Transcrição (`STT` via Gemini, Groq/Whisper ou Voicebox) + fala convertida para **`OGG/Opus` (`ptt: true`)** via FFmpeg usando **`Edge-TTS Local`** (grátis em qualquer PC), **`jamiepine/voicebox`** local (clonagem com `.wav` de 15–30s) ou **ElevenLabs** — com fallback automático em texto se a voz falhar e botão **Testar Voz Agora** no painel.
   - **Catálogo RAG + Jev + Human Takeover**: Pontua respostas (`0.00–1.00`), bloqueia chute de preço/link fora do catálogo, marca *"Aguardando Humano"* e silencia a IA automaticamente por 30 minutos quando você responde pelo celular.
3. **Motor de Blindagem Anti-Ban**:
   - **Debounce** (agrupa mensagens rápidas seguidas em 1 resposta), fila sequencial com jitter e pausas periódicas, presets **Conservador / Moderado / Veterano**, limites por hora/dia, janela 24h inbound-only, **Blacklist** automática por opt-out (`parar`, `sair`, etc.) e **Circuit Breaker** (pausa tudo após 3 falhas consecutivas).
4. **Grupo de Achadinhos Automático (`Baileys`)**:
   - Conexão via QR Code dentro do painel `/admin`, filtro por palavras-chave, janela de horário configurável e histórico no SQLite para nunca repetir produtos no grupo.
5. **Guia Interativo Integrado (`Passo a Passo (Como Usar)`)**:
   - Checklist ao vivo de progresso (`0 de 5 etapas`), explicação simples de cada etapa e botões que levam direto para o campo exato que precisa ser preenchido.

---

## Instalação Fácil em Qualquer PC Windows (Sem Saber Programar)

1. Baixe este repositório pelo botão verde **`Code -> Download ZIP`** no GitHub e extraia a pasta no seu PC *(ou rode `git clone`)*.
2. Dê **duplo clique** em **`INSTALAR_FACIL_WINDOWS.bat`**.
   - Ele verifica/instala automaticamente **Node.js LTS**, **FFmpeg** (para áudios `OGG/Opus`) e **Edge-TTS** gratuito, cria o arquivo `.env` com `SESSION_SECRET` aleatório, instala as dependências e compila o sistema.
3. Dê **duplo clique** em **`INICIAR_SISTEMA.bat`**.
   - Ele sobe o servidor na porta `3000`, espera responder e abre automaticamente o painel em **`http://localhost:3000/admin`**.

### Primeira Senha & Alteração
- A senha inicial vem em `.env` como `ADMIN_PASSWORD=troque-esta-senha`.
- Troque para uma senha forte editando `.env` no Bloco de Notas antes de expor o painel na internet.

---

## Como Configurar (Dentro do Próprio Painel)

Ao fazer login em `http://localhost:3000/admin`, clique na aba **`Passo a Passo (Como Usar)`** (ou no botão **Passo a Passo** no topo). Lá você acompanha em tempo real:
- **Passo 1:** Ligar/manter o Windows ativo sem hibernar + senha no `.env` (sem precisar de túnel público para Baileys/ROI).
- **Passo 2:** Conectar `Shopee AppId` e `Shopee Secret` (`affiliate.shopee.com.br` → Open API).
- **Passo 3:** Conectar `Meta Ad Account ID` (`act_...`) e Token no painel **Campanhas (ROI)** + vincular anúncios com `sub_id`.
- **Passo 4:** Configurar **X1 Híbrido + Voz (`Edge-TTS` / `Voicebox`) + Catálogo `RAG + Jev`**.
- **Passo 5:** Conectar WhatsApp por QR Code e ligar o **Grupo de Achadinhos**.
- **Passo 6:** Escolher o preset **Anti-Ban** ideal para a idade do seu chip.

> Para configurar clonagem de voz local offline com `jamiepine/voicebox`, consulte [INSTALAR_VOZ_LOCAL_WINDOWS.md](./INSTALAR_VOZ_LOCAL_WINDOWS.md).

---

## Túnel Público HTTPS (Apenas se Usar Cloud API Oficial da Meta ou Links `/go/`)

Se você usar **Baileys (QR Code)** + **Campanhas ROI**, **não** precisa abrir túnel.
Caso queira usar a **WhatsApp Cloud API oficial da Meta** ou divulgar links `/go/`:
1. Com `INICIAR_SISTEMA.bat` rodando, dê duplo clique em **`ABRIR_TUNEL_PUBLICO.bat`**.
2. Copie a URL `https://...trycloudflare.com` exibida e salve em **Visão Geral -> URL Pública Atual** dentro de `/admin`.

---

## Comandos Úteis & Deploy Futuro em Nuvem

- **Rodar testes automatizados:** `npm test`
- **Checar tipos e build:** `npm run typecheck && npm run build`
- **Deploy 24h em nuvem (Railway / Render / EasyPanel / Coolify):**
  - Use o `Dockerfile` incluso, monte um volume persistente em `/app/data` (para preservar o banco SQLite e a sessão Baileys) e defina `ADMIN_PASSWORD`, `SESSION_SECRET`, `PUBLIC_BASE_URL` e `PORT=3000`.
- **Segurança:** Nunca faça commit do arquivo `.env` nem da pasta `data/` (ambos já protegidos no `.gitignore`).
