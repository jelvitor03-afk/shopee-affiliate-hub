(() => {
  'use strict';

  const state = {
    settings: {},
    buttons: [],
    roiData: null,
    sortCol: 'roas',
    sortAsc: false,
    publicBaseUrl: window.location.origin,
    waPollTimer: null
  };

  const el = (id) => document.getElementById(id);

  function showToast(message, type = 'ok') {
    const box = el('toast-container');
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'toast-error' : 'toast-ok'}`;
    node.textContent = message;
    box.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api/admin${path}`, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin(false);
      throw new Error(data.error || 'Sessão expirada.');
    }
    if (!res.ok) {
      throw new Error(data.error || `Erro HTTP ${res.status}`);
    }
    return data;
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    });
  }

  function formatEpoch(sec) {
    if (!sec) return '-';
    return new Date(sec * 1000).toLocaleString('pt-BR');
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function setPill(element, ok, okLabel = 'Configurado', warnLabel = 'Pendente') {
    element.className = `pill ${ok ? 'pill-ok' : 'pill-warn'}`;
    element.textContent = ok ? okLabel : warnLabel;
  }

  function showLogin() {
    el('login-view').classList.remove('hidden');
    el('app-view').classList.add('hidden');
    stopWaPolling();
  }

  function showApp() {
    el('login-view').classList.add('hidden');
    el('app-view').classList.remove('hidden');
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
    if (tabName === 'roi') void loadRoiDashboard();
    if (tabName === 'x1') void Promise.all([loadCatalog(), loadPausedContacts()]);
    if (tabName === 'antiban') void loadAntiBan();
    if (tabName === 'group') void loadWhatsAppStatus();
    if (tabName === 'tracker') void Promise.all([loadCampaigns(), loadLogs()]);
    if (tabName === 'overview') void loadOverview();
  }

  // --- ROI Campaigns (Afiliado Dash) ---
  function renderRoiTable() {
    if (!state.roiData) return;
    const campaigns = [...state.roiData.campaigns];
    campaigns.sort((a, b) => {
      const va = a[state.sortCol];
      const vb = b[state.sortCol];
      if (typeof va === 'string' && typeof vb === 'string') {
        return state.sortAsc
          ? va.localeCompare(vb, 'pt-BR')
          : vb.localeCompare(va, 'pt-BR');
      }
      return state.sortAsc ? Number(va) - Number(vb) : Number(vb) - Number(va);
    });

    const tbody = el('roi-campaigns-tbody');
    tbody.innerHTML = '';

    if (!campaigns.length) {
      tbody.innerHTML =
        '<tr><td colspan="10" class="muted-sm">Nenhuma campanha encontrada no período.</td></tr>';
      return;
    }

    for (const c of campaigns) {
      const tr = document.createElement('tr');
      const isOn = c.status === 'ACTIVE';
      const profitCls = c.profit >= 0 ? 'val-pos' : 'val-neg';
      tr.innerHTML = `
        <td>
          <button
            type="button"
            class="switch-btn ${isOn ? 'is-on' : ''}"
            data-camp-id="${escapeHtml(c.id)}"
            data-next-status="${isOn ? 'PAUSED' : 'ACTIVE'}"
            aria-label="Alternar status ${escapeHtml(c.name)}"
            title="${isOn ? 'Ativa — clique para pausar' : 'Pausada — clique para ativar'}"
          ></button>
        </td>
        <td><strong>${escapeHtml(c.name)}</strong><div class="muted-sm"><code>${escapeHtml(c.id)}</code></div></td>
        <td>
          <div class="budget-inline">
            <span>${formatMoney(c.dailyBudget)}</span>
            <button type="button" class="btn btn-ghost btn-sm btn-edit-budget" data-camp-id="${escapeHtml(c.id)}" data-current="${c.dailyBudget}">Editar</button>
          </div>
        </td>
        <td>${formatMoney(c.spend)}</td>
        <td>${c.sales}</td>
        <td>${formatMoney(c.totalOrderValue)}</td>
        <td>${formatMoney(c.commission)}</td>
        <td class="${profitCls}"><strong>${formatMoney(c.profit)}</strong></td>
        <td><strong>${c.roas.toFixed(2).replace('.', ',')}</strong></td>
        <td>${c.ctr.toFixed(2).replace('.', ',')}%</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function loadRoiDashboard() {
    const preset = el('roi-date-preset').value || 'today';
    const data = await api(`/roi-campaigns?datePreset=${encodeURIComponent(preset)}`);
    state.roiData = data;

    const badge = el('roi-demo-badge');
    badge.className = `pill ${data.isDemo ? 'pill-warn' : 'pill-ok'}`;
    badge.textContent = data.isDemo ? 'Modo Demo' : 'Ao Vivo (Meta + Shopee)';

    const s = data.summary;
    el('roi-kpi-spend').textContent = formatMoney(s.investment);
    el('roi-kpi-commission').textContent = formatMoney(s.totalCommission);
    const profitEl = el('roi-kpi-profit');
    profitEl.textContent = formatMoney(s.profit);
    profitEl.className = `kpi-value ${s.profit >= 0 ? 'val-pos' : 'val-neg'}`;
    el('roi-kpi-roas').textContent = s.roas.toFixed(2).replace('.', ',');
    el('roi-kpi-orders').textContent = String(s.totalOrders);
    el('roi-kpi-clicks').textContent = String(s.adClicks);
    el('roi-kpi-linkclicks').textContent = String(s.linkClicks);
    el('roi-kpi-cpc').textContent = formatMoney(s.avgCpc);

    renderRoiTable();

    const linksBody = el('subid-links-tbody');
    linksBody.innerHTML = '';
    if (!data.subidLinks.length) {
      linksBody.innerHTML =
        '<tr><td colspan="2" class="muted-sm">Nenhum vínculo sub_id criado ainda.</td></tr>';
    } else {
      for (const l of data.subidLinks) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(l.campaign_name)}</strong><div class="muted-sm">sub_id: <code>${escapeHtml(l.sub_id)}</code></div></td>
          <td><code>${escapeHtml(l.short_link)}</code></td>
        `;
        linksBody.appendChild(tr);
      }
    }
  }

  // --- WhatsApp Baileys State ---
  function renderWhatsAppState(waState) {
    const headerPill = el('header-wa-pill');
    const panelPill = el('baileys-status-pill');
    const qrBox = el('qr-box');
    const qrImg = el('qr-image');
    const info = el('baileys-info');

    const labelMap = {
      disconnected: 'Desconectado',
      connecting: 'Conectando...',
      qr: 'Aguardando QR Code',
      connected: 'Conectado'
    };
    const classMap = {
      disconnected: 'pill pill-muted',
      connecting: 'pill pill-warn',
      qr: 'pill pill-warn',
      connected: 'pill pill-ok'
    };

    const label = labelMap[waState.status] || waState.status;
    const cls = classMap[waState.status] || 'pill pill-muted';

    headerPill.className = cls;
    headerPill.textContent = `WhatsApp: ${label}`;
    panelPill.className = cls;
    panelPill.textContent = label;

    if (waState.status === 'qr' && waState.qrDataUrl) {
      qrBox.classList.remove('hidden');
      qrImg.src = waState.qrDataUrl;
    } else {
      qrBox.classList.add('hidden');
      qrImg.removeAttribute('src');
    }

    if (waState.status === 'connected') {
      info.textContent = `Sessão ativa no número: ${waState.connectedPhone || 'WhatsApp conectado'}.`;
      stopWaPolling();
    } else if (waState.lastError) {
      info.textContent = `Aviso: ${waState.lastError}`;
    } else {
      info.textContent =
        'Clique em "Conectar / Gerar QR Code" quando estiver pronto para escanear com o chip.';
    }
  }

  function startWaPolling() {
    if (state.waPollTimer) return;
    state.waPollTimer = setInterval(() => {
      void loadWhatsAppStatus();
    }, 3000);
  }

  function stopWaPolling() {
    if (state.waPollTimer) {
      clearInterval(state.waPollTimer);
      state.waPollTimer = null;
    }
  }

  async function loadOverview() {
    const data = await api('/overview');
    const s = data.stats;
    state.publicBaseUrl = data.publicBaseUrl || window.location.origin;

    el('kpi-clicks').textContent = String(s.totalClicks);
    el('kpi-clicks-24h').textContent = `${s.clicks24h} nas últimas 24h`;
    el('kpi-conversions').textContent = String(s.totalConversionsSent);
    el('kpi-revenue').textContent = formatMoney(s.totalTrackedRevenue);
    el('kpi-wa-actions').textContent = String(
      s.totalDispatchedOffers + s.totalX1Messages
    );
    el('kpi-wa-sub').textContent = `${s.totalDispatchedOffers} no grupo • ${s.totalX1Messages} respostas X1`;

    setPill(
      el('chk-meta-ads'),
      data.readiness.metaAdsConfigured,
      'Conectado',
      'Demo'
    );
    setPill(el('chk-shopee'), data.readiness.shopeeConfigured);
    setPill(el('chk-group'), data.readiness.groupConfigured, 'Conectado', 'Pendente');
    setPill(el('chk-x1'), data.readiness.x1Configured, 'Pronto', 'Pendente');

    const ab = data.antiBanStatus;
    const breakerPill = el('header-breaker-pill');
    breakerPill.className = `pill ${ab.circuitOpen ? 'pill-error' : 'pill-ok'}`;
    breakerPill.textContent = ab.circuitOpen
      ? 'Anti-Ban: CIRCUIT BREAKER'
      : `Anti-Ban: ${ab.sendsLastHour}/${ab.hourlyLimit}h`;

    const base = state.publicBaseUrl.replace(/\/+$/, '');
    el('ov-public-url').value = base;
    el('ov-webhook-url').value = `${base}${data.webhookPath}`;
    renderWhatsAppState(data.whatsappState);
  }

  function renderX1Buttons(buttons) {
    const container = el('x1-buttons-editor');
    container.innerHTML = '';

    for (let i = 0; i < 3; i++) {
      const btn = buttons[i] || {
        id: `btn_${i + 1}`,
        title: `Botão ${i + 1}`,
        replyText: '',
        linkUrl: ''
      };

      const card = document.createElement('div');
      card.className = 'x1-btn-card';
      card.dataset.btnId = btn.id || `btn_${i + 1}`;
      card.innerHTML = `
        <div class="x1-btn-head">
          <span>Opção ${i + 1} (${card.dataset.btnId})</span>
          <span class="char-counter"><span class="cnt">${(btn.title || '').length}</span>/20</span>
        </div>
        <div class="field">
          <label>Texto no botão (máx. 20 caracteres)</label>
          <input type="text" class="x1-title" maxlength="20" value="" placeholder="Ex: Ver Oferta Hoje" />
        </div>
        <div class="field">
          <label>Mensagem após clicar / escolher</label>
          <textarea class="x1-reply" rows="2"></textarea>
        </div>
        <div class="field">
          <label>Link de afiliado / destino</label>
          <input type="url" class="x1-link" value="" placeholder="https://shopee.com.br/..." />
        </div>
      `;

      const titleInput = card.querySelector('.x1-title');
      const replyInput = card.querySelector('.x1-reply');
      const linkInput = card.querySelector('.x1-link');
      const cnt = card.querySelector('.cnt');

      titleInput.value = btn.title || '';
      replyInput.value = btn.replyText || '';
      linkInput.value = btn.linkUrl || '';

      titleInput.addEventListener('input', () => {
        cnt.textContent = String(titleInput.value.length);
      });

      container.appendChild(card);
    }
  }

  function collectX1ButtonsJson() {
    const cards = Array.from(el('x1-buttons-editor').querySelectorAll('.x1-btn-card'));
    const list = cards.map((card, idx) => ({
      id: card.dataset.btnId || `btn_${idx + 1}`,
      title: card.querySelector('.x1-title').value.trim().slice(0, 20),
      replyText: card.querySelector('.x1-reply').value.trim(),
      linkUrl: card.querySelector('.x1-link').value.trim()
    }));
    return JSON.stringify(list);
  }

  async function loadSettings() {
    const data = await api('/settings');
    state.settings = data.settings;
    state.buttons = data.buttons;
    const st = data.settings;

    // Meta Ads + Shopee (ROI tab)
    el('set-ad-account-id').value = st.meta_ad_account_id || '';
    el('set-marketing-token').value = st.meta_marketing_token || '';
    el('roi-shopee-app-id').value = st.shopee_app_id || '';
    el('roi-shopee-secret').value = st.shopee_secret || '';

    // Tracker CAPI tab
    el('set-meta-pixel-id').value = st.meta_pixel_id || '';
    el('set-meta-test-code').value = st.meta_test_event_code || '';
    el('set-meta-capi-token').value = st.meta_capi_token || '';
    el('set-include-unpaid').checked = st.capi_include_unpaid === 'true';
    el('set-shopee-app-id').value = st.shopee_app_id || '';
    el('set-shopee-secret').value = st.shopee_secret || '';
    el('set-shopee-url').value =
      st.shopee_graphql_url || 'https://open-api.affiliate.shopee.com.br/graphql';

    // Group tab
    el('set-group-jid').value = st.whatsapp_group_jid || '';
    el('set-group-interval').value = st.group_interval_minutes || '60';
    el('set-group-start').value = st.group_active_start_hour || '8';
    el('set-group-end').value = st.group_active_end_hour || '22';
    el('set-shopee-keywords').value = st.shopee_keywords || '';
    el('set-group-enabled').checked = st.group_dispatch_enabled === 'true';

    // X1 + Voice + Jev tab
    el('set-x1-enabled').value = st.x1_enabled || 'true';
    el('set-x1-channel').value = st.x1_channel || 'baileys';
    el('set-ai-provider').value = st.ai_provider || 'gemini';
    el('set-ai-base-url').value = st.ai_base_url || 'http://localhost:11434/v1';
    el('set-ai-model').value = st.ai_model || 'gemini-2.5-flash';
    el('set-ai-key').value = st.ai_api_key || '';
    el('set-takeover-min').value = st.human_takeover_minutes || '30';
    el('set-x1-prompt').value = st.x1_system_prompt || '';
    el('set-x1-listen-audio').value = st.x1_listen_audio || 'true';
    el('set-x1-audio-mode').value = st.x1_audio_reply_mode || 'mirror';
    el('set-stt-provider').value = st.stt_provider || 'voicebox_local';
    el('set-stt-url').value = st.stt_base_url || 'http://127.0.0.1:17493';
    el('set-stt-key').value = st.stt_api_key || '';
    el('set-tts-provider').value = st.tts_provider || 'edge_local';
    el('set-tts-voice-id').value = st.tts_voice_id || 'pt-BR-FranciscaNeural';
    el('set-tts-url').value = st.tts_base_url || 'http://127.0.0.1:17493';
    el('set-tts-max-chars').value = st.x1_audio_max_chars || '280';
    el('set-tts-key').value = st.tts_api_key || '';
    el('voice-wav-current').textContent = st.tts_reference_wav
      ? `Amostra atual salva: ${st.tts_reference_wav}`
      : 'Nenhuma amostra WAV carregada (usando voz padrão selecionada).';

    el('set-wa-token').value = st.meta_whatsapp_token || '';
    el('set-wa-phone-id').value = st.meta_phone_number_id || '';
    el('set-wa-verify').value = st.meta_webhook_verify_token || '';
    el('set-meta-app-secret').value = st.meta_app_secret || '';
    el('ov-verify-token').value = st.meta_webhook_verify_token || '';
    el('set-jev-enabled').value = st.jev_enabled || 'true';
    el('set-jev-threshold').value = st.jev_threshold || '0.65';

    // Anti-Ban tab
    el('set-ab-debounce').value = st.antiban_debounce_sec || '10';
    el('set-ab-hourly').value = st.antiban_hourly_limit || '15';
    el('set-ab-daily').value = st.antiban_daily_limit || '40';
    el('set-ab-cd-every').value = st.antiban_cooldown_every || '12';
    el('set-ab-cd-min').value = st.antiban_cooldown_minutes || '4';
    el('set-ab-inbound-only').checked = st.antiban_inbound_only_24h === 'true';

    renderX1Buttons(data.buttons);
  }

  async function saveSettingsPatch(patch, successMsg = 'Configurações salvas!') {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch)
    });
    await Promise.all([loadSettings(), loadOverview()]);
    showToast(successMsg);
  }

  async function loadCatalog() {
    const data = await api('/catalog');
    const tbody = el('catalog-tbody');
    tbody.innerHTML = '';
    if (!data.items.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhum produto cadastrado no catálogo Jev.</td></tr>';
      return;
    }
    for (const item of data.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.title)}</strong><div class="muted-sm truncate">${escapeHtml(item.affiliate_url)}</div></td>
        <td>${escapeHtml(item.price_label)}</td>
        <td><button type="button" class="btn btn-danger btn-sm btn-del-cat" data-id="${item.id}">Remover</button></td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function loadPausedContacts() {
    const data = await api('/contacts/paused');
    const tbody = el('paused-tbody');
    tbody.innerHTML = '';
    if (!data.pausedContacts.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhuma conversa aguardando humano.</td></tr>';
      return;
    }
    for (const c of data.pausedContacts) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${escapeHtml(c.jid)}</code></td>
        <td>${escapeHtml(c.pause_reason || 'Pausado')}</td>
        <td><button type="button" class="btn btn-primary btn-sm btn-resume-jid" data-jid="${escapeHtml(c.jid)}">Retomar IA</button></td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function loadAntiBan() {
    const data = await api('/antiban/status');
    const ab = data.status;
    el('antiban-usage-pill').textContent = `${ab.sendsLastHour}/${ab.hourlyLimit}h • ${ab.sendsLastDay}/${ab.dailyLimit}d`;
    el('breaker-banner').classList.toggle('hidden', !ab.circuitOpen);
    el('breaker-reason').textContent = ab.lastError || '';

    const tbody = el('blacklist-tbody');
    tbody.innerHTML = '';
    if (!data.blacklist.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhum número bloqueado na blacklist.</td></tr>';
      return;
    }
    for (const b of data.blacklist) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${escapeHtml(b.jid)}</code></td>
        <td>${escapeHtml(b.reason)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm btn-unblock-jid" data-jid="${escapeHtml(b.jid)}">Remover</button></td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function loadCampaigns() {
    const data = await api('/campaigns');
    const campBody = el('campaigns-tbody');
    campBody.innerHTML = '';
    const base = state.publicBaseUrl.replace(/\/+$/, '');
    if (!data.campaigns.length) {
      campBody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhum link /go/ criado.</td></tr>';
    } else {
      for (const c of data.campaigns) {
        const goUrl = `${base}/go/${c.slug}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(c.title)}</strong><div class="muted-sm"><code>${escapeHtml(goUrl)}</code></div></td>
          <td class="truncate">${escapeHtml(c.destination_url)}</td>
          <td>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm btn-copy-go" data-url="${escapeHtml(goUrl)}">Copiar</button>
              <button type="button" class="btn btn-danger btn-sm btn-del-camp" data-slug="${escapeHtml(c.slug)}">Excluir</button>
            </div>
          </td>
        `;
        campBody.appendChild(tr);
      }
    }
  }

  async function loadWhatsAppStatus() {
    const data = await api('/whatsapp/status');
    renderWhatsAppState(data.state);
    if (data.state.status === 'connecting' || data.state.status === 'qr') {
      startWaPolling();
    }
    const offersBody = el('offers-tbody');
    offersBody.innerHTML = '';
    if (!data.dispatchedOffers.length) {
      offersBody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhuma oferta enviada ainda.</td></tr>';
    } else {
      for (const offer of data.dispatchedOffers) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="truncate">${escapeHtml(offer.product_name)}</td>
          <td>${escapeHtml(offer.price || '-')}</td>
          <td class="truncate"><code>${escapeHtml(offer.short_link)}</code></td>
        `;
        offersBody.appendChild(tr);
      }
    }
  }

  async function loadLogs() {
    const data = await api('/logs');
    const tbody = el('logs-tbody');
    tbody.innerHTML = '';
    if (!data.logs.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted-sm">Sem logs ainda.</td></tr>';
      return;
    }
    for (const log of data.logs) {
      const pillCls =
        log.level === 'error'
          ? 'pill-error'
          : log.level === 'warn'
          ? 'pill-warn'
          : 'pill-ok';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatEpoch(log.created_at)}</td>
        <td><code>${escapeHtml(log.module)}</code></td>
        <td><span class="pill ${pillCls}">${escapeHtml(log.level)}</span></td>
        <td>${escapeHtml(log.message)}${log.details ? ` <span class="muted-sm">(${escapeHtml(log.details)})</span>` : ''}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function bootstrapAuthenticated() {
    showApp();
    await Promise.all([loadSettings(), loadOverview(), loadRoiDashboard()]);
  }

  // Event Delegation
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.classList.contains('toggle-secret')) {
      const input = el(target.dataset.target);
      if (input) {
        const isPass = input.type === 'password';
        input.type = isPass ? 'text' : 'password';
        target.textContent = isPass ? 'Ocultar' : 'Mostrar';
      }
    }

    if (target.classList.contains('copy-btn')) {
      const input = el(target.dataset.copyTarget);
      if (input) {
        void navigator.clipboard.writeText(input.value);
        showToast('Copiado!');
      }
    }

    if (target.classList.contains('tab-btn') || target.classList.contains('jump-tab')) {
      if (target.dataset.tab) switchTab(target.dataset.tab);
    }

    if (target.classList.contains('sortable') && target.dataset.sort) {
      const col = target.dataset.sort;
      state.sortAsc = state.sortCol === col ? !state.sortAsc : false;
      state.sortCol = col;
      renderRoiTable();
    }

    if (target.classList.contains('switch-btn')) {
      const campId = target.dataset.campId;
      const nextStatus = target.dataset.nextStatus;
      if (campId && nextStatus) {
        void api(`/roi-campaigns/${encodeURIComponent(campId)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: nextStatus })
        })
          .then(() => {
            showToast(`Campanha ${nextStatus === 'ACTIVE' ? 'ativada' : 'pausada'}!`);
            return loadRoiDashboard();
          })
          .catch((e) => showToast(e.message, 'error'));
      }
    }

    if (target.classList.contains('btn-edit-budget')) {
      const campId = target.dataset.campId;
      const current = target.dataset.current || '20';
      const nextVal = window.prompt('Novo orçamento diário (R$):', current);
      if (campId && nextVal !== null) {
        void api(`/roi-campaigns/${encodeURIComponent(campId)}/budget`, {
          method: 'POST',
          body: JSON.stringify({ dailyBudget: Number.parseFloat(nextVal.replace(',', '.')) })
        })
          .then(() => {
            showToast('Orçamento atualizado!');
            return loadRoiDashboard();
          })
          .catch((e) => showToast(e.message, 'error'));
      }
    }

    if (target.classList.contains('ai-preset-btn')) {
      el('set-ai-provider').value = target.dataset.provider || 'openai_compat';
      el('set-ai-base-url').value = target.dataset.url || '';
      el('set-ai-model').value = target.dataset.model || '';
      showToast('Preset de IA preenchido (clique em Salvar para confirmar).');
    }

    if (target.classList.contains('antiban-preset-btn')) {
      const preset = target.dataset.preset;
      if (preset) {
        void api('/antiban/preset', {
          method: 'POST',
          body: JSON.stringify({ preset })
        })
          .then(() => Promise.all([loadSettings(), loadAntiBan(), loadOverview()]))
          .then(() => showToast(`Preset ${preset} aplicado!`))
          .catch((e) => showToast(e.message, 'error'));
      }
    }

    if (target.classList.contains('btn-del-cat')) {
      void api(`/catalog/${encodeURIComponent(target.dataset.id)}`, { method: 'DELETE' })
        .then(() => loadCatalog())
        .then(() => showToast('Produto removido do catálogo.'));
    }

    if (target.classList.contains('btn-resume-jid')) {
      void api(`/contacts/${encodeURIComponent(target.dataset.jid)}/resume`, {
        method: 'POST',
        body: '{}'
      })
        .then(() => loadPausedContacts())
        .then(() => showToast('IA retomada para este contato!'));
    }

    if (target.classList.contains('btn-unblock-jid')) {
      void api(`/blacklist/${encodeURIComponent(target.dataset.jid)}`, { method: 'DELETE' })
        .then(() => loadAntiBan())
        .then(() => showToast('Número removido da blacklist.'));
    }

    if (target.classList.contains('btn-copy-go')) {
      void navigator.clipboard.writeText(target.dataset.url || '');
      showToast('Link copiado!');
    }

    if (target.classList.contains('btn-del-camp')) {
      const slug = target.dataset.slug;
      if (slug) {
        void api(`/campaigns/${encodeURIComponent(slug)}`, { method: 'DELETE' }).then(() =>
          loadCampaigns()
        );
      }
    }
  });

  // Form & Button Handlers
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-error').classList.add('hidden');
    try {
      await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: el('login-password').value })
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao entrar.');
      });
      el('login-password').value = '';
      await bootstrapAuthenticated();
    } catch (err) {
      el('login-error').textContent = err.message;
      el('login-error').classList.remove('hidden');
    }
  });

  el('btn-logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    showLogin(false);
  });

  el('roi-date-preset').addEventListener('change', () => void loadRoiDashboard());
  el('btn-roi-refresh').addEventListener('click', () =>
    void loadRoiDashboard().then(() => showToast('Campanhas atualizadas!'))
  );

  el('btn-toggle-demo').addEventListener('click', () => {
    const nextDemo = state.settings.campaigns_demo_mode === 'true' ? 'false' : 'true';
    void saveSettingsPatch(
      { campaigns_demo_mode: nextDemo },
      nextDemo === 'true' ? 'Modo Demo ativado.' : 'Modo Ao Vivo ativado.'
    ).then(() => loadRoiDashboard());
  });

  el('subid-link-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/roi-campaigns/link', {
        method: 'POST',
        body: JSON.stringify({
          campaignId: el('subid-campaign-id').value,
          campaignName: el('subid-campaign-name').value,
          productUrl: el('subid-product-url').value
        })
      });
      el('subid-campaign-id').value = '';
      el('subid-campaign-name').value = '';
      el('subid-product-url').value = '';
      showToast('Link Shopee vinculado à campanha!');
      await loadRoiDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('meta-ads-creds-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        meta_ad_account_id: el('set-ad-account-id').value,
        meta_marketing_token: el('set-marketing-token').value,
        shopee_app_id: el('roi-shopee-app-id').value,
        shopee_secret: el('roi-shopee-secret').value
      },
      'Credenciais de Campanhas salvas!'
    ).then(() => loadRoiDashboard());
  });

  el('x1-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        x1_enabled: el('set-x1-enabled').value,
        x1_channel: el('set-x1-channel').value,
        ai_provider: el('set-ai-provider').value,
        ai_base_url: el('set-ai-base-url').value,
        ai_model: el('set-ai-model').value,
        ai_api_key: el('set-ai-key').value,
        human_takeover_minutes: el('set-takeover-min').value,
        x1_system_prompt: el('set-x1-prompt').value,
        x1_listen_audio: el('set-x1-listen-audio').value,
        x1_audio_reply_mode: el('set-x1-audio-mode').value,
        stt_provider: el('set-stt-provider').value,
        stt_base_url: el('set-stt-url').value,
        stt_api_key: el('set-stt-key').value,
        tts_provider: el('set-tts-provider').value,
        tts_voice_id: el('set-tts-voice-id').value,
        tts_base_url: el('set-tts-url').value,
        x1_audio_max_chars: el('set-tts-max-chars').value,
        tts_api_key: el('set-tts-key').value,
        meta_whatsapp_token: el('set-wa-token').value,
        meta_phone_number_id: el('set-wa-phone-id').value,
        meta_webhook_verify_token: el('set-wa-verify').value,
        meta_app_secret: el('set-meta-app-secret').value,
        jev_enabled: el('set-jev-enabled').value,
        jev_threshold: el('set-jev-threshold').value,
        x1_buttons_json: collectX1ButtonsJson()
      },
      'Configurações de X1, Voz & Jev salvas!'
    ).catch((err) => showToast(err.message, 'error'));
  });

  el('btn-upload-wav').addEventListener('click', () => {
    const file = el('voice-wav-input').files?.[0];
    if (!file) {
      showToast('Selecione um arquivo .wav primeiro.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void api('/voice/upload', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          base64: String(reader.result || '')
        })
      })
        .then((res) => {
          el('voice-wav-current').textContent = `Amostra atual salva: ${res.filename}`;
          showToast(`Amostra ${res.filename} enviada!`);
        })
        .catch((err) => showToast(err.message, 'error'));
    };
    reader.readAsDataURL(file);
  });

  el('btn-test-voice').addEventListener('click', async () => {
    try {
      showToast('Gerando áudio OGG/Opus de teste...');
      const res = await api('/voice/test', { method: 'POST', body: '{}' });
      const wrap = el('voice-preview-wrap');
      const player = el('voice-preview-audio');
      player.src = res.audioDataUrl;
      wrap.classList.remove('hidden');
      void player.play().catch(() => {});
      showToast(`Áudio gerado (${res.bytes} bytes)!`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('catalog-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          title: el('cat-title').value,
          priceLabel: el('cat-price').value,
          keywords: el('cat-keywords').value,
          affiliateUrl: el('cat-url').value,
          specsFaq: el('cat-faq').value
        })
      });
      await saveSettingsPatch(
        {
          jev_enabled: el('set-jev-enabled').value,
          jev_threshold: el('set-jev-threshold').value
        },
        'Produto salvo no catálogo Jev!'
      );
      el('cat-title').value = '';
      el('cat-price').value = '';
      el('cat-keywords').value = '';
      el('cat-url').value = '';
      el('cat-faq').value = '';
      await loadCatalog();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('btn-refresh-paused').addEventListener('click', () => void loadPausedContacts());

  el('antiban-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        antiban_debounce_sec: el('set-ab-debounce').value,
        antiban_hourly_limit: el('set-ab-hourly').value,
        antiban_daily_limit: el('set-ab-daily').value,
        antiban_cooldown_every: el('set-ab-cd-every').value,
        antiban_cooldown_minutes: el('set-ab-cd-min').value,
        antiban_inbound_only_24h: String(el('set-ab-inbound-only').checked)
      },
      'Regras Anti-Ban salvas!'
    ).then(() => loadAntiBan());
  });

  el('btn-reset-breaker').addEventListener('click', () => {
    void api('/antiban/reset-breaker', { method: 'POST', body: '{}' })
      .then(() => Promise.all([loadAntiBan(), loadOverview()]))
      .then(() => showToast('Circuit Breaker rearmado!'));
  });

  el('blacklist-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void api('/blacklist', {
      method: 'POST',
      body: JSON.stringify({ jid: el('blacklist-jid-input').value, reason: 'Manual' })
    })
      .then(() => {
        el('blacklist-jid-input').value = '';
        showToast('Contato adicionado à blacklist.');
        return loadAntiBan();
      })
      .catch((err) => showToast(err.message, 'error'));
  });

  el('btn-refresh-overview').addEventListener('click', () =>
    void loadOverview().then(() => showToast('Visão Geral atualizada.'))
  );

  el('btn-save-public-url').addEventListener('click', () =>
    void saveSettingsPatch({ public_base_url: el('ov-public-url').value }, 'URL pública salva!')
  );

  el('tracker-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        meta_pixel_id: el('set-meta-pixel-id').value,
        meta_test_event_code: el('set-meta-test-code').value,
        meta_capi_token: el('set-meta-capi-token').value,
        capi_include_unpaid: String(el('set-include-unpaid').checked),
        shopee_app_id: el('set-shopee-app-id').value,
        shopee_secret: el('set-shopee-secret').value,
        shopee_graphql_url: el('set-shopee-url').value
      },
      'Chaves CAPI salvas!'
    ).catch((err) => showToast(err.message, 'error'));
  });

  el('btn-test-capi').addEventListener('click', async () => {
    try {
      const res = await api('/test-capi', { method: 'POST', body: '{}' });
      showToast(`Evento Purchase de teste recebido (${res.testOrderId})!`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('btn-sync-now').addEventListener('click', async () => {
    try {
      const res = await api('/sync-conversions', { method: 'POST', body: '{}' });
      showToast(`Sync CAPI: ${res.summary.sentToMeta} enviadas.`);
      await Promise.all([loadCampaigns(), loadOverview()]);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('campaign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          slug: el('camp-slug').value,
          title: el('camp-title').value,
          destinationUrl: el('camp-dest').value,
          defaultValue: el('camp-value').value
        })
      });
      el('camp-slug').value = '';
      el('camp-title').value = '';
      el('camp-dest').value = '';
      el('camp-value').value = '';
      showToast('Link /go/ criado!');
      await loadCampaigns();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('btn-wa-connect').addEventListener('click', async () => {
    try {
      const res = await api('/whatsapp/connect', { method: 'POST', body: '{}' });
      renderWhatsAppState(res.state);
      startWaPolling();
      showToast('Gerando QR Code do WhatsApp...');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('btn-wa-logout').addEventListener('click', async () => {
    const res = await api('/whatsapp/logout', { method: 'POST', body: '{}' });
    renderWhatsAppState(res.state);
    showToast('WhatsApp desconectado.');
  });

  el('btn-wa-groups').addEventListener('click', async () => {
    try {
      const res = await api('/whatsapp/groups');
      const select = el('group-select');
      select.innerHTML = '<option value="">-- Escolha um grupo --</option>';
      for (const g of res.groups) {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.subject} (${g.size} membros)`;
        select.appendChild(opt);
      }
      showToast(`${res.groups.length} grupo(s) carregado(s)!`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('group-select').addEventListener('change', () => {
    const val = el('group-select').value;
    if (val) el('set-group-jid').value = val;
  });

  el('group-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        whatsapp_group_jid: el('set-group-jid').value,
        group_interval_minutes: el('set-group-interval').value,
        group_active_start_hour: el('set-group-start').value,
        group_active_end_hour: el('set-group-end').value,
        shopee_keywords: el('set-shopee-keywords').value,
        group_dispatch_enabled: String(el('set-group-enabled').checked)
      },
      'Regras do grupo salvas!'
    ).catch((err) => showToast(err.message, 'error'));
  });

  el('btn-dispatch-now').addEventListener('click', async () => {
    try {
      const res = await api('/whatsapp/dispatch-now', { method: 'POST', body: '{}' });
      if (res.ok) {
        showToast(`Oferta enviada: ${res.outcome.productName}`);
      } else {
        showToast(res.outcome?.reason || 'Não foi possível enviar oferta.', 'error');
      }
      await loadWhatsAppStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el('btn-refresh-logs').addEventListener('click', () =>
    void loadLogs().then(() => showToast('Logs atualizados.'))
  );

  // Boot
  fetch('/api/admin/session', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then(async (session) => {
      if (session.authenticated) {
        await bootstrapAuthenticated();
      } else {
        showLogin();
      }
    })
    .catch(() => showLogin());
})();
