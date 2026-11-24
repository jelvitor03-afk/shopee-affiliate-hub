# Guia de Voz Clonada, Áudio e IA Local no Windows (Sem API Paga)

Este guia mostra exatamente o que roda **leve hoje** no seu notebook atual e como ligar a **clonagem de voz real (`jamiepine/voicebox`)** e **IA local (`Ollama`)** caso queira 100% offline.

---

## 1. Realidade de Hardware desta Máquina (Verificada)
- **Memória RAM**: `7,9 GB` totais (~`1 GB` livre com navegador e sistema abertos)
- **Placa de Vídeo**: `NVIDIA GeForce GTX 850M (2 GB VRAM)`
- **Ferramentas já instaladas**: `ffmpeg` e `edge-tts 7.3.1`

### Recomendação Honesta
- **Para rodar hoje sem travar o Windows**:
  - **Voz (TTS)**: Use **`Edge-TTS PT-BR Local`** (já vem selecionado no `/admin` como padrão — consome ~0 MB de RAM e gera nota de voz OGG/Opus PT-BR na hora com o `ffmpeg`).
  - **Cérebro (IA)**: Use **Google Gemini** ou **Groq API** (`llama-3.3-70b-versatile`) pelo botão de preset no `/admin` (ambos possuem nível gratuito rápido e não consomem RAM do PC).
- **Se quiser rodar LLM + Clonagem de Voz 100% offline (sem internet/API externa)**:
  - Neste notebook (`8 GB RAM / 2 GB VRAM`), rode modelos leves (`qwen2.5:1.5b` ou `llama3.2:1b` no Ollama). Modelos 7B/8B + clonagem neural ao mesmo tempo vão causar swap pesado e lentidão. Para voz clonada rápida, o ideal é um PC com `16 GB+ RAM` e `6–8 GB VRAM` (ou VPS com GPU).

---

## 2. Como Instalar IA Local sem Filtro (`Ollama`)

1. Baixe o instalador oficial do Windows em https://ollama.com/download.
2. Abra o PowerShell e baixe um modelo leve (ou sem censura em máquinas maiores):
   ```powershell
   ollama pull qwen2.5:1.5b
   ```
3. No painel `/admin` → aba **X1 Híbrido, Voz & Jev**:
   - Clique no preset **Ollama Local** (preenche `http://localhost:11434/v1`).
   - Ajuste o nome do modelo para `qwen2.5:1.5b` e deixe a chave vazia.

---

## 3. Como Instalar Clonagem de Voz + Transcrição (`jamiepine/voicebox`)

O projeto open-source [jamiepine/voicebox](https://github.com/jamiepine/voicebox) substitui ElevenLabs e WisprFlow com API local na porta **`17493`**:

1. Instale o **Voicebox** (desktop Windows via Releases do GitHub ou backend Python FastAPI do repositório).
2. Abra o Voicebox e crie um perfil de voz subindo **10 a 20 segundos** de áudio limpo da voz dela (sem música de fundo).
3. Anote o **Profile ID** criado no Voicebox (ex.: `voz_loja`).
4. No painel `/admin` → aba **X1 Híbrido, Voz & Jev**:
   - Em **Provedor STT**: deixe `Voicebox Local (http://127.0.0.1:17493/transcribe)`.
   - Em **Provedor TTS**: escolha `Voicebox Voz Clonada Local (:17493)` e coloque o **Profile ID** no campo `Voz / Profile ID`.
   - Clique em **Testar Voz Agora** para ouvir direto no navegador antes de ligar nos clientes!

---

## 4. Rede de Segurança (Fallback Automático)
Mesmo se você escolher Voicebox, AllTalk ou ElevenLabs e o serviço fechar ou cair no meio do atendimento, o `Shopee Affiliate Hub` **nunca deixa o cliente sem resposta**: ele registra o aviso na aba **Logs** e envia automaticamente a resposta em texto com o link oficial.
