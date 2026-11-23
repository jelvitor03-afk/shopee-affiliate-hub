(() => {
  'use strict';

  const state = {
    settings: {},
    buttons: [],
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

  function setPill(element, ok, okLabel = 'Configurado', warnLabel = 'Pendente') {
    element.className = `pill ${ok ? 'pill-ok' : 'pill-warn'}`;
    element.textContent = ok ? okLabel : warnLabel;
  }

  function showLogin(usingDefaultPassword) {
    el('login-view').classList.remove('hidden');
    el('app-view').classList.add('hidden');
    el('default-pass-hint').classList.toggle('hidden', !usingDefaultPassword);
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
    if (tabName === 'logs') void loadLogs();
    if (tabName === 'group') void loadWhatsAppStatus();
    if (tabName === 'tracker') void loadCampaigns();
  }

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
        'Clique em "Conectar / Gerar QR Code" quando estiver pronto para escanear com o chip do grupo.';
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

    setPill(el('chk-meta'), data.readiness.metaConfigured);
    setPill(el('chk-shopee'), data.readiness.shopeeConfigured);
    setPill(el('chk-group'), data.readiness.groupConfigured, 'Conectado', 'Pendente');
    setPill(el('chk-x1'), data.readiness.x1Configured);

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
          <span>Botão ${i + 1} (${card.dataset.btnId})</span>
          <span class="char-counter"><span class="cnt">${(btn.title || '').length}</span>/20</span>
        </div>
        <div class="field">
          <label>Texto no botão (máx. 20 caracteres)</label>
          <input type="text" class="x1-title" maxlength="20" value="" placeholder="Ex: Ver Oferta Hoje" />
        </div>
        <div class="field">
          <label>Mensagem após clicar</label>
          <textarea class="x1-reply" rows="2" placeholder="Ex: Aqui está o link com desconto:"></textarea>
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

    el('set-meta-pixel-id').value = data.settings.meta_pixel_id || '';
    el('set-meta-test-code').value = data.settings.meta_test_event_code || '';
    el('set-meta-capi-token').value = data.settings.meta_capi_token || '';
    el('set-include-unpaid').checked = data.settings.capi_include_unpaid === 'true';

    el('set-shopee-app-id').value = data.settings.shopee_app_id || '';
    el('set-shopee-secret').value = data.settings.shopee_secret || '';
    el('set-shopee-url').value =
      data.settings.shopee_graphql_url ||
      'https://open-api.affiliate.shopee.com.br/graphql';

    el('set-group-jid').value = data.settings.whatsapp_group_jid || '';
    el('set-group-interval').value = data.settings.group_interval_minutes || '60';
    el('set-group-start').value = data.settings.group_active_start_hour || '8';
    el('set-group-end').value = data.settings.group_active_end_hour || '22';
    el('set-shopee-keywords').value = data.settings.shopee_keywords || '';
    el('set-group-enabled').checked =
      data.settings.group_dispatch_enabled === 'true';

    el('set-wa-token').value = data.settings.meta_whatsapp_token || '';
    el('set-wa-phone-id').value = data.settings.meta_phone_number_id || '';
    el('set-wa-verify').value = data.settings.meta_webhook_verify_token || '';
    el('ov-verify-token').value = data.settings.meta_webhook_verify_token || '';
    el('set-ai-provider').value = data.settings.ai_provider || 'gemini';
    el('set-ai-model').value = data.settings.ai_model || 'gemini-2.5-flash';
    el('set-ai-key').value = data.settings.ai_api_key || '';
    el('set-x1-prompt').value = data.settings.x1_system_prompt || '';

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

  async function loadCampaigns() {
    const data = await api('/campaigns');
    const campBody = el('campaigns-tbody');
    campBody.innerHTML = '';

    const base = state.publicBaseUrl.replace(/\/+$/, '');
    if (!data.campaigns.length) {
      campBody.innerHTML =
        '<tr><td colspan="3" class="muted-sm">Nenhuma campanha criada ainda.</td></tr>';
    } else {
      for (const c of data.campaigns) {
        const goUrl = `${base}/go/${c.slug}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <div><strong>${escapeHtml(c.title)}</strong></div>
            <div class="muted-sm"><code>${escapeHtml(goUrl)}</code></div>
          </td>
          <td class="truncate" title="${escapeHtml(c.destination_url)}">${escapeHtml(c.destination_url)}</td>
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

    const convBody = el('conversions-tbody');
    convBody.innerHTML = '';
    if (!data.recentConversions.length) {
      convBody.innerHTML =
        '<tr><td colspan="5" class="muted-sm">Nenhuma conversão registrada ainda.</td></tr>';
    } else {
      for (const conv of data.recentConversions) {
        const pillCls =
          conv.capi_status === 'SENT'
            ? 'pill-ok'
            : conv.capi_status === 'ERROR'
            ? 'pill-error'
            : 'pill-warn';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><code>${escapeHtml(conv.order_id)}</code></td>
          <td><code>${escapeHtml(conv.click_id || '-')}</code></td>
          <td>${escapeHtml(conv.order_status)}</td>
          <td>${formatMoney(conv.order_value)}</td>
          <td><span class="pill ${pillCls}">${escapeHtml(conv.capi_status)}</span></td>
        `;
        convBody.appendChild(tr);
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

  function escapeHtml(text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function bootstrapAuthenticated() {
    showApp();
    await Promise.all([loadSettings(), loadOverview(), loadCampaigns(), loadWhatsAppStatus()]);
  }

  // Event bindings
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
        showToast('Copiado para a área de transferência!');
      }
    }

    if (target.classList.contains('tab-btn') || target.classList.contains('jump-tab')) {
      if (target.dataset.tab) switchTab(target.dataset.tab);
    }

    if (target.classList.contains('btn-copy-go')) {
      void navigator.clipboard.writeText(target.dataset.url || '');
      showToast('Link do anúncio copiado!');
    }

    if (target.classList.contains('btn-del-camp')) {
      const slug = target.dataset.slug;
      if (slug) {
        void api(`/campaigns/${encodeURIComponent(slug)}`, { method: 'DELETE' })
          .then(() => {
            showToast('Campanha removida.');
            return loadCampaigns();
          })
          .catch((e) => showToast(e.message, 'error'));
      }
    }
  });

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

  el('btn-refresh-overview').addEventListener('click', () => {
    void loadOverview().then(() => showToast('Painel atualizado.'));
  });

  el('btn-save-public-url').addEventListener('click', () => {
    void saveSettingsPatch(
      { public_base_url: el('ov-public-url').value },
      'URL pública atualizada!'
    ).catch((e) => showToast(e.message, 'error'));
  });

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
      'Chaves da Meta e Shopee salvas!'
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
      const s = res.summary;
      showToast(
        `Sync concluído: ${s.sentToMeta} enviadas para Meta, ${s.skippedDuplicate} já enviadas.`
      );
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
      showToast('Link rastreável criado!');
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
    try {
      const res = await api('/whatsapp/logout', { method: 'POST', body: '{}' });
      renderWhatsAppState(res.state);
      showToast('WhatsApp desconectado.');
    } catch (err) {
      showToast(err.message, 'error');
    }
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

  el('x1-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettingsPatch(
      {
        meta_whatsapp_token: el('set-wa-token').value,
        meta_phone_number_id: el('set-wa-phone-id').value,
        meta_webhook_verify_token: el('set-wa-verify').value,
        ai_provider: el('set-ai-provider').value,
        ai_model: el('set-ai-model').value,
        ai_api_key: el('set-ai-key').value,
        x1_system_prompt: el('set-x1-prompt').value,
        x1_buttons_json: collectX1ButtonsJson()
      },
      'Configurações do X1 e botões salvas!'
    ).catch((err) => showToast(err.message, 'error'));
  });

  el('btn-refresh-logs').addEventListener('click', () => {
    void loadLogs().then(() => showToast('Logs atualizados.'));
  });

  // Boot
  fetch('/api/admin/session', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then(async (session) => {
      if (session.authenticated) {
        await bootstrapAuthenticated();
      } else {
        showLogin(Boolean(session.usingDefaultPassword));
      }
    })
    .catch(() => showLogin(true));
})();
