'use strict';

/* Claude Console frontend. Plain JS on xterm.js UMD builds — no bundler.
 * Designed for HA ingress: relative URLs only, HTTP-safe clipboard cascade,
 * touch-friendly controls. */

(() => {
  // UMD globals expose either the class directly or a namespace object.
  const XTerminal = window.Terminal?.Terminal || window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
  const Unicode11Addon = window.Unicode11Addon?.Unicode11Addon || window.Unicode11Addon;
  const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
  const WebglAddon = window.WebglAddon?.WebglAddon || window.WebglAddon;

  const BASE = new URL('.', location.href);
  const api = (p) => new URL(`api/${p}`, BASE).toString();

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: $('tabs'), tabAdd: $('tab-add'),
    copy: $('btn-copy'), copyMenu: $('menu-copy'),
    tray: $('btn-tray'), trayMenu: $('menu-tray'), trayBadge: $('tray-badge'),
    paste: $('btn-paste'), attach: $('btn-attach'), update: $('btn-update'),
    fontDec: $('btn-font-dec'), fontInc: $('btn-font-inc'),
    keys: $('btn-keys'), kiosk: $('btn-kiosk'), help: $('btn-help'),
    terminal: $('terminal'), dropHint: $('drop-hint'),
    overlay: $('overlay'), overlayText: $('overlay-text'),
    keybar: $('keybar'), toastArea: $('toast-area'),
    fileInput: $('file-input'),
    dlgPaste: $('dlg-paste'), pasteInput: $('paste-input'),
    dlgCopy: $('dlg-copy'), copyOutput: $('copy-output'),
    dlgUpdate: $('dlg-update'), updateVersion: $('update-version'),
    updateOutput: $('update-output'), updateRun: $('update-run'),
    updateRespawn: $('update-respawn'),
    dlgHelp: $('dlg-help'), helpStatus: $('help-status'),
  };

  const state = {
    ws: null,
    wsAlive: false,
    reconnectDelay: 1000,
    pingTimer: null,
    missedPongs: 0,
    tabs: [{ index: 0, name: 'claude' }],
    currentTab: 0,
    tray: [],
    kiosk: false,
    status: {},
  };

  /* ---------------- toasts ---------------- */

  function toast(text, { error = false, ms = 2600 } = {}) {
    const el = document.createElement('div');
    el.className = `toast${error ? ' error' : ''}`;
    el.textContent = text;
    els.toastArea.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /* ---------------- clipboard cascade ---------------- */

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function trayAdd(text) {
    if (!text) return;
    if (state.tray[0] === text) return;
    state.tray.unshift(text);
    state.tray = state.tray.slice(0, 15);
    renderTray();
  }

  // gesture=true → we are inside a user activation and execCommand may work.
  // Every copy also lands in the tray as history / manual fallback.
  async function copyText(text, { gesture = false, silent = false } = {}) {
    if (!text) return false;
    trayAdd(text);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        if (!silent) toast('Copied');
        return true;
      } catch { /* fall through */ }
    }
    if (gesture && legacyCopy(text)) {
      if (!silent) toast('Copied');
      return true;
    }
    if (!silent) {
      toast('Saved to tray 📥 — automatic copy unavailable here', { error: false, ms: 3500 });
      pulseTray();
    }
    return false;
  }

  function pulseTray() {
    els.trayBadge.textContent = String(state.tray.length);
    els.trayBadge.classList.remove('hidden');
  }

  function renderTray() {
    els.trayBadge.textContent = String(state.tray.length);
    els.trayBadge.classList.toggle('hidden', state.tray.length === 0);
    els.trayMenu.innerHTML = '';
    if (!state.tray.length) {
      els.trayMenu.innerHTML = '<div class="menu-note">Nothing captured yet</div>';
      return;
    }
    state.tray.forEach((text) => {
      const b = document.createElement('button');
      const preview = text.replace(/\s+/g, ' ').trim();
      b.textContent = preview.length > 46 ? `${preview.slice(0, 46)}…` : (preview || '(whitespace)');
      b.title = 'Copy';
      b.addEventListener('click', () => {
        closeMenus();
        if (!copyGesture(text)) showCopyDialog(text);
      });
      els.trayMenu.appendChild(b);
    });
  }

  // Synchronous copy attempt inside a click — best shot for HTTP/WebView.
  function copyGesture(text) {
    trayAdd(text);
    if (legacyCopy(text)) { toast('Copied'); return true; }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast('Copied'))
        .catch(() => showCopyDialog(text));
      return true;
    }
    return false;
  }

  function showCopyDialog(text) {
    els.copyOutput.value = text;
    els.dlgCopy.showModal();
    els.copyOutput.focus();
    els.copyOutput.select();
  }

  /* ---------------- terminal ---------------- */

  const savedFont = Number(localStorage.getItem('cc-font-size')) || 14;
  const term = new XTerminal({
    fontSize: savedFont,
    fontFamily: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    scrollback: 10000,
    cursorBlink: true,
    allowProposedApi: true,
    theme: {
      background: '#1c1c1e',
      foreground: '#e4e4e7',
      cursor: '#d97757',
      selectionBackground: '#d9775766',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch { /* optional */ }
  term.loadAddon(new WebLinksAddon((event, uri) => {
    window.open(uri, '_blank', 'noopener');
  }));
  term.open(els.terminal);
  try {
    const webgl = new WebglAddon();
    // After an unrestored context loss the canvas freezes; disposing the
    // addon drops xterm back to the DOM renderer.
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL unavailable (old WebView) — DOM renderer is the default fallback */
  }
  fit.fit();

  // OSC 52: Claude's own copy path. Never reject — swallow so nothing leaks
  // as text; deliver via cascade (clipboard on HTTPS, tray on HTTP).
  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    if (payload === '?' || payload === '') return true;
    let text;
    try {
      const bin = atob(payload);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      text = new TextDecoder('utf-8').decode(bytes);
    } catch {
      return true;
    }
    copyText(text, { gesture: false });
    return true;
  });

  // Auto-copy selection on pointer release (user gesture → execCommand works).
  const maybeCopySelection = () => {
    setTimeout(() => {
      if (term.hasSelection()) {
        const sel = term.getSelection();
        if (sel.trim()) copyText(sel, { gesture: true, silent: false });
      }
    }, 0);
  };
  els.terminal.addEventListener('mouseup', maybeCopySelection);
  els.terminal.addEventListener('touchend', maybeCopySelection);

  term.onData((d) => send({ t: 'in', d }));
  // onBinary carries raw bytes that must not round-trip through UTF-8 JSON —
  // ship them as a binary frame (server writes them latin1-preserving).
  term.onBinary((d) => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255));
    }
  });
  term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));

  const refit = (() => {
    let raf = 0;
    return () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fit.fit());
    };
  })();
  window.addEventListener('resize', refit);
  new ResizeObserver(refit).observe(els.terminal);

  function setFontSize(delta) {
    const size = Math.min(28, Math.max(8, term.options.fontSize + delta));
    term.options.fontSize = size;
    localStorage.setItem('cc-font-size', String(size));
    refit();
  }

  /* ---------------- websocket ---------------- */

  function send(obj) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function wsUrl() {
    const u = new URL('ws', BASE);
    u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  function showOverlay(text) {
    els.overlayText.textContent = text;
    els.overlay.classList.remove('hidden');
  }
  function hideOverlay() { els.overlay.classList.add('hidden'); }

  let reconnectTimer = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  }

  function connect() {
    // Never allow parallel sockets — duplicate output and reconnect storms.
    if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.wsAlive = true;
      state.reconnectDelay = 1000;
      state.missedPongs = 0;
      hideOverlay();
      fit.fit();
      send({ t: 'resize', cols: term.cols, rows: term.rows });
      send({ t: 'select', w: state.currentTab });
      term.focus();
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        if (state.missedPongs >= 2) { ws.close(); return; }
        state.missedPongs += 1;
        send({ t: 'ping' });
      }, 25000);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'tabs') updateTabs(msg.tabs);
        else if (msg.t === 'pong') state.missedPongs = 0;
        else if (msg.t === 'fatal') toast(msg.error || 'Terminal error', { error: true, ms: 6000 });
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };

    ws.onclose = async () => {
      state.wsAlive = false;
      clearInterval(state.pingTimer);
      showOverlay('Reconnecting…');
      // Expired ingress session answers 401 — a reload re-authenticates.
      try {
        const r = await fetch(api('health'), { cache: 'no-store' });
        if (r.status === 401) { location.reload(); return; }
      } catch { /* network down; keep retrying */ }
      scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.wsAlive) connect();
  });

  /* ---------------- tabs ---------------- */

  function updateTabs(tabs) {
    if (!Array.isArray(tabs) || !tabs.length) return;
    state.tabs = tabs;
    if (!tabs.some((t) => t.index === state.currentTab)) {
      state.currentTab = tabs[0].index;
      send({ t: 'select', w: state.currentTab });
    }
    renderTabs();
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    state.tabs.forEach((tab) => {
      const b = document.createElement('button');
      b.className = `tab${tab.index === state.currentTab ? ' active' : ''}`;
      const label = document.createElement('span');
      label.textContent = tab.index === 0 ? '✳ Claude' : `${tab.name} ${tab.index}`;
      b.appendChild(label);
      if (tab.index !== 0) {
        const x = document.createElement('span');
        x.className = 'close';
        x.textContent = '✕';
        x.title = 'Close tab';
        x.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const r = await fetch(api(`tabs/${tab.index}`), { method: 'DELETE' });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error);
            updateTabs(j.tabs);
          } catch (err) {
            toast(String(err.message || err), { error: true });
          }
        });
        b.appendChild(x);
      }
      b.addEventListener('click', () => {
        state.currentTab = tab.index;
        send({ t: 'select', w: tab.index });
        renderTabs();
        term.focus();
      });
      els.tabs.appendChild(b);
    });
  }

  els.tabAdd.addEventListener('click', async () => {
    try {
      const r = await fetch(api('tabs'), { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      state.currentTab = j.index;
      updateTabs(j.tabs);
      send({ t: 'select', w: j.index });
      term.focus();
    } catch (err) {
      toast(String(err.message || err), { error: true });
    }
  });

  /* ---------------- copy menu ---------------- */

  function closeMenus() {
    els.copyMenu.classList.add('hidden');
    els.trayMenu.classList.add('hidden');
  }

  // Menus are position:fixed (the scrollable toolbar would clip absolute
  // children) and anchored to their button on open.
  function toggleMenu(menu, anchor) {
    const wasHidden = menu.classList.contains('hidden');
    closeMenus();
    if (wasHidden) {
      const rect = anchor.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`;
      menu.classList.remove('hidden');
    }
  }

  els.copy.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.copyMenu, els.copy); });
  els.tray.addEventListener('click', (e) => { e.stopPropagation(); renderTray(); toggleMenu(els.trayMenu, els.tray); });
  document.addEventListener('click', closeMenus);

  els.copyMenu.addEventListener('click', async (e) => {
    const kind = e.target?.dataset?.copy;
    if (!kind) return;
    closeMenus();
    if (kind === 'selection') {
      const sel = term.getSelection();
      if (!sel) { toast('Nothing selected — use Shift+drag', { error: true }); return; }
      if (!copyGesture(sel)) showCopyDialog(sel);
      return;
    }
    const lines = kind === 'visible' ? 0 : kind === 'recent' ? 1000 : 50000;
    try {
      const r = await fetch(api(`capture?window=${state.currentTab}&lines=${lines}`));
      if (!r.ok) throw new Error('capture failed');
      const text = await r.text();
      // The await may have consumed the activation; try anyway, then fall
      // back to the copy dialog so the text is never lost.
      const ok = await copyText(text, { gesture: true, silent: true });
      if (ok) toast('Copied');
      else showCopyDialog(text);
    } catch (err) {
      toast(String(err.message || err), { error: true });
    }
  });

  /* ---------------- paste ---------------- */

  els.paste.addEventListener('click', async () => {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { term.paste(text); term.focus(); return; }
      } catch { /* permission denied — fall through */ }
    }
    els.pasteInput.value = '';
    els.dlgPaste.showModal();
    els.pasteInput.focus();
  });

  $('paste-ok').addEventListener('click', () => {
    const text = els.pasteInput.value;
    els.dlgPaste.close();
    if (text) term.paste(text);
    term.focus();
  });
  $('paste-cancel').addEventListener('click', () => els.dlgPaste.close());

  /* ---------------- attachments ---------------- */

  async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    toast(`Uploading ${list.length} file(s)…`, { ms: 4000 });
    const form = new FormData();
    list.forEach((f) => form.append('file', f, f.name));
    let j;
    try {
      const r = await fetch(api('upload'), { method: 'POST', body: form });
      j = await r.json();
      if (!r.ok) throw new Error(j.error || 'upload failed');
    } catch (err) {
      toast(`Upload failed: ${err.message || err}`, { error: true, ms: 5000 });
      return;
    }
    const paths = j.files.map((f) => f.path);
    send({ t: 'in', d: ` ${paths.join(' ')} ` });
    toast(`Attached: ${j.files.map((f) => f.name).join(', ')}`, { ms: 4000 });
    term.focus();
  }

  els.attach.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    uploadFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  // Clipboard image / file paste anywhere in the page.
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files?.length) {
      e.preventDefault();
      e.stopPropagation();
      uploadFiles(files);
    }
  }, true);

  // Drag & drop.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      dragDepth += 1;
      els.dropHint.classList.remove('hidden');
    }
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropHint.classList.add('hidden');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropHint.classList.add('hidden');
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  /* ---------------- update ---------------- */

  els.update.addEventListener('click', async () => {
    els.updateOutput.classList.add('hidden');
    els.updateRespawn.classList.add('hidden');
    els.updateRun.classList.remove('hidden');
    els.updateRun.disabled = false;
    els.updateVersion.textContent = state.status.claudeVersion
      ? `Current version: ${state.status.claudeVersion}`
      : '';
    els.dlgUpdate.showModal();
  });

  els.updateRun.addEventListener('click', async () => {
    els.updateRun.disabled = true;
    els.updateOutput.classList.remove('hidden');
    els.updateOutput.textContent = 'Updating…';
    try {
      const r = await fetch(api('cli/update'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json();
      els.updateOutput.textContent = (j.output || '').trim() || '(no output)';
      if (j.changed) {
        els.updateVersion.textContent = `Updated: ${j.before} → ${j.after}`;
        els.updateRun.classList.add('hidden');
        els.updateRespawn.classList.remove('hidden');
      } else {
        els.updateVersion.textContent = `Version: ${j.after} (already current)`;
        els.updateRun.disabled = false;
      }
      refreshStatus();
    } catch (err) {
      els.updateOutput.textContent = `Update failed: ${err.message || err}`;
      els.updateRun.disabled = false;
    }
  });

  els.updateRespawn.addEventListener('click', async () => {
    try {
      const r = await fetch(api('claude/respawn'), { method: 'POST' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `respawn failed (${r.status})`);
      }
      els.dlgUpdate.close();
      state.currentTab = 0;
      send({ t: 'select', w: 0 });
      renderTabs();
      toast('Claude restarted on the new version');
      term.focus();
    } catch (err) {
      toast(String(err.message || err), { error: true });
    }
  });

  $('update-cancel').addEventListener('click', () => els.dlgUpdate.close());

  /* ---------------- key bar ---------------- */

  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) els.keybar.classList.remove('hidden');

  els.keys.addEventListener('click', () => {
    els.keybar.classList.toggle('hidden');
    refit();
  });

  els.keybar.addEventListener('click', (e) => {
    const seq = e.target?.dataset?.seq;
    if (seq) {
      send({ t: 'in', d: seq });
      term.focus();
    }
  });

  /* ---------------- kiosk / fullscreen ---------------- */

  const inIframe = window.parent !== window;
  els.kiosk.addEventListener('click', () => {
    if (inIframe) {
      state.kiosk = !state.kiosk;
      if (state.kiosk) {
        window.parent.postMessage({ type: 'home-assistant/subscribe-properties', kioskMode: true }, '*');
      } else {
        window.parent.postMessage({ type: 'home-assistant/unsubscribe-properties' }, '*');
      }
    } else if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen?.();
    }
    setTimeout(refit, 300);
  });

  /* ---------------- misc ---------------- */

  els.fontDec.addEventListener('click', () => setFontSize(-1));
  els.fontInc.addEventListener('click', () => setFontSize(+1));

  els.help.addEventListener('click', () => {
    els.helpStatus.textContent = state.status.claudeVersion
      ? `Claude Code ${state.status.claudeVersion}`
      : '';
    els.dlgHelp.showModal();
  });
  $('help-close').addEventListener('click', () => els.dlgHelp.close());
  $('copy-close').addEventListener('click', () => els.dlgCopy.close());

  async function refreshStatus() {
    try {
      const r = await fetch(api('status'), { cache: 'no-store' });
      if (r.ok) {
        state.status = await r.json();
        if (Array.isArray(state.status.tabs)) updateTabs(state.status.tabs);
      }
    } catch { /* offline */ }
  }

  /* ---------------- boot ---------------- */

  renderTabs();
  refreshStatus();
  connect();
})();
