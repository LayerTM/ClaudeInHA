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
    copy: $('btn-copy'), copyMenu: $('menu-copy'), ctxMenu: $('menu-context'),
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
    let ok; // set on both branches of the try/catch below
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
    fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontWeight: 400,
    fontWeightBold: 700,
    // lineHeight 1.0 + letterSpacing 0 keep the TUI's box-drawing seamless;
    // WebGL customGlyphs then draws box/block/powerline glyphs edge-to-edge.
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    scrollback: 10000,
    // Instant, desktop-native scrolling — no animated glide (was the felt lag).
    scrollSensitivity: 3,
    fastScrollSensitivity: 8,
    smoothScrollDuration: 0,
    // Render the hand-tuned palette faithfully (4.5 silently brightened dims).
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: true,
    rescaleOverlappingGlyphs: true,
    allowTransparency: false,
    macOptionIsMeta: true,
    allowProposedApi: true,
    // "Terracotta Noir": near-black cool canvas so Claude's colored output and
    // the terracotta cursor read as vivid jewel tones, not muddy pastels.
    theme: {
      background: '#14141a',
      foreground: '#ede9e0',
      cursor: '#d97757',
      cursorAccent: '#14141a',
      selectionBackground: '#d9775750',
      selectionInactiveBackground: '#d9775724',
      black: '#2a2a33',
      red: '#f15b54',
      green: '#6dd17f',
      yellow: '#e8bc5a',
      blue: '#66aef2',
      magenta: '#c98be8',
      cyan: '#57d6c4',
      white: '#c6c2b9',
      brightBlack: '#62626e',
      brightRed: '#ff867b',
      brightGreen: '#93e6a2',
      brightYellow: '#f6d06b',
      brightBlue: '#8cc5f7',
      brightMagenta: '#dda9f0',
      brightCyan: '#82e6d8',
      brightWhite: '#fbf8f2',
      scrollbarSliderBackground: '#ffffff1f',
      scrollbarSliderHoverBackground: '#ffffff33',
      scrollbarSliderActiveBackground: '#ffffff40',
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

  // withMods() applies any armed sticky Ctrl/Alt from the key bar (defined in
  // the key-bar section below) to what the OS keyboard sends; it is a no-op
  // when no modifier is armed.
  term.onData((d) => send({ t: 'in', d: withMods(d) }));
  // onBinary carries raw bytes that must not round-trip through UTF-8 JSON —
  // ship them as a binary frame (server writes them latin1-preserving).
  term.onBinary((d) => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255));
    }
  });
  term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));

  // xterm 6 dropped the `bellStyle` option — BEL (\x07) now only surfaces via
  // onBell, so the app has to react. Give it a brief border flash, and — when
  // the tab is backgrounded — a toast plus a title badge so a prompt that rings
  // for attention (e.g. a permission ask) isn't missed behind another tab.
  const baseTitle = document.title;
  let bellPending = false;
  let bellFlashTimer = 0;
  term.onBell(() => {
    els.terminal.classList.remove('bell-flash');
    void els.terminal.offsetWidth; // reflow so the flash restarts on rapid bells
    els.terminal.classList.add('bell-flash');
    clearTimeout(bellFlashTimer);
    bellFlashTimer = setTimeout(() => els.terminal.classList.remove('bell-flash'), 450);
    if (document.hidden) {
      toast('🔔 Terminal bell');
      bellPending = true;
      document.title = `🔔 ${baseTitle}`;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && bellPending) {
      bellPending = false;
      document.title = baseTitle;
    }
  });

  // Sizing & reveal — instant, reactive, no timers. The terminal stays hidden
  // (body.booting) until it has both (a) been fitted to a real-sized container
  // and (b) had its webfont settle, so neither the 80x24 default nor a font
  // swap ever flashes. A ResizeObserver then drives every later fit, so panel,
  // window and keybar resizes track in the same frame.
  let sizedOnce = false;
  let fontSettled = false;
  function reveal() {
    if (sizedOnce && fontSettled) document.body.classList.remove('booting');
  }
  function fitToContainer() {
    if (els.terminal.clientWidth <= 1 || els.terminal.clientHeight <= 1) return false;
    try { fit.fit(); } catch { return false; }
    sizedOnce = true;
    reveal();
    return true;
  }
  const scheduleFit = (() => {
    let raf = 0;
    return () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitToContainer);
    };
  })();
  // First fit: `defer` scripts can run a frame before the HA panel lays the
  // iframe out, so retry each animation frame until the container has a real
  // size — then stop and let the observer take over. No arbitrary delays.
  (function firstFit() {
    if (!fitToContainer()) requestAnimationFrame(firstFit);
  })();
  new ResizeObserver(scheduleFit).observe(els.terminal);
  window.addEventListener('resize', scheduleFit);

  // Measure with the real webfont, not a fallback: force-load both weights,
  // then re-fit and rebuild the WebGL glyph atlas so cells and glyphs realign.
  // Gating the reveal on this settling (it always settles — success or failure)
  // means the first frame the user sees is the final font at the final size.
  const fontsReady = document.fonts
    ? Promise.allSettled([
        document.fonts.load(`400 ${savedFont}px "JetBrains Mono"`),
        document.fonts.load(`700 ${savedFont}px "JetBrains Mono"`),
      ])
    : Promise.resolve();
  fontsReady.then(() => {
    fontSettled = true;
    try { term.clearTextureAtlas?.(); } catch { /* DOM renderer */ }
    scheduleFit();
    reveal();
  });
  // Failsafe only: a hidden terminal is worse than an unstyled one. If the
  // normal path never settles (it should within a frame or two), force a fit
  // and reveal so the console is never left invisible.
  setTimeout(() => {
    if (!document.body.classList.contains('booting')) return;
    try { fit.fit(); } catch { /* not ready */ }
    document.body.classList.remove('booting');
  }, 3000);

  function setFontSize(delta) {
    const size = Math.min(28, Math.max(8, term.options.fontSize + delta));
    term.options.fontSize = size;
    localStorage.setItem('cc-font-size', String(size));
    try { term.clearTextureAtlas?.(); } catch { /* DOM renderer */ }
    scheduleFit();
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
      fitToContainer();
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
    els.ctxMenu.classList.add('hidden');
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

  // Copy the current terminal selection, with the same clipboard cascade +
  // dialog fallback the copy menu uses. Reused by the right-click menu.
  function copySelectionInteractive() {
    const sel = term.getSelection();
    if (!sel) { toast('Nothing selected — use Shift+drag', { error: true }); return; }
    if (!copyGesture(sel)) showCopyDialog(sel);
  }

  els.copyMenu.addEventListener('click', async (e) => {
    const kind = e.target?.dataset?.copy;
    if (!kind) return;
    closeMenus();
    if (kind === 'selection') {
      copySelectionInteractive();
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

  // Read the system clipboard and paste into the terminal; on HTTP / WebView /
  // permission-denied contexts where that is blocked, fall back to the paste
  // dialog. Shared by the 📋 button and the right-click menu.
  async function doPaste() {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { term.paste(text); term.focus(); return; }
      } catch { /* permission denied — fall through */ }
    }
    els.pasteInput.value = '';
    els.dlgPaste.showModal();
    els.pasteInput.focus();
  }
  els.paste.addEventListener('click', doPaste);

  $('paste-ok').addEventListener('click', () => {
    const text = els.pasteInput.value;
    els.dlgPaste.close();
    if (text) term.paste(text);
    term.focus();
  });
  $('paste-cancel').addEventListener('click', () => els.dlgPaste.close());

  /* ---------------- right-click menu ---------------- */

  // Anchor the shared `.menu` component at a point (the cursor) and keep it on
  // screen. Unlike the toolbar menus it is positioned by left/top, not right.
  function openContextMenu(x, y) {
    closeMenus();
    const m = els.ctxMenu;
    m.classList.remove('hidden');
    const w = m.offsetWidth || 210;
    const h = m.offsetHeight || 80;
    m.style.right = 'auto';
    m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  }

  els.terminal.addEventListener('contextmenu', (e) => {
    // The browser's own Back/Reload/Inspect/Print menu is the #1 tell that this
    // is a web page, not a terminal — replace it with Copy/Paste. On touch-first
    // devices leave the native long-press selection callout alone.
    if (window.matchMedia?.('(pointer: coarse)')?.matches) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY);
  });

  els.ctxMenu.addEventListener('click', (e) => {
    const kind = e.target?.dataset?.ctx;
    if (!kind) return;
    closeMenus();
    if (kind === 'copy') copySelectionInteractive();
    else if (kind === 'paste') doPaste();
  });

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
    scheduleFit();
  });

  // Sticky modifiers: on a phone there is no physical Ctrl/Alt, so tapping the
  // Ctrl or Alt key-bar button arms that modifier for the NEXT key — typed on
  // the OS keyboard (via term.onData → withMods) or tapped on the key bar — then
  // it auto-releases. This is how touch reaches Ctrl+D/R/L/U/W/K, Alt+B/F, etc.
  const mods = { ctrl: false, alt: false };
  const modButtons = Array.from(els.keybar.querySelectorAll('[data-mod]'));

  function renderMods() {
    modButtons.forEach((b) => b.classList.toggle('active', !!mods[b.dataset.mod]));
  }
  function clearMods() {
    if (!mods.ctrl && !mods.alt) return;
    mods.ctrl = false;
    mods.alt = false;
    renderMods();
  }
  function toggleMod(which) {
    mods[which] = !mods[which];
    renderMods();
  }

  // Ctrl on a printable char → its C0 control code (Ctrl+A = 0x01 … Ctrl+_ =
  // 0x1f, covering @ A–Z [ \ ] ^ _ and, via toUpperCase, a–z). Chars with no
  // control mapping pass through unchanged.
  function ctrlSeq(ch) {
    const code = ch.toUpperCase().charCodeAt(0);
    return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : ch;
  }

  // Apply the armed sticky modifier(s) to input. Alt prefixes with ESC (meta);
  // Ctrl maps to a control code. Only single printable chars are transformed —
  // escape sequences (arrows, Home, …) and multi-char input pass through — but
  // any input consumes the modifier (one-shot, like macOS sticky keys).
  function withMods(seq) {
    if (!mods.ctrl && !mods.alt) return seq;
    let out = seq;
    if (seq.length === 1 && seq >= ' ') {
      if (mods.ctrl) out = ctrlSeq(out);
      if (mods.alt) out = `\x1b${out}`;
    }
    clearMods();
    return out;
  }

  els.keybar.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (!btn || !els.keybar.contains(btn)) return;
    if (btn.dataset.mod) {
      toggleMod(btn.dataset.mod);
      term.focus();
      return;
    }
    const seq = btn.dataset.seq;
    if (seq != null) {
      send({ t: 'in', d: withMods(seq) });
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
    scheduleFit();
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
