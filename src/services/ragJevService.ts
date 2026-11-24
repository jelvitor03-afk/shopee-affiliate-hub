import { CatalogItemRecord, HubDatabase, HubSettings } from '../db/database.js';

export type LeadIntent = 'opt_out' | 'quick_option' | 'small_talk' | 'product_query';

export interface JevEvaluationResult {
  action: 'proceed' | 'human_checkpoint';
  intent: LeadIntent;
  topScore: number;
  topItem?: CatalogItemRecord;
  context: string;
  allowedUrls: string[];
  checkpointReply?: string;
}

const SMALL_TALK_WORDS = new Set([
  'oi',
  'ola',
  'opa',
  'eai',
  'bom',
  'boa',
  'dia',
  'tarde',
  'noite',
  'tudo',
  'bem',
  'joia',
  'beleza',
  'obrigado',
  'obrigada',
  'valeu',
  'ai',
  'voce',
  'com'
]);

const PT_STOPWORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'uns', 'umas', 'para', 'pra', 'pro', 'por', 'com', 'sem', 'sobre',
  'que', 'qual', 'quais', 'quem', 'como', 'onde', 'quando', 'quanto', 'custa',
  'esse', 'essa', 'isso', 'este', 'esta', 'isto', 'aquele', 'aquela', 'voce',
  'voces', 'meu', 'minha', 'seu', 'sua', 'tem', 'sao', 'esta', 'estao', 'fica',
  'aqui', 'ali', 'mais', 'muito', 'bem', 'bom', 'boa', 'favor', 'oi', 'ola',
  'quero', 'saber', 'gostaria', 'preciso', 'pode', 'manda', 'enviar'
]);

function normalizePt(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeContent(raw: string): string[] {
  return normalizePt(raw)
    .split(' ')
    .filter((w) => w.length >= 2 && !PT_STOPWORDS.has(w));
}

export class RagJevService {
  constructor(private readonly db: HubDatabase) {}

  routeIntent(query: string): LeadIntent {
    const clean = normalizePt(query);
    if (/^[123]$/.test(clean)) return 'quick_option';
    const words = clean.split(' ').filter(Boolean);
    if (
      words.length > 0 &&
      words.length <= 6 &&
      words.every((w) => SMALL_TALK_WORDS.has(w))
    ) {
      return 'small_talk';
    }
    return 'product_query';
  }

  scoreCandidate(query: string, item: CatalogItemRecord): number {
    const qNorm = normalizePt(query);
    const qTokens = tokenizeContent(query);
    if (qTokens.length === 0) return 0;

    const titleNorm = normalizePt(item.title);
    const titleTokens = tokenizeContent(item.title);
    const kwList = item.keywords
      .split(',')
      .map((k) => normalizePt(k))
      .filter(Boolean);

    const priceTerms = item.price_label ? 'preco valor custa reais promocao desconto' : '';
    const corpusTokens = new Set(
      tokenizeContent(
        `${item.title} ${item.keywords} ${item.price_label} ${priceTerms} ${item.specs_faq} ${item.objections}`
      )
    );

    let hits = 0;
    for (const tok of qTokens) {
      if (corpusTokens.has(tok)) hits += 1;
    }

    const tokenRatio = hits / qTokens.length;
    const titleTokenHits = titleTokens.filter((t) => qTokens.includes(t)).length;
    const titleRatio =
      titleTokens.length > 0 ? titleTokenHits / titleTokens.length : 0;

    const exactTitleBonus =
      titleNorm && (qNorm.includes(titleNorm) || titleNorm.includes(qNorm))
        ? 0.45
        : titleRatio >= 0.5
        ? 0.35
        : titleTokenHits >= 1
        ? 0.2
        : 0;

    const kwMatches = kwList.filter((kw) => qNorm.includes(kw)).length;
    const kwBonus = kwMatches >= 2 ? 0.35 : kwMatches === 1 ? 0.25 : 0;

    return Number(
      Math.min(1, tokenRatio * 0.55 + exactTitleBonus + kwBonus).toFixed(2)
    );
  }

  evaluateWithJev(
    jid: string,
    query: string,
    settings: HubSettings
  ): JevEvaluationResult {
    const intent = this.routeIntent(query);
    const catalog = this.db.listCatalogItems(true);
    const allowedUrls = catalog.map((c) => c.affiliate_url).filter(Boolean);

    if (catalog.length === 0 || settings.jev_enabled !== 'true') {
      return {
        action: 'proceed',
        intent,
        topScore: 1,
        context: '',
        allowedUrls
      };
    }

    if (intent === 'small_talk') {
      const summaryList = catalog
        .slice(0, 3)
        .map((c) => `- ${c.title} (${c.price_label}): ${c.affiliate_url}`)
        .join('\n');
      return {
        action: 'proceed',
        intent,
        topScore: 1,
        context: `Catalogo disponivel hoje:\n${summaryList}`,
        allowedUrls
      };
    }

    const ranked = catalog
      .map((item) => ({ item, score: this.scoreCandidate(query, item) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]!;
    const threshold = Number.parseFloat(settings.jev_threshold || '0.65');
    const safeThreshold = Number.isFinite(threshold) ? threshold : 0.65;

    if (best.score < safeThreshold) {
      const fallback =
        settings.jev_fallback_message.trim() ||
        'Deixa eu confirmar esse detalhe rapidinho aqui pra voce e ja te retorno!';
      this.db.addLog(
        'warn',
        'jev',
        `Human Checkpoint acionado para ${jid} (score=${best.score}, pergunta="${query.slice(0, 60)}")`
      );
      return {
        action: 'human_checkpoint',
        intent,
        topScore: best.score,
        context: '',
        allowedUrls,
        checkpointReply: fallback
      };
    }

    const topContext = [
      `PRODUTO VERIFICADO: ${best.item.title}`,
      `PRECO APROXIMADO: ${best.item.price_label}`,
      `LINK OFICIAL PERMITIDO: ${best.item.affiliate_url}`,
      `DETALHES E FAQ: ${best.item.specs_faq}`,
      best.item.objections ? `ARGUMENTOS: ${best.item.objections}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    return {
      action: 'proceed',
      intent,
      topScore: best.score,
      topItem: best.item,
      context: topContext,
      allowedUrls: [best.item.affiliate_url, ...allowedUrls]
    };
  }

  sanitizeOutputUrls(replyText: string, allowedUrls: string[]): string {
    if (allowedUrls.length === 0) return replyText;
    const allowedSet = new Set(allowedUrls.map((u) => u.trim()));
    return replyText.replace(/https?:\/\/[^\s)]+/gi, (foundUrl) => {
      const clean = foundUrl.replace(/[.,!?;:]+$/, '');
      if (allowedSet.has(clean)) return foundUrl;
      return allowedUrls[0]!;
    });
  }
}
