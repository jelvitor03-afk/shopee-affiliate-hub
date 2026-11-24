import { ProductOfferNode } from './shopeeAffiliateClient.js';

export interface AiConfig {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
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
    maxTokensOverride?: number
  ): Promise<string> {
    const provider = (config.provider || 'gemini').toLowerCase();
    const maxTokens = maxTokensOverride ?? config.maxTokens ?? 320;
    const temperature =
      typeof config.temperature === 'number' && Number.isFinite(config.temperature)
        ? Math.min(1.5, Math.max(0, config.temperature))
        : 0.6;

    if (provider === 'openai' || provider === 'openai_compat') {
      const base = (
        provider === 'openai_compat' && config.baseUrl?.trim()
          ? config.baseUrl.trim()
          : config.openaiBaseUrl
      ).replace(/\/+$/, '');
      const model = config.model.trim() || 'gpt-4o-mini';

      if (provider === 'openai' && !config.apiKey.trim()) {
        throw new Error('OpenAI API key is not configured.');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (config.apiKey.trim()) {
        headers.Authorization = `Bearer ${config.apiKey.trim()}`;
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        ...turns.map((t) => ({ role: t.role, content: t.content }))
      ];

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature
        }),
        signal: AbortSignal.timeout(25000)
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI-compat HTTP ${res.status}: ${text.slice(0, 220)}`);
      }
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const out = parsed.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error('LLM returned empty content.');
      return out;
    }

    if (!config.apiKey.trim()) {
      throw new Error('Gemini API key is not configured.');
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
          temperature
        }
      }),
      signal: AbortSignal.timeout(20000)
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
      'ACHADINHO SHOPEE',
      title,
      `Valor hoje: ${priceLabel}`,
      `Garanta no link oficial: ${shortLink}`
    ].join('\n\n');
  }

  async generateAchadinhoCopy(
    config: AiConfig,
    offer: ProductOfferNode,
    shortLink: string
  ): Promise<string> {
    if (config.provider !== 'openai_compat' && !config.apiKey.trim()) {
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
      catalogContext?: string;
      history: ChatTurn[];
      userMessage: string;
    }
  ): Promise<string> {
    const basePrompt =
      params.systemPrompt.trim() ||
      'Voce e uma assistente de vendas de achadinhos da Shopee no WhatsApp. Responda em portugues do Brasil de forma objetiva, educada e curta (maximo 3 frases).';

    const fullSystemPrompt = params.catalogContext?.trim()
      ? `${basePrompt}\n\n[DADOS VERIFICADOS DO CATALOGO - NAO INVENTE PRECOS OU LINKS FORA DISSO]\n${params.catalogContext.trim()}`
      : basePrompt;

    if (config.provider !== 'openai_compat' && !config.apiKey.trim()) {
      return 'Oi! Posso te mandar o link direto com desconto agora mesmo. Confira as opcoes abaixo:';
    }

    const turns: ChatTurn[] = [
      ...params.history.slice(-8),
      { role: 'user', content: params.userMessage }
    ];

    try {
      const reply = await this.generateText(config, fullSystemPrompt, turns);
      return reply.slice(0, 800);
    } catch {
      return 'Recebi sua mensagem! Escolha uma das opcoes abaixo para acessar os links direto da Shopee:';
    }
  }
}
