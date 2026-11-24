import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppConfig } from '../config/env.js';
import { HubDatabase, HubSettings } from '../db/database.js';

const execFileAsync = promisify(execFile);

export class VoiceService {
  private readonly voicesDir: string;

  constructor(
    private readonly db: HubDatabase,
    private readonly config: AppConfig
  ) {
    this.voicesDir = path.join(config.dataDir, 'voices');
    fs.mkdirSync(this.voicesDir, { recursive: true });
  }

  saveReferenceWav(base64Content: string, originalName: string): { filename: string; sizeBytes: number } {
    const stripped = base64Content.replace(/^data:[^;]+;base64,/, '').trim();
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length < 64 || buf.length > 12 * 1024 * 1024) {
      throw new Error('Arquivo de voz invalido (use WAV entre 64B e 12MB).');
    }
    const baseName = path
      .basename(originalName || 'voz_modelo.wav')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = baseName.toLowerCase().endsWith('.wav')
      ? baseName
      : `${baseName}.wav`;
    const targetPath = path.join(this.voicesDir, finalName);
    fs.writeFileSync(targetPath, buf);
    this.db.updateSettings({ tts_reference_wav: finalName });
    this.db.addLog('info', 'voice', `Amostra de voz salva: ${finalName}`);
    return { filename: finalName, sizeBytes: buf.length };
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    settings: HubSettings
  ): Promise<string> {
    if (!audioBuffer.length) {
      throw new Error('Audio recebido esta vazio.');
    }

    const provider = settings.stt_provider || 'voicebox_local';
    if (provider === 'gemini') {
      const apiKey = settings.stt_api_key.trim() || settings.ai_api_key.trim();
      if (!apiKey) {
        throw new Error('Chave Gemini para transcricao nao configurada.');
      }
      const model = settings.ai_model.trim() || 'gemini-2.5-flash';
      const base = this.config.geminiBaseUrl.replace(/\/+$/, '');
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: 'Transcreva exatamente em portugues do Brasil o que o cliente disse neste audio, sem comentarios extras.'
                },
                {
                  inlineData: {
                    mimeType: mimeType || 'audio/ogg',
                    data: audioBuffer.toString('base64')
                  }
                }
              ]
            }
          ]
        }),
        signal: AbortSignal.timeout(20000)
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Gemini STT HTTP ${res.status}: ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(raw) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const out = parsed.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join('')
        .trim();
      if (!out) throw new Error('Gemini STT retornou transcricao vazia.');
      return out;
    }

    const baseUrl = (settings.stt_base_url || 'http://127.0.0.1:17493').replace(
      /\/+$/,
      ''
    );
    const form = new FormData();
    const ext = mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('mp3') || mimeType.includes('mpeg')
      ? 'mp3'
      : 'ogg';
    const blob = new Blob([new Uint8Array(audioBuffer)], {
      type: mimeType || 'audio/ogg'
    });

    if (provider === 'voicebox_local') {
      form.append('audio', blob, `lead_audio.${ext}`);
      form.append('model', settings.stt_model || 'whisper-turbo');
      const res = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20000)
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`Voicebox STT HTTP ${res.status}: ${raw.slice(0, 200)}`);
      }
      const parsed = JSON.parse(raw) as { text?: string };
      return (parsed.text || '').trim();
    }

    // openai_compat (Faster-Whisper / Speaches / Groq / OpenAI)
    form.append('file', blob, `lead_audio.${ext}`);
    form.append('model', settings.stt_model || 'whisper-large-v3-turbo');
    form.append('language', 'pt');
    const headers: Record<string, string> = {};
    if (settings.stt_api_key.trim()) {
      headers.Authorization = `Bearer ${settings.stt_api_key.trim()}`;
    }
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(20000)
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`STT HTTP ${res.status}: ${raw.slice(0, 200)}`);
    }
    const parsed = JSON.parse(raw) as { text?: string };
    return (parsed.text || '').trim();
  }

  async synthesizeToOggOpus(
    text: string,
    settings: HubSettings
  ): Promise<Buffer> {
    const maxChars = Math.min(
      800,
      Math.max(60, Number.parseInt(settings.x1_audio_max_chars || '280', 10) || 280)
    );
    const cleanText = text.replace(/https?:\/\/\S+/g, '').trim().slice(0, maxChars);
    if (!cleanText) {
      throw new Error('Texto vazio para sintese de voz.');
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopee-tts-'));
    try {
      const provider = settings.tts_provider || 'edge_local';
      const rawExt = provider === 'edge_local' || provider === 'elevenlabs' ? 'mp3' : 'wav';
      const rawAudioPath = path.join(tmpDir, `raw.${rawExt}`);
      const oggPath = path.join(tmpDir, 'out.ogg');

      if (provider === 'edge_local') {
        const txtPath = path.join(tmpDir, 'speech.txt');
        fs.writeFileSync(txtPath, cleanText, 'utf8');
        const voice = settings.tts_voice_id.trim() || 'pt-BR-FranciscaNeural';
        await execFileAsync(
          'python',
          [
            '-m',
            'edge_tts',
            '--voice',
            voice,
            '--file',
            txtPath,
            '--write-media',
            rawAudioPath
          ],
          { timeout: 15000 }
        );
      } else if (provider === 'voicebox_local') {
        const base = (settings.tts_base_url || 'http://127.0.0.1:17493').replace(
          /\/+$/,
          ''
        );
        const profile = settings.tts_voice_id.trim() || 'default';
        let res = await fetch(`${base}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: cleanText,
            profile_id: profile,
            language: 'pt'
          }),
          signal: AbortSignal.timeout(25000)
        });
        if (res.status === 404) {
          res = await fetch(`${base}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: cleanText,
              voice: profile,
              response_format: 'wav'
            }),
            signal: AbortSignal.timeout(25000)
          });
        }
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Voicebox TTS HTTP ${res.status}: ${errText.slice(0, 180)}`);
        }
        const arr = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(rawAudioPath, arr);
      } else if (provider === 'alltalk_local') {
        const base = (settings.tts_base_url || 'http://127.0.0.1:7851').replace(
          /\/+$/,
          ''
        );
        const voice =
          settings.tts_reference_wav.trim() ||
          settings.tts_voice_id.trim() ||
          'female_01.wav';
        const res = await fetch(`${base}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: cleanText,
            voice,
            language: 'pt',
            response_format: 'wav'
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`AllTalk TTS HTTP ${res.status}: ${errText.slice(0, 180)}`);
        }
        fs.writeFileSync(rawAudioPath, Buffer.from(await res.arrayBuffer()));
      } else if (provider === 'elevenlabs') {
        const apiKey = settings.tts_api_key.trim();
        const voiceId = settings.tts_voice_id.trim();
        if (!apiKey || !voiceId) {
          throw new Error('ElevenLabs API Key e Voice ID sao obrigatorios.');
        }
        const base = this.config.elevenlabsBaseUrl.replace(/\/+$/, '');
        const res = await fetch(
          `${base}/text-to-speech/${encodeURIComponent(voiceId)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': apiKey
            },
            body: JSON.stringify({
              text: cleanText,
              model_id: 'eleven_multilingual_v2'
            }),
            signal: AbortSignal.timeout(20000)
          }
        );
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 180)}`);
        }
        fs.writeFileSync(rawAudioPath, Buffer.from(await res.arrayBuffer()));
      } else {
        throw new Error(`Provedor TTS desconhecido: ${provider}`);
      }

      // Real OGG/Opus PTT transcode via FFmpeg
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          rawAudioPath,
          '-c:a',
          'libopus',
          '-b:a',
          '32k',
          '-vbr',
          'on',
          '-application',
          'voip',
          '-ac',
          '1',
          '-ar',
          '48000',
          oggPath
        ],
        { timeout: 15000 }
      );

      return fs.readFileSync(oggPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
