(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    user: null,
    conversations: [],
    activeConvoId: null,
    models: [],
    selectedModel: null, // { id, provider, category, label, ... }
    imageOptions: { size: 'auto', quality: 'auto', n: 1, outputFormat: 'png', background: 'auto' },
    noModelsAvailable: false,
    pendingImages: [], // { mediaType, data, dataUrl }
    streaming: false
  };

  // ---------------- fetch helpers ----------------

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---------------- markdown-lite + code rendering ----------------
  // Not a full markdown engine — just enough to make code (the point of
  // "coding" use cases) and basic emphasis readable. Everything is HTML-
  // escaped before any tag is added, so this is safe for any input,
  // including the user's own messages.

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineFormat(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderMarkdownLite(text) {
    text = text || '';
    const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    let html = '';
    let last = 0;
    let m;
    while ((m = codeBlockRe.exec(text))) {
      html += inlineFormat(escapeHtml(text.slice(last, m.index)));
      const lang = (m[1] || '').replace(/[^a-zA-Z0-9#+-]/g, '');
      const code = m[2];
      html += `<pre><button class="code-copy-btn" type="button">复制</button><code class="hljs${lang ? ' language-' + lang : ''}">${escapeHtml(code)}</code></pre>`;
      last = m.index + m[0].length;
    }
    html += inlineFormat(escapeHtml(text.slice(last)));
    return html;
  }

  function highlightCodeIn(el) {
    if (!window.hljs) return;
    el.querySelectorAll('pre code').forEach((block) => {
      try { window.hljs.highlightElement(block); } catch (e) { /* ignore */ }
    });
  }

  // Copy buttons inside rendered code blocks (event delegation, since the
  // blocks are created dynamically).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => toast('已复制代码'));
  });

  // ---------------- auth screen ----------------

  let authMode = 'login';

  function setAuthMode(mode, opts) {
    opts = opts || {};
    authMode = mode;
    $('#auth-error').classList.add('hidden');
    if (mode === 'register') {
      $('#auth-title').textContent = opts.firstUser ? '创建管理员账号' : '创建账号';
      $('#auth-sub').textContent = opts.firstUser ? '这是本服务的第一个账号，将自动成为管理员' : '注册一个新账号以开始使用';
      $('#auth-submit').textContent = '注册';
      $('#auth-switch-text').textContent = '已经有账号？';
      $('#auth-switch-btn').textContent = '去登录';
      $('#auth-password').setAttribute('autocomplete', 'new-password');
      $('#auth-first-badge').classList.toggle('hidden', !opts.firstUser);
    } else {
      $('#auth-title').textContent = '欢迎回来';
      $('#auth-sub').textContent = '登录以继续对话';
      $('#auth-submit').textContent = '登录';
      $('#auth-switch-text').textContent = '还没有账号？';
      $('#auth-switch-btn').textContent = '立即注册';
      $('#auth-password').setAttribute('autocomplete', 'current-password');
      $('#auth-first-badge').classList.add('hidden');
    }
  }

  $('#auth-switch-btn').addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const errEl = $('#auth-error');
    errEl.classList.add('hidden');
    $('#auth-submit').disabled = true;
    try {
      const data = await api('POST', authMode === 'login' ? '/api/auth/login' : '/api/auth/register', { username, password });
      state.user = data.user;
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      $('#auth-submit').disabled = false;
    }
  });

  async function initAuthScreen() {
    try {
      const status = await api('GET', '/api/auth/status');
      if (!status.hasUsers) {
        setAuthMode('register', { firstUser: true });
      } else {
        setAuthMode('login');
      }
      if (status.siteName) document.title = status.siteName;
    } catch (e) { /* default to login */ }
  }

  // ---------------- app shell ----------------

  function showApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    initApp();
  }

  function showAuth() {
    $('#app-screen').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    initAuthScreen();
  }

  async function initApp() {
    $('#user-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
    $('#user-name').textContent = state.user.username;
    $('#user-role').textContent = state.user.isAdmin ? '管理员' : '成员';
    $('#admin-tab-btn').classList.toggle('hidden', !state.user.isAdmin);

    await Promise.all([loadModels(), loadConversations()]);
    resetToWelcome();
  }

  async function loadModels() {
    let data;
    try {
      data = await api('GET', '/api/models');
    } catch (err) {
      toast(err.message);
      data = { models: [] };
    }
    state.models = data.models || [];

    const hint = $('#model-error-hint');
    const errs = data.errors || {};
    const errLines = [];
    if (errs.openai) errLines.push(`OpenAI 模型获取失败：${errs.openai}`);
    if (errs.claude) errLines.push(`Claude 模型获取失败：${errs.claude}`);
    if (errLines.length) {
      hint.textContent = errLines.join(' · ') + '（请检查密钥是否正确、以及服务器能否访问对应 API，见下方说明）';
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }

    state.noModelsAvailable = state.models.length === 0;
    if (!state.selectedModel || !state.models.some((m) => m.id === state.selectedModel.id && m.provider === state.selectedModel.provider)) {
      state.selectedModel = state.models[0] || null;
    }
    updateModelPickerButton();
    renderModelPickerList($('#model-picker-search').value);
  }

  const PROVIDER_LABELS = { openai: 'OpenAI', claude: 'Claude' };
  const CATEGORY_LABELS = { chat: '对话', image: '图像生成' };
  const TIER_LABELS = { flagship: '旗舰', reasoning: '推理', fast: '轻量', balanced: '均衡', image: '图像' };

  function updateModelPickerButton() {
    $('#model-picker-label').textContent = state.selectedModel
      ? state.selectedModel.label
      : (state.noModelsAvailable ? '暂无可用模型' : '选择模型');
    const isImage = state.selectedModel && state.selectedModel.category === 'image';
    $('#image-opts').classList.toggle('hidden', !isImage);
    if (!isImage) closeImageOpts();
  }

  function renderModelPickerList(filterText) {
    const list = $('#model-picker-list');
    list.innerHTML = '';
    const q = (filterText || '').trim().toLowerCase();

    if (!state.models.length) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = '暂无可用模型 · 请先在设置中配置 API 密钥';
      list.appendChild(empty);
      return;
    }

    const filtered = state.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'model-picker-empty';
      empty.textContent = '没有匹配的模型';
      list.appendChild(empty);
      return;
    }

    // Group by provider + category, e.g. "OpenAI · 对话", "OpenAI · 图像生成", "Claude · 对话".
    const groups = new Map();
    filtered.forEach((m) => {
      const key = `${m.provider}:${m.category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    });

    for (const [key, items] of groups) {
      const [provider, category] = key.split(':');
      const label = document.createElement('div');
      label.className = 'model-group-label';
      label.textContent = `${PROVIDER_LABELS[provider] || provider} · ${CATEGORY_LABELS[category] || category}`;
      list.appendChild(label);

      items.forEach((m) => {
        const item = document.createElement('div');
        const isSelected = state.selectedModel && state.selectedModel.id === m.id && state.selectedModel.provider === m.provider;
        item.className = 'model-item' + (isSelected ? ' selected' : '');
        const nameRow = document.createElement('div');
        nameRow.className = 'model-item-name';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = m.label;
        nameRow.appendChild(nameSpan);
        if (m.tier) {
          const pill = document.createElement('span');
          pill.className = 'model-tier-pill';
          pill.textContent = TIER_LABELS[m.tier] || m.tier;
          nameRow.appendChild(pill);
        }
        item.appendChild(nameRow);
        if (m.description) {
          const desc = document.createElement('div');
          desc.className = 'model-item-desc';
          desc.textContent = m.description;
          item.appendChild(desc);
        }
        item.addEventListener('click', () => selectModel(m));
        list.appendChild(item);
      });
    }
  }

  async function selectModel(m) {
    state.selectedModel = m;
    updateModelPickerButton();
    closeModelPicker();
    if (state.activeConvoId) {
      try {
        await api('PUT', `/api/conversations/${state.activeConvoId}`, { model: m.id, provider: m.provider, category: m.category });
      } catch (err) { toast(err.message); }
    }
  }

  function openModelPicker() {
    $('#model-picker-panel').classList.remove('hidden');
    $('#model-picker-search').value = '';
    renderModelPickerList('');
    $('#model-picker-search').focus();
  }
  function closeModelPicker() {
    $('#model-picker-panel').classList.add('hidden');
  }
  $('#model-picker-btn').addEventListener('click', () => {
    $('#model-picker-panel').classList.contains('hidden') ? openModelPicker() : closeModelPicker();
  });
  $('#model-picker-search').addEventListener('input', (e) => renderModelPickerList(e.target.value));
  document.addEventListener('click', (e) => {
    if (!$('#model-picker').contains(e.target)) closeModelPicker();
  });

  // ---------------- image generation options (size / quality / n / format / background) ----------------

  const IMAGE_SIZE_PRESETS = ['auto', '1024x1024', '1536x1024', '1024x1536'];

  function syncImageOptsControls() {
    const o = state.imageOptions;
    if (IMAGE_SIZE_PRESETS.includes(o.size)) {
      $('#opt-size').value = o.size;
      $('#opt-size-custom-row').classList.add('hidden');
    } else {
      $('#opt-size').value = 'custom';
      $('#opt-size-custom-row').classList.remove('hidden');
      $('#opt-size-custom').value = o.size || '';
    }
    $('#opt-quality').value = o.quality || 'auto';
    $('#opt-n').value = o.n || 1;
    $('#opt-format').value = o.outputFormat || 'png';
    $('#opt-background').value = o.background || 'auto';
  }

  async function persistImageOptions() {
    if (!state.activeConvoId) return;
    try {
      await api('PUT', `/api/conversations/${state.activeConvoId}`, { imageOptions: state.imageOptions });
    } catch (err) { toast(err.message); }
  }

  $('#opt-size').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      $('#opt-size-custom-row').classList.remove('hidden');
      state.imageOptions.size = $('#opt-size-custom').value.trim() || 'auto';
    } else {
      $('#opt-size-custom-row').classList.add('hidden');
      state.imageOptions.size = e.target.value;
    }
    persistImageOptions();
  });
  $('#opt-size-custom').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (/^\d{2,5}x\d{2,5}$/.test(v)) {
      state.imageOptions.size = v;
      persistImageOptions();
    } else {
      toast('尺寸格式应为 宽x高，例如 1536x864');
    }
  });
  $('#opt-quality').addEventListener('change', (e) => { state.imageOptions.quality = e.target.value; persistImageOptions(); });
  $('#opt-n').addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1));
    e.target.value = n;
    state.imageOptions.n = n;
    persistImageOptions();
  });
  $('#opt-format').addEventListener('change', (e) => { state.imageOptions.outputFormat = e.target.value; persistImageOptions(); });
  $('#opt-background').addEventListener('change', (e) => { state.imageOptions.background = e.target.value; persistImageOptions(); });

  function openImageOpts() {
    syncImageOptsControls();
    $('#image-opts-panel').classList.remove('hidden');
  }
  function closeImageOpts() {
    $('#image-opts-panel').classList.add('hidden');
  }
  $('#image-opts-btn').addEventListener('click', () => {
    $('#image-opts-panel').classList.contains('hidden') ? openImageOpts() : closeImageOpts();
  });
  document.addEventListener('click', (e) => {
    if (!$('#image-opts').contains(e.target)) closeImageOpts();
  });

  async function loadConversations() {
    const data = await api('GET', '/api/conversations');
    state.conversations = data.conversations;
    renderConvoList();
  }

  function renderConvoList() {
    const list = $('#convo-list');
    list.innerHTML = '';
    state.conversations.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'convo-item' + (c.id === state.activeConvoId ? ' active' : '');
      item.innerHTML = `<span class="convo-title"></span><button class="convo-delete" title="删除">✕</button>`;
      item.querySelector('.convo-title').textContent = c.title || '新对话';
      item.addEventListener('click', (e) => {
        if (e.target.closest('.convo-delete')) return;
        openConversation(c.id);
      });
      item.querySelector('.convo-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除这段对话？')) return;
        try {
          await api('DELETE', `/api/conversations/${c.id}`);
          state.conversations = state.conversations.filter((x) => x.id !== c.id);
          if (state.activeConvoId === c.id) resetToWelcome();
          renderConvoList();
        } catch (err) { toast(err.message); }
      });
      list.appendChild(item);
    });
  }

  function resetToWelcome() {
    state.activeConvoId = null;
    $('#welcome-view').classList.remove('hidden');
    $('#messages').classList.add('hidden');
    $('#composer').classList.add('hidden');
    $('#welcome-input').value = '';
    $('#welcome-input').style.height = 'auto';
    clearPendingImages();
    renderConvoList();
    closeSidebar();
  }

  async function openConversation(id) {
    try {
      const data = await api('GET', `/api/conversations/${id}`);
      state.activeConvoId = id;
      $('#welcome-view').classList.add('hidden');
      $('#messages').classList.remove('hidden');
      $('#composer').classList.remove('hidden');
      const match = state.models.find((m) => m.id === data.conversation.model && m.provider === data.conversation.provider);
      state.selectedModel = match || { id: data.conversation.model, provider: data.conversation.provider, category: data.conversation.category || 'chat', label: data.conversation.model };
      if (data.conversation.imageOptions) {
        state.imageOptions = { ...state.imageOptions, ...data.conversation.imageOptions };
      }
      updateModelPickerButton();
      clearPendingImages();
      renderMessages(data.messages);
      renderConvoList();
      closeSidebar();
    } catch (err) {
      toast(err.message);
    }
  }

  function renderMessages(messages) {
    const box = $('#messages');
    box.innerHTML = '';
    messages.forEach((m) => {
      const imgUrls = (m.images || []).map((img) => img.url);
      const { textEl } = appendMessageBubble(m.role, '', imgUrls);
      textEl.innerHTML = renderMarkdownLite(m.content);
      highlightCodeIn(textEl);
    });
    box.scrollTop = box.scrollHeight;
  }

  function appendMessageBubble(role, text, images) {
    images = images || [];
    const box = $('#messages');
    const row = document.createElement('div');
    row.className = 'msg msg-role-' + role;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (images.length) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'msg-images';
      images.forEach((src) => {
        const link = document.createElement('a');
        link.href = src;
        link.download = '';
        link.target = '_blank';
        link.rel = 'noopener';
        const img = document.createElement('img');
        img.src = src;
        img.onerror = () => {
          link.replaceWith(Object.assign(document.createElement('span'), {
            className: 'image-expired',
            textContent: '图片已过期'
          }));
        };
        link.appendChild(img);
        imgWrap.appendChild(link);
      });
      bubble.appendChild(imgWrap);
    }
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    if (text) textEl.textContent = text;
    bubble.appendChild(textEl);
    row.appendChild(bubble);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    return { row, bubble, textEl };
  }

  // ---------------- image attachments ----------------

  function clearPendingImages() {
    state.pendingImages = [];
    renderImagePreviews();
  }

  function renderImagePreviews() {
    const rows = [$('#welcome-image-preview'), $('#msg-image-preview')];
    rows.forEach((row) => {
      row.innerHTML = '';
      row.classList.toggle('hidden', state.pendingImages.length === 0);
      state.pendingImages.forEach((img, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'image-thumb';
        const el = document.createElement('img');
        el.src = img.dataUrl;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-thumb';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
          state.pendingImages.splice(idx, 1);
          renderImagePreviews();
        });
        thumb.appendChild(el);
        thumb.appendChild(removeBtn);
        row.appendChild(thumb);
      });
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files) {
    const MAX_IMAGES = 6;
    const MAX_SIZE = 8 * 1024 * 1024;
    for (const file of files) {
      if (state.pendingImages.length >= MAX_IMAGES) {
        toast(`最多同时添加 ${MAX_IMAGES} 张图片`);
        break;
      }
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_SIZE) {
        toast(`${file.name} 超过 8MB，已跳过`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (!m) continue;
        state.pendingImages.push({ mediaType: m[1], data: m[2], dataUrl });
      } catch (e) { /* skip unreadable file */ }
    }
    renderImagePreviews();
  }

  $('#welcome-attach-btn').addEventListener('click', () => $('#image-file-input').click());
  $('#msg-attach-btn').addEventListener('click', () => $('#image-file-input').click());
  $('#image-file-input').addEventListener('change', async (e) => {
    await addImageFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  // paste image directly into either textarea
  ['#welcome-input', '#msg-input'].forEach((sel) => {
    $(sel).addEventListener('paste', async (e) => {
      const files = Array.from(e.clipboardData && e.clipboardData.files || []).filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        await addImageFiles(files);
      }
    });
  });

  // ---------------- sending messages (streaming) ----------------

  async function ensureConversation() {
    if (state.activeConvoId) return state.activeConvoId;
    const picked = state.selectedModel;
    if (!picked) throw new Error('请先在设置中配置 API 密钥并选择模型。');
    const data = await api('POST', '/api/conversations', {
      model: picked.id,
      provider: picked.provider,
      category: picked.category,
      imageOptions: picked.category === 'image' ? state.imageOptions : undefined
    });
    state.activeConvoId = data.conversation.id;
    state.conversations.unshift({ id: data.conversation.id, title: '新对话', model: picked.id, provider: picked.provider, category: picked.category, updatedAt: data.conversation.updatedAt });
    $('#welcome-view').classList.add('hidden');
    $('#messages').classList.remove('hidden');
    $('#messages').innerHTML = '';
    $('#composer').classList.remove('hidden');
    renderConvoList();
    return state.activeConvoId;
  }

  async function sendMessage(text) {
    text = (text || '').trim();
    const images = state.pendingImages.slice();
    if (!text && !images.length) return;
    if (state.streaming) return;

    let convoId;
    try {
      convoId = await ensureConversation();
    } catch (err) {
      toast(err.message);
      return;
    }

    clearPendingImages();
    appendMessageBubble('user', text, images.map((i) => i.dataUrl));
    const { bubble: assistantBubble, textEl: assistantTextEl } = appendMessageBubble('assistant', '');
    assistantTextEl.innerHTML = '<span class="typing-dot"></span><span class="typing-dot" style="animation-delay:.15s"></span><span class="typing-dot" style="animation-delay:.3s"></span>';

    state.streaming = true;
    setSendingUI(true);

    let full = '';
    let firstDelta = true;
    let renderScheduled = false;
    let resultImages = null;

    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        assistantTextEl.textContent = full;
        $('#messages').scrollTop = $('#messages').scrollHeight;
        renderScheduled = false;
      });
    }

    try {
      const res = await fetch(`/api/conversations/${convoId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, images: images.map((i) => i.dataUrl) }),
        credentials: 'same-origin'
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '请求失败');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch (e) { continue; }
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.images) resultImages = parsed.images;
          if (parsed.delta) {
            if (firstDelta) { assistantTextEl.textContent = ''; firstDelta = false; }
            full += parsed.delta;
            scheduleRender();
          }
        }
      }
      if (resultImages && resultImages.length) {
        // Image-generation result: swap the placeholder text for the image(s).
        assistantTextEl.textContent = '';
        const imgWrap = document.createElement('div');
        imgWrap.className = 'msg-images';
        resultImages.forEach((img) => {
          const link = document.createElement('a');
          link.href = img.url;
          link.download = '';
          link.target = '_blank';
          link.rel = 'noopener';
          const el = document.createElement('img');
          el.src = img.url;
          link.appendChild(el);
          imgWrap.appendChild(link);
        });
        assistantBubble.insertBefore(imgWrap, assistantTextEl);
      } else {
        assistantTextEl.innerHTML = renderMarkdownLite(full);
        highlightCodeIn(assistantTextEl);
      }
    } catch (err) {
      assistantTextEl.textContent = (full || '') + `\n\n⚠️ ${err.message}`;
    } finally {
      state.streaming = false;
      setSendingUI(false);
      $('#messages').scrollTop = $('#messages').scrollHeight;
      loadConversations();
    }
  }

  function setSendingUI(sending) {
    $('#welcome-send').disabled = sending;
    $('#msg-send').disabled = sending;
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  $('#welcome-input').addEventListener('input', (e) => autoResize(e.target));
  $('#msg-input').addEventListener('input', (e) => autoResize(e.target));

  function wireComposer(inputSel, btnSel) {
    const input = $(inputSel);
    const btn = $(btnSel);
    btn.addEventListener('click', () => {
      const val = input.value;
      input.value = '';
      autoResize(input);
      sendMessage(val);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const val = input.value;
        input.value = '';
        autoResize(input);
        sendMessage(val);
      }
    });
  }
  wireComposer('#welcome-input', '#welcome-send');
  wireComposer('#msg-input', '#msg-send');

  $('#new-chat-btn').addEventListener('click', resetToWelcome);

  // ---------------- sidebar (mobile) ----------------

  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#sidebar-backdrop').classList.remove('hidden');
  }
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebar-backdrop').classList.add('hidden');
  }
  $('#sidebar-toggle-btn').addEventListener('click', () => {
    $('#sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
  });
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);

  // ---------------- settings modal ----------------

  function openSettings() {
    $('#settings-modal').classList.remove('hidden');
    switchTab('keys');
    loadProfileIntoModal();
    if (state.user.isAdmin) loadAdminIntoModal();
  }

  function closeSettings() {
    $('#settings-modal').classList.add('hidden');
  }

  $('#user-menu-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings();
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    state.user = null;
    closeSettings();
    showAuth();
  });

  function switchTab(tab) {
    $all('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $all('.tab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== tab));
  }
  $all('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  async function loadProfileIntoModal() {
    try {
      const data = await api('GET', '/api/settings/profile');
      const u = data.user;
      $('#personal-openai-key').value = '';
      $('#personal-openai-key').placeholder = u.hasPersonalOpenAIKey ? '已设置 · 输入新值以替换' : 'sk-...';
      $('#personal-claude-key').value = '';
      $('#personal-claude-key').placeholder = u.hasPersonalClaudeKey ? '已设置 · 输入新值以替换' : 'sk-ant-...';

      $('#relay-base-url').textContent = location.origin + '/v1';
      $('#relay-key').textContent = u.relayApiKey;
      $('#relay-example').textContent =
        `curl ${location.origin}/v1/chat/completions -H "Authorization: Bearer ${u.relayApiKey}" -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'`;
    } catch (err) { toast(err.message); }
  }

  async function loadAdminIntoModal() {
    try {
      const data = await api('GET', '/api/settings/admin');
      $('#admin-site-name').value = data.settings.siteName || '';
      $('#admin-openai-key').value = '';
      $('#admin-openai-key').placeholder = data.settings.hasGlobalOpenAIKey ? '已配置 · 输入新值以替换' : 'sk-...';
      $('#admin-claude-key').value = '';
      $('#admin-claude-key').placeholder = data.settings.hasGlobalClaudeKey ? '已配置 · 输入新值以替换' : 'sk-ant-...';
      $('#admin-allow-registration').checked = !!data.settings.allowRegistration;
      $('#admin-image-retention').value = data.settings.imageRetentionDays;

      const body = $('#admin-users-body');
      body.innerHTML = '';
      data.users.forEach((u) => {
        const tr = document.createElement('tr');
        const isSelf = u.id === state.user.id;
        tr.innerHTML = `
          <td></td>
          <td><span class="pill ${u.isAdmin ? 'pill-admin' : ''}"></span></td>
          <td style="font-family:monospace; font-size:11.5px; color:var(--text-faint);"></td>
          <td></td>`;
        tr.children[0].textContent = u.username;
        tr.children[1].querySelector('.pill').textContent = u.isAdmin ? '管理员' : '成员';
        tr.children[2].textContent = u.relayApiKey.slice(0, 14) + '…';
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn btn-ghost';
        toggleBtn.style.padding = '4px 8px';
        toggleBtn.style.fontSize = '12px';
        toggleBtn.textContent = u.isAdmin ? '取消管理员' : '设为管理员';
        toggleBtn.disabled = isSelf;
        toggleBtn.addEventListener('click', async () => {
          try {
            await api('PUT', `/api/settings/admin/users/${u.id}/admin`, { isAdmin: !u.isAdmin });
            loadAdminIntoModal();
          } catch (err) { toast(err.message); }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-ghost btn-danger';
        delBtn.style.padding = '4px 8px';
        delBtn.style.fontSize = '12px';
        delBtn.textContent = '删除';
        delBtn.disabled = isSelf;
        delBtn.addEventListener('click', async () => {
          if (!confirm(`删除用户 ${u.username}？其所有对话记录也会被删除。`)) return;
          try {
            await api('DELETE', `/api/settings/admin/users/${u.id}`);
            loadAdminIntoModal();
          } catch (err) { toast(err.message); }
        });

        actions.appendChild(toggleBtn);
        actions.appendChild(delBtn);
        tr.children[3].appendChild(actions);
        body.appendChild(tr);
      });
    } catch (err) { toast(err.message); }
  }

  $('#save-keys-btn').addEventListener('click', async () => {
    const payload = {};
    const openaiInput = $('#personal-openai-key');
    const claudeInput = $('#personal-claude-key');
    if (openaiInput.value.trim() || openaiInput.dataset.forceEmpty) payload.personalOpenAIKey = openaiInput.value.trim();
    if (claudeInput.value.trim() || claudeInput.dataset.forceEmpty) payload.personalClaudeKey = claudeInput.value.trim();
    try {
      const data = await api('PUT', '/api/settings/profile', payload);
      state.user = { ...state.user, ...data.user };
      delete openaiInput.dataset.forceEmpty;
      delete claudeInput.dataset.forceEmpty;
      toast('已保存');
      loadProfileIntoModal();
      loadModels();
    } catch (err) { toast(err.message); }
  });

  $('#regen-relay-key-btn').addEventListener('click', async () => {
    if (!confirm('重新生成后，旧的中转密钥将立即失效，所有使用旧密钥的远程客户端都需要更新。继续？')) return;
    try {
      const data = await api('POST', '/api/settings/profile/regenerate-relay-key');
      state.user = { ...state.user, ...data.user };
      toast('已生成新密钥');
      loadProfileIntoModal();
    } catch (err) { toast(err.message); }
  });

  $('#save-admin-btn').addEventListener('click', async () => {
    const payload = {
      siteName: $('#admin-site-name').value.trim(),
      allowRegistration: $('#admin-allow-registration').checked,
      imageRetentionDays: $('#admin-image-retention').value
    };
    const openaiInput = $('#admin-openai-key');
    const claudeInput = $('#admin-claude-key');
    if (openaiInput.value.trim() || openaiInput.dataset.forceEmpty) payload.globalOpenAIKey = openaiInput.value.trim();
    if (claudeInput.value.trim() || claudeInput.dataset.forceEmpty) payload.globalClaudeKey = claudeInput.value.trim();
    try {
      await api('PUT', '/api/settings/admin', payload);
      delete openaiInput.dataset.forceEmpty;
      delete claudeInput.dataset.forceEmpty;
      toast('已保存');
      loadAdminIntoModal();
      loadModels();
    } catch (err) { toast(err.message); }
  });

  $all('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $('#' + btn.dataset.clear);
      input.value = '';
      input.dataset.forceEmpty = '1';
      toast('已清空，点击保存以生效');
    });
  });

  $all('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = $('#' + btn.dataset.copy).textContent;
      navigator.clipboard.writeText(text).then(() => toast('已复制'));
    });
  });

  // ---------------- boot ----------------

  (async function boot() {
    try {
      const data = await api('GET', '/api/auth/me');
      state.user = data.user;
      showApp();
    } catch (e) {
      showAuth();
    }
  })();
})();
