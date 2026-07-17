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
  const SearchAddon = window.SearchAddon?.SearchAddon || window.SearchAddon;

  const BASE = new URL('.', location.href);
  const api = (p) => new URL(`api/${p}`, BASE).toString();

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs: $('tabs'), tabAdd: $('tab-add'),
    copy: $('btn-copy'), copyMenu: $('menu-copy'), ctxMenu: $('menu-context'),
    tray: $('btn-tray'), trayMenu: $('menu-tray'), trayBadge: $('tray-badge'),
    actions: $('btn-actions'), actionsMenu: $('menu-actions'),
    alerts: $('btn-alerts'), alertsMenu: $('menu-alerts'), alertsBadge: $('alerts-badge'),
    paste: $('btn-paste'), attach: $('btn-attach'), update: $('btn-update'),
    fontDec: $('btn-font-dec'), fontInc: $('btn-font-inc'),
    keys: $('btn-keys'), kiosk: $('btn-kiosk'), help: $('btn-help'),
    search: $('btn-search'), searchBar: $('search-bar'), searchInput: $('search-input'),
    searchCount: $('search-count'), searchPrev: $('search-prev'),
    searchNext: $('search-next'), searchClose: $('search-close'),
    terminal: $('terminal'), dropHint: $('drop-hint'),
    overlay: $('overlay'), overlayText: $('overlay-text'), reconnectNow: $('reconnect-now'),
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
    // Selecting + removing our throwaway textarea otherwise leaves focus on <body>,
    // so the next keystroke after ANY copy path (select-to-copy, the ⧉ menu,
    // right-click, the tray) would go nowhere. Save focus here and restore it — one
    // place covers every caller, and it restores to whoever actually had it.
    const prevFocus = document.activeElement;
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
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
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
        if (copyGesture(text)) term.focus(); else showCopyDialog(text);
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
    // With tmux mouse-on, xterm only makes a LOCAL selection when a drag "forces"
    // it. On Windows/Linux that's Shift+drag (built in); on macOS xterm ignores
    // Shift and instead needs Option(Alt)+drag AND this option (default false) — so
    // set it, or a Mac user can't select-to-copy at all. Coexists with
    // macOptionIsMeta (that's keyboard Option-as-Meta; this is mouse Option+drag).
    macOptionClickForcesSelection: true,
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

  // Find-in-scrollback engine. It highlights every match (decorations) and
  // tracks the active one; the overlay bar (wired in the "find" section below)
  // is pure chrome. Loading it here keeps all the addons together.
  const search = new SearchAddon();
  term.loadAddon(search);

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

  // Copy the selection via the in-gesture cascade. copyGesture already saves to the
  // tray, so if even execCommand can't reach the clipboard we say so out loud rather
  // than failing silently — a silent miss would look exactly like "copy still doesn't
  // work", which is the whole thing this is meant to fix.
  const copySelection = (sel) => {
    // legacyCopy() restores focus itself now, so every copy path (this, the ⧉ menu,
    // right-click, tray) keeps the terminal usable after a copy.
    if (copyGesture(sel)) return;
    pulseTray();
    toast('Saved to tray 📥 — automatic copy unavailable here', { ms: 3500 });
  };

  // Auto-copy the selection on pointer release. Done SYNCHRONOUSLY inside the
  // mouseup/touchend gesture (no setTimeout): a deferred copy loses the user
  // activation, so on plain HTTP — where navigator.clipboard is unavailable — the
  // execCommand('copy') fallback would fail and the text would only reach the tray.
  // xterm updates its selection model synchronously during the pointer events, so
  // hasSelection()/getSelection() are already current here. getSelection() rejoins
  // wrapped lines, so a line that spilled onto several rows copies as one line.
  const maybeCopySelection = (e) => {
    if (e && e.button) return; // left button / touch only — right-click keeps its selection
    if (!term.hasSelection()) return;
    const sel = term.getSelection();
    if (sel.trim()) copySelection(sel);
  };
  els.terminal.addEventListener('mouseup', maybeCopySelection);
  els.terminal.addEventListener('touchend', maybeCopySelection);

  // Shared by the keyboard-copy and find-in-scrollback logic. xterm allows only
  // ONE custom key-event handler, so both live in the single handler registered
  // further down (after the find helpers are defined).
  const isMac = /Mac|iP(hone|ad|od)/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
  );

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

  // While the socket is down (a blip, or the up-to-10s reconnect backoff) the
  // terminal still holds keyboard focus under the "Reconnecting…" overlay, so
  // keystrokes would otherwise vanish with no feedback. Queue user input and
  // flush it in order once the socket reopens — the tmux session is
  // server-resident, so it's the same Claude/shell on the other side. Capped so
  // a long outage can't grow it without bound; resize/select are control
  // messages re-sent fresh on reconnect, so they are never queued.
  const OUT_QUEUE_MAX = 256 * 1024;
  let outQueue = [];
  let outQueueLen = 0;

  function send(obj) {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    } else if (obj?.t === 'in' && typeof obj.d === 'string' && outQueueLen < OUT_QUEUE_MAX) {
      outQueue.push(obj.d);
      outQueueLen += obj.d.length;
    }
  }

  function flushOutQueue() {
    if (!outQueue.length || state.ws?.readyState !== WebSocket.OPEN) return;
    const d = outQueue.join('');
    outQueue = [];
    outQueueLen = 0;
    state.ws.send(JSON.stringify({ t: 'in', d }));
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
  let reconnectAttempts = 0;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts += 1;
    // After a few backed-off tries a bare "Reconnecting…" can read as frozen —
    // soften the wording so a longer outage clearly still means "working on it".
    if (reconnectAttempts >= 3) showOverlay('Still trying to reconnect…');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  }

  // Manual retry — skip whatever backoff is pending and reconnect right now, so
  // the user never waits out the (up to 10s) delay after a blip.
  els.reconnectNow.addEventListener('click', () => {
    reconnectAttempts = 0;
    state.reconnectDelay = 1000;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    showOverlay('Reconnecting…');
    connect();
  });

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
      reconnectAttempts = 0;
      hideOverlay();
      fitToContainer();
      send({ t: 'resize', cols: term.cols, rows: term.rows });
      send({ t: 'select', w: state.currentTab });
      flushOutQueue();
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
      closeSearch();
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
        if (tab.index !== state.currentTab) closeSearch();
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
      closeSearch();
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
    els.actionsMenu.classList.add('hidden');
    els.alertsMenu.classList.add('hidden');
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
  els.actions.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.actionsMenu, els.actions); });
  els.alerts.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = els.alertsMenu.classList.contains('hidden');
    toggleMenu(els.alertsMenu, els.alerts);
    if (opening) renderAlerts();
  });
  document.addEventListener('click', closeMenus);

  // Alerts & notifications viewer. Fetches /api/alerts each time the 🔔 menu
  // opens and renders it with textContent only (never innerHTML) — notification
  // messages come from HA and must never be injected as markup.
  async function renderAlerts() {
    const m = els.alertsMenu;
    const note = (txt, cls) => {
      const d = document.createElement('div');
      d.className = cls || 'menu-note';
      d.textContent = txt;
      m.appendChild(d);
    };
    let data;
    try {
      const r = await fetch(api('alerts'));
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      m.innerHTML = '';
      note("Couldn't load alerts");
      return;
    }
    m.innerHTML = '';
    note(data.enabled
      ? `Proactive alerts on · every ${data.intervalMinutes}m`
      : 'Proactive alerts off');
    const active = Array.isArray(data.active) ? data.active : [];
    setAlertsBadge(active.length, active.some((a) => a && a.critical));
    if (active.length) {
      note('Active', 'menu-section');
      active.forEach((a) => {
        const d = document.createElement('div');
        d.className = `alert-row${a.critical ? ' crit' : ''}`;
        d.textContent = a.line || a.key || '';
        m.appendChild(d);
      });
    } else if (data.enabled) {
      note('✓ No active alerts');
    }
    const notifs = Array.isArray(data.notifications) ? data.notifications : [];
    if (notifs.length) {
      note('Notifications', 'menu-section');
      notifs.slice(0, 10).forEach((n) => {
        const d = document.createElement('div');
        d.className = 'alert-row';
        if (n.title) {
          const b = document.createElement('b');
          b.textContent = `${n.title} `;
          d.appendChild(b);
        }
        d.appendChild(document.createTextNode((n.message || '').replace(/\s+/g, ' ').slice(0, 160)));
        m.appendChild(d);
      });
    }
    if (!active.length && !notifs.length && !data.enabled) {
      note('Turn on Proactive alerts in the add-on options to be warned about leaks, low batteries, doors left open at night, and more.');
    }
  }

  // Toolbar bell badge: the count of currently-active alerts (critical → red),
  // hidden when there are none. Kept fresh by a background poll and by opening
  // the 🔔 menu.
  function setAlertsBadge(count, critical) {
    const b = els.alertsBadge;
    if (!b) return;
    if (count > 0) {
      b.textContent = count > 99 ? '99+' : String(count);
      b.classList.toggle('crit', !!critical);
      b.classList.remove('hidden');
      els.alerts.title = `${count} active alert${count === 1 ? '' : 's'}`;
    } else {
      b.classList.add('hidden');
      b.classList.remove('crit');
      els.alerts.title = 'Alerts & notifications';
    }
  }

  async function refreshAlertsBadge() {
    try {
      const r = await fetch(api('alerts/summary'), { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      setAlertsBadge(Math.max(0, s.count | 0), !!s.critical);
    } catch { /* network blip — leave the badge as it is */ }
  }

  // Append the user's own quick prompts (add-on `quick_prompts` option) to the
  // 💡 menu, once, after the built-in ones. Each is inserted, never auto-run,
  // by the existing menu-actions click handler.
  let customPromptsRendered = false;
  function renderCustomPrompts(prompts) {
    if (customPromptsRendered) return;
    const list = Array.isArray(prompts) ? prompts.filter((p) => typeof p === 'string' && p.trim()) : [];
    if (!list.length) return;
    customPromptsRendered = true;
    const section = document.createElement('div');
    section.className = 'menu-section';
    section.textContent = 'Your prompts';
    els.actionsMenu.appendChild(section);
    for (const p of list) {
      const btn = document.createElement('button');
      btn.className = 'prompt-custom';
      btn.dataset.prompt = p;
      btn.textContent = p;
      btn.title = p;
      els.actionsMenu.appendChild(btn);
    }
  }

  // Quick prompts: insert the chosen prompt text into the terminal WITHOUT a
  // trailing newline, so the user reviews it and presses Enter to send. Nothing
  // ever auto-executes. Same insert path as attached-file paths (send t:'in').
  els.actionsMenu.addEventListener('click', (e) => {
    const prompt = e.target?.dataset?.prompt;
    if (!prompt) return;
    closeMenus();
    send({ t: 'in', d: prompt });
    term.focus();
  });

  // Copy the current terminal selection, with the same clipboard cascade +
  // dialog fallback the copy menu uses. Reused by the right-click menu.
  function copySelectionInteractive() {
    const sel = term.getSelection();
    if (!sel) { toast('Nothing selected — drag to select first', { error: true }); return; }
    // The ⧉ menu and right-click both run closeMenus() first, which blurs focus to
    // <body> before legacyCopy can save/restore it — so refocus the terminal here so
    // typing keeps working after a menu/right-click copy.
    if (copyGesture(sel)) { term.focus(); return; }
    showCopyDialog(sel);
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
    // Non-key actions on the bar (the 🔍 find entry) carry data-act, not a seq.
    if (btn.dataset.act === 'search') {
      openSearch();
      return;
    }
    const seq = btn.dataset.seq;
    if (seq != null) {
      send({ t: 'in', d: withMods(seq) });
      term.focus();
    }
  });

  /* ---------------- find in scrollback ---------------- */

  // Match highlight colours, drawn as terminal decorations. Backgrounds must be
  // solid #RRGGBB (the addon rejects alpha here), so these are the terracotta
  // selection tones flattened onto the near-black canvas: every match gets a
  // dim wash, the active one the vivid terracotta accent so it stands apart.
  const SEARCH_OPTS = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    decorations: {
      matchBackground: '#5a3a2e',
      matchBorder: '#8a5136',
      matchOverviewRuler: '#a05c46',
      activeMatchBackground: '#d97757',
      activeMatchBorder: '#f2b49f',
      activeMatchColorOverviewRuler: '#f2b49f',
    },
  };

  // onDidChangeResults reports the active index (−1 past the highlight cap) and
  // the total; mirror it into the "3 / 17" counter.
  let searchResults = { resultIndex: -1, resultCount: 0 };
  search.onDidChangeResults((r) => {
    searchResults = r;
    renderSearchCount();
  });

  function renderSearchCount() {
    const { resultIndex, resultCount } = searchResults;
    if (!resultCount) {
      els.searchCount.textContent = els.searchInput.value ? 'No results' : '';
    } else if (resultIndex >= 0) {
      els.searchCount.textContent = `${resultIndex + 1} / ${resultCount}`;
    } else {
      // Past the highlight threshold the addon stops tracking the active index.
      els.searchCount.textContent = `${resultCount}+`;
    }
  }

  // findNext/findPrevious wrap around at the ends (addon default). Incremental
  // grows the current selection while typing so the view doesn't jump on each
  // keystroke; the explicit prev/next always step.
  function findNext() {
    if (els.searchInput.value) search.findNext(els.searchInput.value, SEARCH_OPTS);
  }
  function findPrevious() {
    if (els.searchInput.value) search.findPrevious(els.searchInput.value, SEARCH_OPTS);
  }
  function searchIncremental() {
    const q = els.searchInput.value;
    if (!q) { search.clearDecorations(); renderSearchCount(); return; }
    search.findNext(q, { ...SEARCH_OPTS, incremental: true });
  }

  function openSearch() {
    els.searchBar.classList.remove('hidden');
    els.searchInput.focus();
    els.searchInput.select();
    // Reopening with a term still in the box restores its highlights.
    if (els.searchInput.value) searchIncremental();
  }
  function closeSearch() {
    clearTimeout(searchDebounce);
    els.searchBar.classList.add('hidden');
    search.clearDecorations();
    searchResults = { resultIndex: -1, resultCount: 0 };
    renderSearchCount();
    term.focus();
  }

  // Terminal-safe "open find" combo: Cmd+F on macOS (the OS owns Cmd, so a shell/TUI
  // never sees it — we only replace the browser's own Find), or Ctrl+Shift+F anywhere
  // (the GNOME-Terminal / VS Code convention). Plain Ctrl+F is deliberately NOT a find
  // key: it's forward-char in readline and page-forward in less/vim/man.
  const findCombo = (e) => !e.altKey && (e.key === 'f' || e.key === 'F')
    && ((isMac && e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.ctrlKey && e.shiftKey && !e.metaKey));

  let searchDebounce = 0;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(searchIncremental, 120);
  });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrevious(); else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if (findCombo(e)) {
      // Re-pressing the find combo while the bar is open just re-selects the query
      // (and keeps the browser's own Find from popping up over ours).
      e.preventDefault();
      els.searchInput.select();
    }
  });

  els.search.addEventListener('click', openSearch);
  els.searchPrev.addEventListener('click', () => { findPrevious(); els.searchInput.focus(); });
  els.searchNext.addEventListener('click', () => { findNext(); els.searchInput.focus(); });
  els.searchClose.addEventListener('click', closeSearch);

  // The single custom key-event handler (xterm supports only one). It runs before
  // xterm turns a key into input: (1) modifier+Enter inserts a newline instead of
  // submitting; (2) the terminal-safe find combo opens the search bar; (3) the copy
  // combo copies the current selection — synchronously inside the keydown so it works
  // over plain HTTP too. Everything else — including plain Ctrl+C (SIGINT), plain
  // Enter (submit), and plain Ctrl+F — falls straight through untouched.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // (1) Multi-line input — Shift / Alt(Option) / Ctrl / Cmd + Enter inserts a
    // newline in Claude's prompt instead of sending. Every Enter variant reaches
    // xterm as a bare CR (0x0D), which Claude reads as "submit". We instead send
    // LF (0x0A = Ctrl+J): Claude maps CR→submit and LF→newline, and a lone LF is
    // the one newline that survives tmux with no keyboard-protocol setup and no
    // ESC-timing race (an ESC+CR "Alt+Enter" can be split across WebSocket frames,
    // turning it into an Escape keypress + submit). Plain Enter is left untouched,
    // so it still submits. Skip while an IME is composing (Enter commits there).
    if (e.key === 'Enter' && !e.isComposing
        && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send({ t: 'in', d: '\n' });
      return false;
    }
    // (2) Find — Cmd+F (macOS) / Ctrl+Shift+F opens our search bar.
    if (findCombo(e)) {
      e.preventDefault();
      openSearch();
      return false;
    }
    // (2) Copy the selection — Cmd+C on macOS (only when there IS a selection;
    // otherwise it passes through), Ctrl+Shift+C and Ctrl+Insert elsewhere.
    if (!term.hasSelection()) return true;
    const isC = e.key === 'c' || e.key === 'C';
    const copyCombo = (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && isC)
      || (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && isC)
      || (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && e.key === 'Insert');
    if (!copyCombo) return true;
    const sel = term.getSelection();
    if (!sel) return true;
    e.preventDefault();
    copySelection(sel);
    return false;
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
        renderCustomPrompts(state.status.quickPrompts);
      }
    } catch { /* offline */ }
  }

  /* ---------------- boot ---------------- */

  renderTabs();
  refreshStatus();
  refreshAlertsBadge();
  setInterval(refreshAlertsBadge, 60000);
  connect();
})();
