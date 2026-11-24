import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHubApp } from '../src/app.js';
import { loadEnvConfig } from '../src/config/env.js';
import { calculateCampaignMetrics } from '../src/services/campaignDashboardService.js';
import { computeShopeeSignature } from '../src/services/shopeeAffiliateClient.js';
import { X1ChannelAdapter } from '../src/services/x1Orchestrator.js';

function createRealSineWavBuffer(): Buffer {
  const tmpWav = path.join(
    os.tmpdir(),
    `test-sine-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
  );
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.35',
      '-ar',
      '16000',
      '-ac',
      '1',
      tmpWav
    ]);
    return fs.readFileSync(tmpWav);
  } finally {
    fs.rmSync(tmpWav, { force: true });
  }
}

async function startV2MockServer(sampleWav: Buffer): Promise<{
  baseUrl: string;
  calls: Array<{ method: string; url: string; body: string }>;
  setTtsFail: (fail: boolean) => void;
  close: () => Promise<void>;
}> {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  let failTts = false;
  let metaCampaignStatus = 'ACTIVE';
  let metaCampaignBudget = '3500';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method || 'GET',
        url: req.url || '/',
        body: bodyStr
      });

      // Meta Marketing API: GET /meta/act_111/campaigns
      if (req.url?.includes('/act_111/campaigns')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'camp_meta_777',
                name: 'Gerenciador Luminaria Solar',
                status: metaCampaignStatus,
                daily_budget: metaCampaignBudget,
                insights: {
                  data: [
                    {
                      spend: '50.00',
                      clicks: '300',
                      inline_link_clicks: '250',
                      cpc: '0.20',
                      ctr: '4.50',
                      impressions: '6666'
                    }
                  ]
                }
              }
            ]
          })
        );
        return;
      }

      // Meta Marketing API: POST /meta/camp_meta_777
      if (req.url === '/meta/camp_meta_777' && req.method === 'POST') {
        const parsed = JSON.parse(bodyStr) as {
          status?: string;
          daily_budget?: number;
        };
        if (parsed.status) metaCampaignStatus = parsed.status;
        if (parsed.daily_budget) metaCampaignBudget = String(parsed.daily_budget);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Shopee GraphQL Mock
      if (req.url === '/shopee/graphql') {
        const auth = String(req.headers.authorization || '');
        const match =
          /^SHA256 Credential=([^,]+),Timestamp=(\d+),Signature=([a-f0-9]{64})$/i.exec(
            auth
          );
        if (!match) {
          res.statusCode = 401;
          res.end(JSON.stringify({ errors: [{ message: 'Missing auth' }] }));
          return;
        }
        const expected = computeShopeeSignature(
          'app123',
          Number(match[2]),
          bodyStr,
          'sec123'
        );
        if (match[3] !== expected) {
          res.statusCode = 401;
          res.end(JSON.stringify({ errors: [{ message: 'Bad sig' }] }));
          return;
        }
        const query = String((JSON.parse(bodyStr) as { query?: string }).query || '');
        res.setHeader('Content-Type', 'application/json');
        if (query.includes('generateShortLink')) {
          res.end(
            JSON.stringify({
              data: { generateShortLink: { shortLink: 'https://shope.ee/camp777' } }
            })
          );
          return;
        }
        if (query.includes('conversionReport')) {
          res.end(
            JSON.stringify({
              data: {
                conversionReport: {
                  nodes: [
                    {
                      conversionId: 'c_1',
                      purchaseTime: Math.floor(Date.now() / 1000),
                      clickTime: Math.floor(Date.now() / 1000) - 60,
                      totalCommission: '150.00',
                      utmContent: 'campmeta777----',
                      orders: [
                        {
                          orderId: 'ORD_ROI_1',
                          orderStatus: 'PENDING',
                          items: [
                            {
                              itemId: 'i_1',
                              itemName: 'Luminaria Solar',
                              itemPrice: '900.00',
                              qty: 1,
                              itemTotalCommission: '150.00'
                            }
                          ]
                        }
                      ]
                    }
                  ],
                  pageInfo: { limit: 50, hasNextPage: false, scrollId: null }
                }
              }
            })
          );
          return;
        }
      }

      // Ollama / OpenAI-compatible LLM Mock (returns a hallucinated URL to test Jev sanitizer)
      if (req.url === '/ollama/v1/chat/completions') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    'A Luminaria Solar IP65 e a prova d agua e custa R$ 39,90. Compre aqui: https://evil-hallucinated.example.com/fake'
                }
              }
            ]
          })
        );
        return;
      }

      // Voicebox Mock: /transcribe and /generate
      if (req.url === '/voicebox/transcribe') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            text: 'Essa luminaria solar e a prova d agua?'
          })
        );
        return;
      }

      if (req.url === '/voicebox/generate') {
        if (failTts) {
          res.statusCode = 500;
          res.end('TTS offline');
          return;
        }
        res.setHeader('Content-Type', 'audio/wav');
        res.end(sampleWav);
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    setTtsFail: (f: boolean) => {
      failTts = f;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test('Litmus: ROI math prevents NaN/Infinity on zero spend', () => {
  const zeroSpend = calculateCampaignMetrics({
    id: 'c0',
    name: 'Campanha Sem Gasto',
    status: 'PAUSED',
    dailyBudget: 20,
    spend: 0,
    sales: 0,
    totalOrderValue: 0,
    commission: 0,
    clicks: 0,
    linkClicks: 0,
    impressions: 0
  });
  assert.equal(zeroSpend.profit, 0);
  assert.equal(zeroSpend.roas, 0);
  assert.equal(zeroSpend.cpc, 0);
  assert.equal(zeroSpend.ctr, 0);
  assert.ok(!Number.isNaN(zeroSpend.roas));
  assert.ok(Number.isFinite(zeroSpend.roas));
});

test('V2 E2E: No-Pixel ROI Dash, Hybrid Voice OGG/Opus + Fallback, Human Takeover, Anti-Ban, and RAG+Jev', async () => {
  const sampleWav = createRealSineWavBuffer();
  const mock = await startV2MockServer(sampleWav);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopee-v2-test-'));

  const config = loadEnvConfig({
    port: 0,
    adminPassword: 'v2-password',
    dataDir: tempDir,
    metaGraphBaseUrl: `${mock.baseUrl}/meta`,
    baileysDelayMinMs: 0,
    baileysDelayMaxMs: 0,
    antibanReadDelayMs: 0,
    antibanMinDelayMs: 0,
    antibanMaxDelayMs: 0
  });

  const hub = createHubApp(config, {
    startCrons: false,
    autoConnectBaileys: false
  });
  const server = http.createServer(hub.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const appBaseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Login
    const loginRes = await fetch(`${appBaseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'v2-password' })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

    // 1. Configure No-Pixel Meta Ads + Shopee + Local Ollama + Voicebox STT/TTS
    const putRes = await fetch(`${appBaseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        meta_ad_account_id: '111',
        meta_marketing_token: 'EAAMARKETING',
        campaigns_demo_mode: 'false',
        shopee_app_id: 'app123',
        shopee_secret: 'sec123',
        shopee_graphql_url: `${mock.baseUrl}/shopee/graphql`,
        x1_enabled: 'true',
        x1_channel: 'baileys',
        ai_provider: 'openai_compat',
        ai_base_url: `${mock.baseUrl}/ollama/v1`,
        ai_api_key: '',
        ai_model: 'qwen2.5:3b',
        stt_provider: 'voicebox_local',
        stt_base_url: `${mock.baseUrl}/voicebox`,
        tts_provider: 'voicebox_local',
        tts_base_url: `${mock.baseUrl}/voicebox`,
        tts_voice_id: 'voz_loja',
        x1_audio_reply_mode: 'hybrid',
        antiban_debounce_sec: '0'
      })
    });
    assert.equal(putRes.status, 200);

    // Link campaign ID to Shopee sub_id and verify ROI dashboard cross-reference
    const linkRes = await fetch(`${appBaseUrl}/api/admin/roi-campaigns/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        campaignId: 'camp_meta_777',
        campaignName: 'Gerenciador Luminaria Solar',
        productUrl: 'https://shopee.com.br/luminaria-i.1.2'
      })
    });
    assert.equal(linkRes.status, 200);

    const roiRes = await fetch(`${appBaseUrl}/api/admin/roi-campaigns?datePreset=today`, {
      headers: { Cookie: cookie }
    });
    assert.equal(roiRes.status, 200);
    const roiJson = (await roiRes.json()) as {
      isDemo: boolean;
      summary: { investment: number; totalCommission: number; profit: number; roas: number };
      campaigns: Array<{ id: string; status: string; dailyBudget: number; profit: number; roas: number }>;
    };
    assert.equal(roiJson.isDemo, false);
    assert.equal(roiJson.summary.investment, 50);
    assert.equal(roiJson.summary.totalCommission, 150);
    assert.equal(roiJson.summary.profit, 100);
    assert.equal(roiJson.summary.roas, 3);

    // Toggle status PAUSED and update budget to R$ 75.00 on Meta API
    await fetch(`${appBaseUrl}/api/admin/roi-campaigns/camp_meta_777/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'PAUSED' })
    });
    await fetch(`${appBaseUrl}/api/admin/roi-campaigns/camp_meta_777/budget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ dailyBudget: 75 })
    });
    const roiAfter = (await (
      await fetch(`${appBaseUrl}/api/admin/roi-campaigns?datePreset=today`, {
        headers: { Cookie: cookie }
      })
    ).json()) as typeof roiJson;
    assert.equal(roiAfter.campaigns[0]!.status, 'PAUSED');
    assert.equal(roiAfter.campaigns[0]!.dailyBudget, 75);

    // 2. Test WAV upload & Real FFmpeg OGG/Opus voice test endpoint
    const uploadRes = await fetch(`${appBaseUrl}/api/admin/voice/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        filename: 'minha_voz.wav',
        base64: `data:audio/wav;base64,${sampleWav.toString('base64')}`
      })
    });
    assert.equal(uploadRes.status, 200);

    const voiceTestRes = await fetch(`${appBaseUrl}/api/admin/voice/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'Oi, tudo bem? Quer o link da luminaria?' })
    });
    assert.equal(voiceTestRes.status, 200);
    const voiceTestJson = (await voiceTestRes.json()) as { audioDataUrl: string };
    const oggBuf = Buffer.from(
      voiceTestJson.audioDataUrl.replace('data:audio/ogg;base64,', ''),
      'base64'
    );
    assert.equal(oggBuf.subarray(0, 4).toString('ascii'), 'OggS');
    assert.ok(oggBuf.includes(Buffer.from('OpusHead')), 'Must be genuine libopus OGG');

    // 3. Add Catalog Item for RAG + Jev
    const catRes = await fetch(`${appBaseUrl}/api/admin/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        title: 'Luminaria Solar IP65',
        keywords: 'luminaria,solar,parede,prova,agua,externa',
        priceLabel: 'R$ 39,90',
        affiliateUrl: 'https://shope.ee/luminaria-oficial',
        specsFaq: 'A prova d agua IP65, carrega no sol, sensor de presenca.'
      })
    });
    assert.equal(catRes.status, 200);

    // 4. Test Hybrid X1 + Debounce (3 rapid messages -> 1 AI call) + Jev URL Sanitizer + OGG PTT
    const sentTexts: string[] = [];
    const sentAudios: Buffer[] = [];
    let msgCounter = 1;
    const mockAdapter: X1ChannelAdapter = {
      channelName: 'baileys',
      sendText: async (_jid, text) => {
        sentTexts.push(text);
        return `bot_msg_${msgCounter++}`;
      },
      sendAudio: async (_jid, buf) => {
        sentAudios.push(buf);
        return `bot_aud_${msgCounter++}`;
      }
    };

    const leadJid = '5511999990001@s.whatsapp.net';
    await hub.x1.handleInboundQueued(
      { jid: leadJid, messageId: 'in_1', text: 'Oi', debounceMsOverride: 40 },
      mockAdapter
    );
    await hub.x1.handleInboundQueued(
      {
        jid: leadJid,
        messageId: 'in_2',
        text: 'Quero saber da luminaria solar',
        debounceMsOverride: 40
      },
      mockAdapter
    );
    await hub.x1.handleInboundQueued(
      {
        jid: leadJid,
        messageId: 'in_3',
        audioBuffer: sampleWav,
        audioMime: 'audio/wav',
        debounceMsOverride: 40
      },
      mockAdapter
    );

    await new Promise((r) => setTimeout(r, 250));
    const ollamaCalls = mock.calls.filter((c) => c.url === '/ollama/v1/chat/completions');
    assert.equal(ollamaCalls.length, 1, '3 rapid messages must merge into 1 AI turn');
    assert.equal(sentAudios.length, 1, 'Hybrid mode sends OGG/Opus voice note');
    assert.equal(sentAudios[0]!.subarray(0, 4).toString('ascii'), 'OggS');
    assert.equal(sentTexts.length, 1, 'Hybrid mode follows up with link text');
    assert.ok(
      sentTexts[0]!.includes('https://shope.ee/luminaria-oficial'),
      'Jev must keep verified official link'
    );

    // Test TTS Failure Fallback (when Voicebox is down, must still send text without crashing)
    mock.setTtsFail(true);
    const outFallback = await hub.x1.processResolvedTurn(
      leadJid,
      'Qual o preco da luminaria solar?',
      true,
      mockAdapter
    );
    assert.equal(outFallback.usedAudio, false);
    assert.ok(!outFallback.replyText.includes('evil-hallucinated.example.com'));
    mock.setTtsFail(false);

    // Test Jev Low-Confidence Human Checkpoint (off-catalog product)
    const checkpointTurn = await hub.x1.processResolvedTurn(
      leadJid,
      'Voces vendem geladeira frost free 400 litros?',
      false,
      mockAdapter
    );
    assert.equal(checkpointTurn.humanCheckpoint, true);
    assert.equal(
      mock.calls.filter((c) => c.url === '/ollama/v1/chat/completions').length,
      2,
      'Jev low-confidence checkpoint must NOT call LLM'
    );

    // Resume contact from paused checkpoint
    await fetch(
      `${appBaseUrl}/api/admin/contacts/${encodeURIComponent(leadJid)}/resume`,
      { method: 'POST', headers: { Cookie: cookie } }
    );

    // 5. Litmus: Human Takeover (bot's own fromMe is ignored, external fromMe pauses IA)
    assert.equal(
      hub.x1.handleFromMeCheck(leadJid, 'bot_aud_1'),
      false,
      'Bot own audio message must NOT trigger takeover'
    );
    const botOwnPaused = hub.x1.handleFromMeCheck(leadJid, 'bot_msg_2');
    assert.equal(botOwnPaused, false, 'Bot own text message must NOT trigger takeover');
    const humanPaused = hub.x1.handleFromMeCheck(leadJid, 'owner_phone_msg_99');
    assert.equal(humanPaused, true, 'External fromMe must trigger takeover');
    assert.equal(hub.antiBan.checkCanSend('x1', leadJid).allowed, false);

    // 6. Anti-Ban Opt-Out Blacklist
    const lead2 = '5511999990002@s.whatsapp.net';
    const optOut = await hub.x1.handleInboundQueued(
      { jid: lead2, messageId: 'in_opt', text: 'parar' },
      mockAdapter
    );
    assert.equal(optOut.reason, 'opt_out_blacklisted');
    assert.equal(hub.db.isBlacklisted(lead2), true);

    // 7. Anti-Ban Circuit Breaker (3 consecutive send errors trip breaker)
    const lead3 = '5511999990003@s.whatsapp.net';
    hub.db.touchInboundContact(lead3);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() =>
        hub.antiBan.enqueueSend('x1', lead3, `fail-${i}`, async () => {
          throw new Error('Socket disconnected');
        })
      );
    }
    assert.equal(hub.antiBan.getStatus().circuitOpen, true);
    assert.equal(hub.antiBan.checkCanSend('x1', lead3).allowed, false);

    await fetch(`${appBaseUrl}/api/admin/antiban/reset-breaker`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
    assert.equal(hub.antiBan.getStatus().circuitOpen, false);

    // 8. IVAR Reality Gate Regression Fixes:
    // 8a. Composite greeting "Oi, tudo bem?" must NOT trigger false Jev pause
    const greetingTurn = await hub.x1.processResolvedTurn(
      lead3,
      'Oi, tudo bem?',
      false,
      mockAdapter
    );
    assert.equal(greetingTurn.humanCheckpoint, false);

    // 8b. Paused contact short-circuits BEFORE STT transcription
    hub.db.pauseContact(lead3, 30, 'Humano assumiu');
    const sttCallsBefore = mock.calls.filter(
      (c) => c.url === '/voicebox/transcribe'
    ).length;
    const pausedAudioResult = await hub.x1.handleInboundQueued(
      {
        jid: lead3,
        messageId: 'in_paused_aud',
        audioBuffer: sampleWav,
        audioMime: 'audio/wav',
        debounceMsOverride: 0
      },
      mockAdapter
    );
    assert.equal(pausedAudioResult.queued, false);
    assert.equal(pausedAudioResult.reason, 'contact_paused');
    assert.equal(
      mock.calls.filter((c) => c.url === '/voicebox/transcribe').length,
      sttCallsBefore,
      'Paused contact must NOT burn STT calls'
    );

    // 8c. Webhook HMAC X-Hub-Signature-256 verification when meta_app_secret is set
    await fetch(`${appBaseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ meta_app_secret: 'my-meta-app-secret' })
    });
    const hookRawBody = JSON.stringify({ entry: [] });
    const badHookRes = await fetch(`${appBaseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64)
      },
      body: hookRawBody
    });
    assert.equal(badHookRes.status, 401);

    const validSig =
      'sha256=' +
      crypto
        .createHmac('sha256', 'my-meta-app-secret')
        .update(hookRawBody, 'utf8')
        .digest('hex');
    const okHookRes = await fetch(`${appBaseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': validSig
      },
      body: hookRawBody
    });
    assert.equal(okHookRes.status, 200);

    // 8d. Session endpoint must NOT disclose default password, and brute-force login hits 429
    const sessJson = (await (
      await fetch(`${appBaseUrl}/api/admin/session`)
    ).json()) as Record<string, unknown>;
    assert.equal('usingDefaultPassword' in sessJson, false);

    for (let i = 0; i < 6; i++) {
      const failLogin = await fetch(`${appBaseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'bad' })
      });
      assert.equal(failLogin.status, 401);
    }
    const throttledLogin = await fetch(`${appBaseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'bad' })
    });
    assert.equal(throttledLogin.status, 429);
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
