import { ProductOfferNode } from './shopeeAffiliateClient.js';

export interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  geminiBaseUrl: string;
  openaiBaseUrl: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

function formatBrlPrice(raw: string): string {
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) return raw || 'Oferta ativa';
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

export class AiService {
  private async generateText(
    config: AiConfig,
    systemPrompt: string,
    turns: ChatTurn[],
    maxTokens = 320
  ): Promise<string> {
    if (!config.apiKey.trim()) {
      throw new Error('AI API key is not configured.');
    }

    if (config.provider === 'openai') {
      const base = config.openaiBaseUrl.replace(/\/+$/, '');
      const model = config.model.trim() || 'gpt-4o-mini';
      const messages = [
        { role: 'system', content: systemPrompt },
        ...turns.map((t) => ({ role: t.role, content: t.content }))
      ];

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey.trim()}`
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.6
        }),
        signal: AbortSignal.timeout(15000)
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 220)}`);
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const out = parsed.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error('OpenAI returned empty content.');
      return out;
    }

    const base = config.geminiBaseUrl.replace(/\/+$/, '');
    const model = config.model.trim() || 'gemini-2.5-flash';
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey.trim())}`;

    const contents = turns.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }]
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.6
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 220)}`);
    }

    const parsed = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const out = parsed.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('')
      .trim();
    if (!out) {
      throw new Error('Gemini returned empty content.');
    }
    return out;
  }

  buildDeterministicOfferCaption(offer: ProductOfferNode, shortLink: string): string {
    const priceLabel = formatBrlPrice(offer.price || offer.priceMin);
    const title = offer.productName.trim().slice(0, 95);
    return [
      `ACHADINHO SHOPEE`,
      `${title}`,
      `Valor hoje: ${priceLabel}`,
      `Garanta no link oficial: ${shortLink}`
    ].join('\n\n');
  }

  async generateAchadinhoCopy(
    config: AiConfig,
    offer: ProductOfferNode,
    shortLink: string
  ): Promise<string> {
    if (!config.apiKey.trim()) {
      return this.buildDeterministicOfferCaption(offer, shortLink);
    }

    const priceLabel = formatBrlPrice(offer.price || offer.priceMin);
    const systemPrompt =
      'Voce escreve chamadas curtas em portugues do Brasil para grupo de ofertas da Shopee no WhatsApp. Seja direto, natural, sem exageros falsos e inclua exatamente o link fornecido.';
    const prompt = [
      `Produto: ${offer.productName}`,
      `Preco: ${priceLabel}`,
      `Link oficial (incluir exatamente assim): ${shortLink}`,
      'Escreva no maximo 4 linhas curtas com quebra de linha para WhatsApp.'
    ].join('\n');

    try {
      const text = await this.generateText(
        config,
        systemPrompt,
        [{ role: 'user', content: prompt }],
        180
      );
      return text.includes(shortLink) ? text : `${text}\n\n${shortLink}`;
    } catch {
      return this.buildDeterministicOfferCaption(offer, shortLink);
    }
  }

  async generateX1Reply(
    config: AiConfig,
    params: {
      systemPrompt: string;
      history: ChatTurn[];
      userMessage: string;
    }
  ): Promise<string> {
    const trimmedPrompt =
      params.systemPrompt.trim() ||
      'Voce e uma assistente de vendas de achadinhos da Shopee no WhatsApp. Responda em portugues do Brasil de forma objetiva, educada e curta (maximo 3 frases) convidando o cliente a clicar em um dos botoes abaixo.';

    if (!config.apiKey.trim()) {
      return 'Oi! Posso te mandar o link direto com desconto agora mesmo. Toque em uma das opcoes abaixo para ver na hora:';
    }

    const turns: ChatTurn[] = [
      ...params.history.slice(-8),
      { role: 'user', content: params.userMessage }
    ];

    try {
      const reply = await this.generateText(config, trimmedPrompt, turns, 240);
      return reply.slice(0, 800);
    } catch {
      return 'Recebi sua mensagem! Escolha uma das opcoes abaixo para acessar os links direto da Shopee:';
    }
  }
}
