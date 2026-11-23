import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHubApp } from '../src/app.js';
import { loadEnvConfig } from '../src/config/env.js';
import {
  buildShopeeAuthHeader,
  computeShopeeSignature,
  extractClickIdFromUtmContent,
  sanitizeSubId
} from '../src/services/shopeeAffiliateClient.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  bodyJson: unknown;
}

async function startMockUpstream(): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  setShopeeSecret: (appId: string, secret: string) => void;
  setLastClickIdForReport: (clickId: string) => void;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  let expectedAppId = '99887766';
  let expectedSecret = 'shopee-secret-123';
  let reportClickId = '';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let bodyJson: unknown = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }

      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        bodyText,
        bodyJson
      });

      res.setHeader('Content-Type', 'application/json');

      // 1. Shopee Affiliate GraphQL Mock with strict SHA-256 verification
      if (req.url === '/shopee/graphql') {
        const auth = String(req.headers.authorization || '');
        const match =
          /^SHA256 Credential=([^,]+),Timestamp=(\d+),Signature=([a-f0-9]{64})$/i.exec(
            auth
          );
        if (!match) {
          res.statusCode = 401;
          res.end(JSON.stringify({ errors: [{ message: 'Missing SHA256 header' }] }));
          return;
        }
        const [, cred, tsRaw, sig] = match;
        const expectedSig = computeShopeeSignature(
          expectedAppId,
          Number(tsRaw),
          bodyText,
          expectedSecret
        );
        if (cred !== expectedAppId || sig !== expectedSig) {
          res.statusCode = 401;
          res.end(JSON.stringify({ errors: [{ message: 'Invalid signature' }] }));
          return;
        }

        const query = String((bodyJson as { query?: string })?.query || '');
        if (query.includes('generateShortLink')) {
          res.end(
            JSON.stringify({
              data: {
                generateShortLink: {
                  shortLink: 'https://shope.ee/mockShort123'
                }
              }
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
                      conversionId: 'conv_9001',
                      purchaseTime: Math.floor(Date.now() / 1000) - 60,
                      clickTime: Math.floor(Date.now() / 1000) - 180,
                      totalCommission: '14.50',
                      utmContent: `${reportClickId}-foneoferta---`,
                      orders: [
                        {
                          orderId: 'ORD_BR_778899',
                          orderStatus: 'PENDING',
                          items: [
                            {
                              itemId: 'item_55',
                              itemName: 'Fone Bluetooth Pro',
                              itemPrice: '129.90',
                              qty: 1,
                              itemTotalCommission: '14.50'
                            }
                          ]
                        }
                      ]
                    }
                  ],
                  pageInfo: {
                    limit: 50,
                    hasNextPage: false,
                    scrollId: null
                  }
                }
              }
            })
          );
          return;
        }

        res.end(JSON.stringify({ data: { productOfferV2: { nodes: [] } } }));
        return;
      }

      // 2. Meta CAPI Mock
      if (req.url?.includes('/events')) {
        res.end(
          JSON.stringify({
            events_received: 1,
            fbtrace_id: 'mock_fbtrace_123'
          })
        );
        return;
      }

      // 3. Meta WhatsApp Cloud API Mock
      if (req.url?.includes('/messages')) {
        res.end(
          JSON.stringify({
            messaging_product: 'whatsapp',
            messages: [{ id: 'wamid.mock.out.1' }]
          })
        );
        return;
      }

      // 4. Gemini Mock
      if (req.url?.includes(':generateContent')) {
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'Oi! Esse fone esta com otimo preco hoje. Toque em um botao abaixo para abrir a oferta:'
                    }
                  ]
                }
              }
            ]
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found in mock' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    requests,
    setShopeeSecret: (appId: string, secret: string) => {
      expectedAppId = appId;
      expectedSecret = secret;
    },
    setLastClickIdForReport: (clickId: string) => {
      reportClickId = clickId;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

test('Shopee SHA-256 signature and subId helpers behave deterministically', () => {
  const payload = JSON.stringify({ query: '{ productOfferV2 { nodes { itemId } } }' });
  const ts = 1763930000;
  const header = buildShopeeAuthHeader('12345', 'mysecret', payload, ts);
  const expectedSig = crypto
    .createHash('sha256')
    .update(`12345${ts}${payload}mysecret`, 'utf8')
    .digest('hex');

  assert.equal(
    header,
    `SHA256 Credential=12345,Timestamp=${ts},Signature=${expectedSig}`
  );
  assert.equal(sanitizeSubId('fone-bluetooth_oferta!'), 'fonebluetoothoferta');
  assert.equal(
    extractClickIdFromUtmContent('clk0123456789abcdef-foneoferta---'),
    'clk0123456789abcdef'
  );
});

test('End-to-end hub flow: Auth, /go/:slug tracker -> Shopee -> Meta CAPI deduplication, and WhatsApp X1 webhook', async () => {
  const mock = await startMockUpstream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopee-hub-test-'));

  const config = loadEnvConfig({
    port: 0,
    adminPassword: 'super-secret-password',
    dataDir: tempDir,
    publicBaseUrl: 'http://127.0.0.1:3000',
    metaGraphBaseUrl: `${mock.baseUrl}/meta`,
    geminiBaseUrl: `${mock.baseUrl}/gemini`,
    baileysDelayMinMs: 0,
    baileysDelayMaxMs: 0
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
    // 1. Auth gate check: unauthenticated /api/admin/settings must return 401
    const unauthRes = await fetch(`${appBaseUrl}/api/admin/settings`);
    assert.equal(unauthRes.status, 401);

    const badLoginRes = await fetch(`${appBaseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.equal(badLoginRes.status, 401);

    const loginRes = await fetch(`${appBaseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'super-secret-password' })
    });
    assert.equal(loginRes.status, 200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    assert(setCookieHeader, 'Expected HttpOnly session cookie');
    const sessionCookie = setCookieHeader.split(';')[0]!;

    // 2. Configure credentials via /api/admin/settings (including a >20 char button title to test truncation guard)
    const buttonsPayload = [
      {
        id: 'btn_1',
        title: 'Ver Oferta Relampago Agora Mesmo',
        replyText: 'Aqui esta o fone em promocao:',
        linkUrl: 'https://shope.ee/fone-promo'
      },
      {
        id: 'btn_2',
        title: 'Grupo VIP',
        replyText: 'Entre no grupo:',
        linkUrl: 'https://chat.whatsapp.com/mock'
      }
    ];

    const putSettingsRes = await fetch(`${appBaseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie
      },
      body: JSON.stringify({
        meta_pixel_id: '1707241907778178',
        meta_capi_token: 'EAAMOCKCAPITOKEN',
        shopee_app_id: '99887766',
        shopee_secret: 'shopee-secret-123',
        shopee_graphql_url: `${mock.baseUrl}/shopee/graphql`,
        meta_whatsapp_token: 'EAAMOCKWATOKEN',
        meta_phone_number_id: '551199999999',
        meta_webhook_verify_token: 'verify-xyz',
        ai_provider: 'gemini',
        ai_api_key: 'gemini-mock-key',
        x1_buttons_json: JSON.stringify(buttonsPayload)
      })
    });
    assert.equal(putSettingsRes.status, 200);
    const savedSettingsBody = (await putSettingsRes.json()) as {
      buttons: Array<{ title: string }>;
    };
    assert(
      savedSettingsBody.buttons[0]!.title.length <= 20,
      'Button title must be capped at 20 characters for Meta WhatsApp Cloud API'
    );

    // 3. Create campaign link and hit /go/:slug with fbclid
    const createCampRes = await fetch(`${appBaseUrl}/api/admin/campaigns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie
      },
      body: JSON.stringify({
        slug: 'fone-oferta',
        title: 'Fone Bluetooth Campanha',
        destinationUrl: 'https://shopee.com.br/product-i.100.200',
        defaultValue: 129.9
      })
    });
    assert.equal(createCampRes.status, 200);

    const goRes = await fetch(
      `${appBaseUrl}/go/fone-oferta?fbclid=IwAR999TestClick`,
      {
        redirect: 'manual',
        headers: {
          Cookie: '_fbp=fb.1.1700000000.123456',
          'User-Agent': 'PlaywrightTestAgent/1.0'
        }
      }
    );
    assert.equal(goRes.status, 302);
    assert.equal(goRes.headers.get('location'), 'https://shope.ee/mockShort123');

    // Verify subIds sent to Shopee GraphQL are alphanumeric and include clickId
    const shortLinkReq = mock.requests.find(
      (r) =>
        r.url === '/shopee/graphql' &&
        String((r.bodyJson as { query?: string })?.query).includes('generateShortLink')
    );
    assert(shortLinkReq, 'Expected generateShortLink request to Shopee');
    const shortLinkQuery = String(
      (shortLinkReq.bodyJson as { query?: string }).query
    );
    const clkMatch = /clk[a-f0-9]{16}/.exec(shortLinkQuery);
    assert(clkMatch, 'Expected alphanumeric clickId inside generateShortLink subIds');
    const clickId = clkMatch[0];
    mock.setLastClickIdForReport(clickId);

    const storedClick = hub.db.getAdClick(clickId);
    assert(storedClick);
    assert.match(storedClick.fbc || '', /^fb\.1\.\d+\.IwAR999TestClick$/);
    assert.equal(storedClick.fbp, 'fb.1.1700000000.123456');

    // 4. Sync conversions: first run sends Purchase with event_id=ORD_BR_778899 + fbc; second run deduplicates
    const sync1Res = await fetch(`${appBaseUrl}/api/admin/sync-conversions`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    assert.equal(sync1Res.status, 200);
    const sync1Json = (await sync1Res.json()) as {
      summary: { sentToMeta: number; matchedClicks: number; skippedDuplicate: number };
    };
    assert.equal(sync1Json.summary.matchedClicks, 1);
    assert.equal(sync1Json.summary.sentToMeta, 1);

    const capiReqsAfterFirst = mock.requests.filter((r) =>
      r.url.includes('/events')
    );
    assert.equal(capiReqsAfterFirst.length, 1);
    const capiBody = capiReqsAfterFirst[0]!.bodyJson as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: { fbc?: string; fbp?: string };
        custom_data: { value: number; order_id: string; currency: string };
      }>;
    };
    assert.equal(capiBody.data[0]!.event_name, 'Purchase');
    assert.equal(capiBody.data[0]!.event_id, 'ORD_BR_778899');
    assert.equal(capiBody.data[0]!.user_data.fbc, storedClick.fbc);
    assert.equal(capiBody.data[0]!.custom_data.value, 129.9);
    assert.equal(capiBody.data[0]!.custom_data.currency, 'BRL');

    const sync2Res = await fetch(`${appBaseUrl}/api/admin/sync-conversions`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    const sync2Json = (await sync2Res.json()) as {
      summary: { sentToMeta: number; skippedDuplicate: number };
    };
    assert.equal(sync2Json.summary.sentToMeta, 0);
    assert.equal(sync2Json.summary.skippedDuplicate, 1);
    assert.equal(
      mock.requests.filter((r) => r.url.includes('/events')).length,
      1,
      'Duplicate order_id must NOT fire CAPI twice'
    );

    // 5. WhatsApp Cloud API Webhook verification + text reply + button click + deduplication
    const badVerify = await fetch(
      `${appBaseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`
    );
    assert.equal(badVerify.status, 403);

    const okVerify = await fetch(
      `${appBaseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-xyz&hub.challenge=CHALLENGE_OK`
    );
    assert.equal(okVerify.status, 200);
    assert.equal(await okVerify.text(), 'CHALLENGE_OK');

    const incomingTextPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.in.100',
                    from: '5511988887777',
                    type: 'text',
                    text: { body: 'Oi, quero ver o link do fone!' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const hookTextRes = await fetch(`${appBaseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incomingTextPayload)
    });
    assert.equal(hookTextRes.status, 200);
    const hookTextJson = (await hookTextRes.json()) as {
      summary: { processed: number; repliesSent: number };
    };
    assert.equal(hookTextJson.summary.processed, 1);
    assert.equal(hookTextJson.summary.repliesSent, 1);

    // Duplicate delivery of same message id must be ignored
    const hookDupRes = await fetch(`${appBaseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incomingTextPayload)
    });
    const hookDupJson = (await hookDupRes.json()) as {
      summary: { processed: number; ignoredDuplicate: number };
    };
    assert.equal(hookDupJson.summary.processed, 0);
    assert.equal(hookDupJson.summary.ignoredDuplicate, 1);

    // Button click payload
    const hookClickRes = await fetch(`${appBaseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.in.101',
                      from: '5511988887777',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: 'btn_1', title: 'Ver Oferta' }
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      })
    });
    assert.equal(hookClickRes.status, 200);

    const waRequests = mock.requests.filter((r) => r.url.includes('/messages'));
    assert.equal(waRequests.length, 2);

    const firstWaMsg = waRequests[0]!.bodyJson as {
      interactive: {
        type: string;
        action: { buttons: Array<{ reply: { title: string } }> };
      };
    };
    assert.equal(firstWaMsg.interactive.type, 'button');
    for (const b of firstWaMsg.interactive.action.buttons) {
      assert(b.reply.title.length <= 20);
    }

    const secondWaMsg = waRequests[1]!.bodyJson as {
      interactive: {
        type: string;
        action: { parameters: { url: string } };
      };
    };
    assert.equal(secondWaMsg.interactive.type, 'cta_url');
    assert.equal(
      secondWaMsg.interactive.action.parameters.url,
      'https://shope.ee/fone-promo'
    );
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
