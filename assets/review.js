/* Режим правок поверх сайта: заметки, рисунки, картинки.
 *
 * Включается только ссылкой с ?review=1, дальше держится в sessionStorage вкладки —
 * переходы по сайту режим не сбрасывают. Посетители без параметра этот файл даже не
 * загружают: загрузчик — одна строка в <head> каждой страницы.
 *
 * Ничего никуда не отправляет. Правки лежат в localStorage этого браузера; наружу —
 * только текстом в буфер обмена или файлом, который человек скачал сам.
 *
 * Каждая правка привязана к элементу страницы (CSS-путь + его координаты в момент
 * постановки), поэтому при подгрузке картинок, другой ширине окна или прокрутке окна
 * заявки метка едет вместе со своим блоком. По скачанному файлу
 * bti-lab/tools/review-render.mjs снимает скриншоты с метками.
 */
(() => {
  'use strict';
  if (window.__btiReview) return;

  const KEY = 'bti_review_v1';
  const HINT_KEY = 'bti_review_hint_v1';
  const FLAG = 'bti_review';
  const GOTO = 'bti_review_goto';
  const NS = 'http://www.w3.org/2000/svg';
  const RENDER_ONLY = /[?&]rv_render=1/.test(location.search);
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const PAGE = decodeURIComponent(location.pathname.split('/').pop() || '') || 'index.dc.html';
  const PAGE_NAMES = {
    'index.dc.html': 'Главная',
    'mezhevanie.dc.html': 'Межевание',
    'tehplan.dc.html': 'Технический план',
    'razdel-obedinenie.dc.html': 'Раздел и объединение',
    'politika.dc.html': 'Политика конфиденциальности',
  };
  const PART_NAMES = { Header: 'Шапка', Footer: 'Подвал', LeadModal: 'Окно заявки' };
  const pageName = (p) => PAGE_NAMES[p] || p;

  try { sessionStorage.setItem(FLAG, '1'); } catch {}

  // ---------- хранилище ----------
  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && Array.isArray(s.items)) return s;
    } catch {}
    return { v: 1, items: [] };
  };
  let state = load();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch {
      toast('Браузеру не хватает места. Скачайте файл с правками и удалите часть картинок.', 7000);
      return false;
    }
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const numberOf = (it) => state.items.indexOf(it) + 1;
  const r1 = (v) => Math.round(v * 10) / 10;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeImg = (v) => typeof v === 'string' && v.startsWith('data:image/');
  const isUi = (el) => !!(el && el.closest && el.closest('[data-rv-ui]'));
  const h = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    e.setAttribute('data-rv-ui', '');
    return e;
  };

  // ---------- привязка к элементу ----------
  const elementAt = (cx, cy) => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (isUi(el) || el === document.documentElement || el === document.body) continue;
      if (el instanceof SVGElement) {
        // Внутренности SVG ищутся селектором ненадёжно — берём сам внешний <svg>.
        let top = el.closest('svg');
        while (top && top.parentElement && top.parentElement.closest('svg')) top = top.parentElement.closest('svg');
        return top || el;
      }
      return el;
    }
    return document.body;
  };

  const selectorOf = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        return parts.join(' > ');
      }
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    parts.unshift('body');
    return parts.join(' > ');
  };

  const inFixed = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === 'fixed') return true;
    }
    return false;
  };

  const describe = (el, py) => {
    let near = '';
    if (el.tagName === 'IMG') {
      near = norm(el.alt) ? 'картинки «' + cut(norm(el.alt), 60) + '»' : 'картинки ' + (el.getAttribute('src') || '').split('/').pop();
    } else {
      for (let n = el, k = 0; n && n !== document.body && k < 4; n = n.parentElement, k++) {
        const t = norm(n.textContent);
        if (t) { near = '«' + cut(t, 90) + '»'; break; }
      }
    }
    let part = '';
    const host = el.closest('[data-sc-name]');
    const hostName = host && host.getAttribute('data-sc-name');
    if (PART_NAMES[hostName]) part = PART_NAMES[hostName];
    else {
      // Секции на сайте — div с id, а не <section>, поэтому блок называем по ближайшему
      // видимому заголовку h1–h3, который стоит на странице выше отмеченной точки.
      let best = -Infinity;
      for (const x of document.querySelectorAll('h1, h2, h3')) {
        if (isUi(x) || !x.getClientRects().length || inFixed(x)) continue;
        const top = x.getBoundingClientRect().top + scrollY;
        if (top <= py + 4 && top > best) { best = top; part = cut(norm(x.textContent), 70); }
      }
    }
    return { near, part };
  };

  const makeAnchor = (cx, cy) => {
    const el = elementAt(cx, cy);
    const r = el.getBoundingClientRect();
    const d = describe(el, cy + scrollY);
    const a = { sel: selectorOf(el), ex: r1(r.left + scrollX), ey: r1(r.top + scrollY), near: d.near, part: d.part };
    if (inFixed(el)) a.fixed = 1;
    return a;
  };

  // Насколько блок уехал с момента постановки правки. null — блок сейчас скрыт.
  const shiftOf = (a) => {
    if (!a) return { dx: 0, dy: 0 };
    let el = null;
    try { el = document.querySelector(a.sel); } catch {}
    if (!el) return a.fixed ? null : { dx: 0, dy: 0 };
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { dx: r.left + scrollX - a.ex, dy: r.top + scrollY - a.ey };
  };

  const bbox = (strokes) => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of strokes) for (const [x, y] of s) {
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };
  const pathD = (pts) => 'M' + pts.map((p) => p[0] + ' ' + p[1]).join('L');

  const where = (it) => {
    const a = it.a || {};
    const out = [];
    if (a.part) out.push('блок «' + a.part + '»');
    if (a.near && a.near !== '«' + a.part + '»') out.push('у ' + a.near);
    return out.join(', ');
  };

  // ---------- разметка ----------
  const ICONS = {
    note: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H10l-6 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
    draw: '<svg viewBox="0 0 24 24"><path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19z"/><path d="M13.5 7l3.5 3.5"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 6L4 11l5 5"/><path d="M4 11h10a5 5 0 010 10h-3"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/></svg>',
  };

  const CSS_TEXT = `
[data-rv-ui],[data-rv-ui] *{box-sizing:border-box}
.rv-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000;pointer-events:none}
.rv-svg{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
.rv-svg path{fill:none;stroke-linecap:round;stroke-linejoin:round}
.rv-halo{stroke:#fff;stroke-width:8;stroke-opacity:.85}
.rv-ink{stroke:#E5261B;stroke-width:4}
.rv-pins{position:absolute;left:0;top:0;width:0;height:0}
.rv-pin{position:absolute;width:max-content;display:flex;align-items:flex-start;gap:6px;transform:translate(-13px,-13px);pointer-events:auto;cursor:pointer;font:600 12px/1.35 Manrope,system-ui,sans-serif;color:#fff}
.rv-pin--left{flex-direction:row-reverse;transform:translate(calc(-100% + 13px),-13px)}
.rv-num{flex:none;width:26px;height:26px;border-radius:50%;background:#E5261B;color:#fff;display:grid;place-items:center;font:800 12px/1 Manrope,system-ui,sans-serif;box-shadow:0 0 0 2px #fff,0 2px 8px rgba(0,0,0,.35)}
.rv-label{display:block;max-width:min(240px,62vw);background:#121212;color:#fff;padding:5px 8px;box-shadow:0 2px 10px rgba(0,0,0,.3);text-align:left}
.rv-ltext{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.rv-label img{display:block;max-width:100%;max-height:90px;margin-top:4px}
.rv-flash .rv-num{animation:rv-flash .9s ease 2}
@keyframes rv-flash{50%{transform:scale(1.7)}}
.rv-capture{position:fixed;inset:0;z-index:2147482990;display:none;cursor:crosshair;background:rgba(229,38,27,.035)}
.rv-capture--note{display:block;touch-action:pan-x pan-y pinch-zoom}
.rv-capture--draw{display:block;touch-action:none}
.rv-bar{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483100;display:flex;gap:2px;padding:4px;background:#121212;box-shadow:0 8px 28px rgba(0,0,0,.4);font:600 12px/1 Manrope,system-ui,sans-serif}
.rv-bar button{appearance:none;-webkit-appearance:none;margin:0;border:0;border-radius:0;background:transparent;color:#EEF0EC;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 10px 7px;min-width:74px;cursor:pointer;font:inherit;letter-spacing:0;text-transform:none}
.rv-bar button:hover{background:#2a2a2a}
.rv-bar button[aria-pressed="true"]{background:#E5261B;color:#fff}
.rv-bar svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.rv-count{display:inline-block;min-width:16px;margin-left:3px;padding:1px 4px;background:#E5261B;color:#fff;font-weight:800}
.rv-bar button[aria-pressed="true"] .rv-count{background:#121212}
.rv-modehint,.rv-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(88px + env(safe-area-inset-bottom));z-index:2147483100;max-width:calc(100vw - 24px);width:max-content;padding:8px 12px;background:#E5261B;color:#fff;font:600 13px/1.35 Manrope,system-ui,sans-serif;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.3);display:none;pointer-events:none}
.rv-toast{background:#121212;bottom:calc(128px + env(safe-area-inset-bottom));pointer-events:auto;align-items:center;gap:12px}
.rv-modehint.rv-show{display:block}
.rv-toast.rv-show{display:flex}
.rv-toast button{appearance:none;border:0;background:none;color:#FF8A80;font:800 13px/1 Manrope,system-ui,sans-serif;cursor:pointer;padding:4px 0}
.rv-card{position:fixed;z-index:2147483200;background:#fff;color:#121212;box-shadow:0 14px 44px rgba(0,0,0,.4);font:500 14px/1.4 Manrope,system-ui,sans-serif;text-align:left;letter-spacing:0;text-transform:none}
.rv-card b{font-weight:800}
.rv-editor{left:50%;top:calc(12px + env(safe-area-inset-top));transform:translateX(-50%);width:min(460px,calc(100vw - 24px));padding:12px}
.rv-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.rv-head span{color:#666;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-x{appearance:none;border:0;background:none;color:#121212;font:400 26px/1 system-ui,sans-serif;width:36px;height:36px;margin:-6px -6px -6px 0;cursor:pointer;flex:none;padding:0}
.rv-editor textarea{display:block;width:100%;min-height:88px;margin:0;padding:10px;border:1px solid #121212;border-radius:0;background:#fff;color:#121212;font:500 16px/1.4 Manrope,system-ui,sans-serif;resize:vertical;outline:none}
.rv-editor textarea:focus{border-color:#E5261B;box-shadow:0 0 0 1px #E5261B}
.rv-img{display:flex;align-items:flex-start;gap:8px;margin-top:8px}
.rv-img img{max-width:120px;max-height:90px;border:1px solid #ddd}
.rv-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px}
.rv-sp{flex:1}
.rv-btn{appearance:none;-webkit-appearance:none;position:relative;display:inline-flex;align-items:center;margin:0;border:1px solid #121212;border-radius:0;background:#fff;color:#121212;padding:10px 12px;font:700 13px/1 Manrope,system-ui,sans-serif;letter-spacing:0;text-transform:none;cursor:pointer;text-decoration:none;overflow:hidden}
.rv-btn:disabled{opacity:.4;cursor:default}
.rv-btn--red{background:#E5261B;border-color:#E5261B;color:#fff}
.rv-btn--ghost{border-color:transparent;background:transparent}
.rv-file{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
.rv-panel{right:12px;bottom:calc(92px + env(safe-area-inset-bottom));width:min(430px,calc(100vw - 24px));max-height:min(72vh,660px);display:flex;flex-direction:column}
.rv-panel .rv-head{padding:12px 12px 0}
.rv-pbody{overflow:auto;padding:0 12px;flex:1;min-height:0}
.rv-page{margin:12px 0 4px;color:#666;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.rv-item{display:flex;align-items:flex-start;border-top:1px solid #e3e3e3}
.rv-go{appearance:none;flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start;border:0;background:none;padding:10px 0;text-align:left;color:#121212;font:500 14px/1.4 Manrope,system-ui,sans-serif;cursor:pointer}
.rv-go .rv-num{width:22px;height:22px;font-size:11px;box-shadow:none}
.rv-go span{min-width:0}
.rv-go small{display:block;color:#777;font-size:12px;margin-top:2px;overflow-wrap:anywhere}
.rv-go i{font-style:normal;color:#E5261B;font-weight:700}
.rv-item .rv-x{margin:4px 0 0}
.rv-empty{color:#666;margin:14px 0}
.rv-pfoot{display:flex;flex-wrap:wrap;gap:6px;padding:12px;border-top:1px solid #e3e3e3}
.rv-intro{left:50%;bottom:calc(92px + env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100vw - 24px));padding:14px 16px}
.rv-intro p{margin:8px 0 0}
.rv-intro .rv-btn{margin-top:12px}
@media (max-width:720px){
  .rv-bar{bottom:calc(72px + env(safe-area-inset-bottom))}
  .rv-bar button{min-width:66px;padding:8px 6px 7px}
  .rv-modehint{bottom:calc(146px + env(safe-area-inset-bottom))}
  .rv-toast{bottom:calc(186px + env(safe-area-inset-bottom))}
  .rv-panel{left:12px;right:12px;width:auto;bottom:calc(150px + env(safe-area-inset-bottom));max-height:calc(100vh - 170px)}
  .rv-intro{bottom:calc(150px + env(safe-area-inset-bottom))}
}
.rv-render .rv-bar,.rv-render .rv-modehint,.rv-render .rv-toast,.rv-render .rv-intro{display:none!important}
`;

  let styleEl, root, svg, pinsBox, capture, bar, modeHint, toastEl, panel = null, editor = null;
  let mode = null;
  let curDraw = null;
  let alive = true;
  const nodes = new Map();
  const ac = new AbortController();
  const on = (t, ev, fn, o) => t.addEventListener(ev, fn, Object.assign({ signal: ac.signal }, o || {}));

  const mount = () => {
    styleEl = h('style', null, CSS_TEXT);
    document.head.appendChild(styleEl);
    root = h('div', 'rv-root');
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'rv-svg');
    svg.setAttribute('data-rv-ui', '');
    pinsBox = h('div', 'rv-pins');
    root.append(svg, pinsBox);
    capture = h('div', 'rv-capture');
    modeHint = h('div', 'rv-modehint');
    toastEl = h('div', 'rv-toast');
    bar = h('div', 'rv-bar',
      `<button type="button" data-act="note" aria-pressed="false">${ICONS.note}<span>Заметка</span></button>` +
      `<button type="button" data-act="draw" aria-pressed="false">${ICONS.draw}<span>Рисунок</span></button>` +
      `<button type="button" data-act="undo">${ICONS.undo}<span>Отменить</span></button>` +
      `<button type="button" data-act="list" aria-pressed="false">${ICONS.list}<span>Правки<b class="rv-count">0</b></span></button>`);
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Режим правок');
    document.body.append(root, capture, modeHint, toastEl, bar);
    if (RENDER_ONLY) document.documentElement.classList.add('rv-render');
  };
  const ensureMounted = () => {
    for (const n of [root, capture, modeHint, toastEl, bar]) if (!n.isConnected) document.body.appendChild(n);
  };

  // ---------- отрисовка меток ----------
  const layerOffset = () => {
    const r = root.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY };
  };

  const pinHtml = (it, n) => {
    let s = '<span class="rv-num">' + n + '</span>';
    if (it.text || it.img) {
      s += '<span class="rv-label">' + (it.text ? '<span class="rv-ltext">' + esc(it.text) + '</span>' : '') +
        (safeImg(it.img) ? '<img alt="" src="' + esc(it.img) + '">' : '') + '</span>';
    }
    return s;
  };

  const render = () => {
    if (!alive || !root) return;
    ensureMounted();
    const off = layerOffset();
    const docW = document.documentElement.clientWidth;
    const seen = new Set();
    state.items.forEach((it, i) => {
      if (it.page !== PAGE) return;
      seen.add(it.id);
      const n = i + 1;
      const sig = [n, it.text || '', it.img ? 1 : 0, it.type === 'draw' ? it.strokes.length : 0].join('|');
      let node = nodes.get(it.id);
      if (!node) {
        node = { pin: h('div', 'rv-pin'), g: null, sig: '' };
        node.pin.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = state.items.find((x) => x.id === it.id);
          if (cur) openEditor(cur, false);
        });
        pinsBox.appendChild(node.pin);
        if (it.type === 'draw') {
          node.g = document.createElementNS(NS, 'g');
          svg.appendChild(node.g);
        }
        nodes.set(it.id, node);
      }
      if (node.sig !== sig) {
        node.sig = sig;
        node.pin.innerHTML = pinHtml(it, n);
        node.pin.title = 'Правка ' + n + (it.text ? ': ' + it.text : '');
        if (node.g) {
          const d = it.strokes.map(pathD).join(' ');
          node.g.innerHTML = '<path class="rv-halo" d="' + d + '"/><path class="rv-ink" d="' + d + '"/>';
          node.box = it.strokes.length ? bbox(it.strokes) : null;
        }
      }
      const s = shiftOf(it.a);
      if (!s || (node.g && !node.box)) {
        node.pin.style.display = 'none';
        if (node.g) node.g.style.display = 'none';
        return;
      }
      const tx = s.dx - off.x;
      const ty = s.dy - off.y;
      let px, py;
      if (node.g) {
        node.g.style.display = '';
        node.g.setAttribute('transform', 'translate(' + r1(tx) + ' ' + r1(ty) + ')');
        px = node.box.x + tx;
        py = node.box.y + ty;
      } else {
        px = it.x + tx;
        py = it.y + ty;
      }
      node.pin.style.display = '';
      node.pin.style.left = r1(px) + 'px';
      node.pin.style.top = r1(py) + 'px';
      node.pin.classList.toggle('rv-pin--left', px + off.x > docW - 270);
    });
    for (const [id, node] of nodes) {
      if (seen.has(id)) continue;
      node.pin.remove();
      if (node.g) node.g.remove();
      nodes.delete(id);
    }
  };

  let raf = 0;
  const schedule = () => {
    if (!raf && alive) raf = requestAnimationFrame(() => { raf = 0; render(); });
  };

  const refreshBar = () => {
    const c = bar.querySelector('.rv-count');
    if (c) c.textContent = String(state.items.length);
    if (panel) fillPanel();
  };

  const boxOf = (id) => {
    const node = nodes.get(id);
    if (!node || node.pin.style.display === 'none') return null;
    const rs = [node.pin.getBoundingClientRect()];
    if (node.g) rs.push(node.g.getBoundingClientRect());
    const x1 = Math.min(...rs.map((r) => r.left)), y1 = Math.min(...rs.map((r) => r.top));
    const x2 = Math.max(...rs.map((r) => r.right)), y2 = Math.max(...rs.map((r) => r.bottom));
    return { x: x1 + scrollX, y: y1 + scrollY, w: x2 - x1, h: y2 - y1 };
  };

  // ---------- сообщения ----------
  let toastTimer = 0;
  const toast = (msg, ms, action) => {
    if (!toastEl) return;
    toastEl.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    if (action) toastEl.querySelector('button').onclick = () => { toastEl.classList.remove('rv-show'); action.run(); };
    toastEl.classList.add('rv-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('rv-show'), ms || 2800);
  };

  const removeItem = (it, silent) => {
    const idx = state.items.indexOf(it);
    if (idx === -1) return;
    const n = idx + 1;
    state.items.splice(idx, 1);
    if (curDraw === it) curDraw = null;
    save();
    render();
    refreshBar();
    if (!silent) {
      toast('Правка ' + n + ' удалена', 5000, {
        label: 'Вернуть',
        run: () => { state.items.splice(Math.min(idx, state.items.length), 0, it); save(); render(); refreshBar(); },
      });
    }
  };

  // ---------- режимы ----------
  const setMode = (m) => {
    if (mode === 'draw' && m !== 'draw') finishDrawing();
    mode = m;
    capture.className = 'rv-capture' + (m ? ' rv-capture--' + m : '');
    bar.querySelector('[data-act="note"]').setAttribute('aria-pressed', String(m === 'note'));
    bar.querySelector('[data-act="draw"]').setAttribute('aria-pressed', String(m === 'draw'));
    modeHint.textContent = m === 'note'
      ? 'Нажмите на место, к которому нужна заметка'
      : m === 'draw'
        ? (COARSE ? 'Рисуйте пальцем. Прокрутка — двумя пальцами. Готово — снова «Рисунок»' : 'Рисуйте мышью. Прокрутка — колесом. Готово — снова «Рисунок»')
        : '';
    modeHint.classList.toggle('rv-show', !!m);
  };

  const finishDrawing = () => {
    const it = curDraw;
    curDraw = null;
    if (it && state.items.includes(it)) openEditor(it, true);
  };

  // Заметка: тап по месту.
  const placeNote = (e) => {
    if (mode !== 'note') return;
    const a = makeAnchor(e.clientX, e.clientY);
    const it = { id: uid(), type: 'note', page: PAGE, vw: innerWidth, t: Date.now(), text: '', x: r1(e.clientX + scrollX), y: r1(e.clientY + scrollY), a };
    state.items.push(it);
    save();
    render();
    refreshBar();
    openEditor(it, true);
  };

  // Рисунок: один палец/мышь рисует, два пальца прокручивают.
  const pointers = new Map();
  let live = null;
  let pan = null;
  const mid = () => {
    const ps = [...pointers.values()];
    return { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
  };
  const livePaths = () => {
    const off = layerOffset();
    const d = pathD(live.pts.map(([x, y]) => [r1(x - off.x), r1(y - off.y)]));
    live.halo.setAttribute('d', d);
    live.ink.setAttribute('d', d);
  };
  const startStroke = (e) => {
    const halo = document.createElementNS(NS, 'path');
    const ink = document.createElementNS(NS, 'path');
    halo.setAttribute('class', 'rv-halo');
    ink.setAttribute('class', 'rv-ink');
    svg.append(halo, ink);
    live = { id: e.pointerId, pts: [[r1(e.clientX + scrollX), r1(e.clientY + scrollY)]], halo, ink };
    livePaths();
  };
  const dropLive = () => {
    if (!live) return;
    live.halo.remove();
    live.ink.remove();
    live = null;
  };
  const finishStroke = () => {
    const pts = live.pts;
    dropLive();
    if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5]);
    if (!curDraw || !state.items.includes(curDraw)) {
      const b = bbox([pts]);
      const cx = Math.min(Math.max(b.x + b.w / 2 - scrollX, 1), innerWidth - 1);
      const cy = Math.min(Math.max(b.y + b.h / 2 - scrollY, 1), innerHeight - 1);
      curDraw = { id: uid(), type: 'draw', page: PAGE, vw: innerWidth, t: Date.now(), text: '', strokes: [], a: makeAnchor(cx, cy) };
      state.items.push(curDraw);
    }
    // Точки храним в системе координат момента постановки правки.
    const s = shiftOf(curDraw.a) || { dx: 0, dy: 0 };
    curDraw.strokes.push(pts.map(([x, y]) => [r1(x - s.dx), r1(y - s.dy)]));
    save();
    render();
    refreshBar();
  };

  const onDown = (e) => {
    if (mode !== 'draw') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { capture.setPointerCapture(e.pointerId); } catch {}
    const wasEmpty = pointers.size === 0;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && wasEmpty) startStroke(e);
    else if (pointers.size === 2) { dropLive(); pan = mid(); }
  };
  const onMove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pan && pointers.size >= 2) {
      const m = mid();
      scrollBy(pan.x - m.x, pan.y - m.y);
      pan = m;
      return;
    }
    if (!live || live.id !== e.pointerId) return;
    const p = [r1(e.clientX + scrollX), r1(e.clientY + scrollY)];
    const last = live.pts[live.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
    live.pts.push(p);
    livePaths();
  };
  const onUp = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (live && live.id === e.pointerId) {
      if (e.type === 'pointercancel') dropLive();
      else finishStroke();
    }
    if (pointers.size < 2) pan = null;
  };

  const undo = () => {
    if (mode === 'draw' && curDraw && state.items.includes(curDraw)) {
      curDraw.strokes.pop();
      if (!curDraw.strokes.length) { removeItem(curDraw, true); curDraw = null; }
      else { save(); render(); }
      toast('Последний штрих убран');
      return;
    }
    const mine = state.items.filter((i) => i.page === PAGE);
    if (!mine.length) { toast('На этой странице правок нет'); return; }
    closeEditor(false);
    removeItem(mine[mine.length - 1]);
  };

  // ---------- окно правки ----------
  let edItem = null, edNew = false, edImg = null;
  const shrinkImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });

  const drawEdImg = () => {
    const box = editor && editor.querySelector('.rv-img');
    if (!box) return;
    box.innerHTML = safeImg(edImg) ? '<img alt="" src="' + esc(edImg) + '"><button type="button" class="rv-btn rv-btn--ghost" data-act="noimg">Убрать картинку</button>' : '';
  };

  const openEditor = (it, isNew) => {
    closeEditor(true);
    if (!state.items.includes(it)) return;
    edItem = it;
    edNew = !!isNew;
    edImg = it.img || null;
    const isDraw = it.type === 'draw';
    const w = where(it);
    editor = h('div', 'rv-card rv-editor',
      '<div class="rv-head"><b>Правка ' + numberOf(it) + '</b><span>' + (isDraw ? 'рисунок' : 'заметка') + (w ? ' · ' + esc(w) : '') + '</span>' +
      '<button type="button" class="rv-x" data-act="cancel" aria-label="Закрыть">×</button></div>' +
      '<textarea rows="3" placeholder="' + (isDraw ? 'Комментарий к рисунку — можно оставить пустым' : 'Что поменять? Например: «убрать блок», «цену сделать 9 000 ₽»') + '"></textarea>' +
      '<div class="rv-img"></div>' +
      '<div class="rv-row"><span class="rv-btn rv-btn--ghost">+ Картинка<input class="rv-file" type="file" accept="image/*" aria-label="Приложить картинку"></span>' +
      '<span class="rv-sp"></span>' +
      '<button type="button" class="rv-btn rv-btn--ghost" data-act="del">Удалить</button>' +
      '<button type="button" class="rv-btn rv-btn--red" data-act="ok">Сохранить</button></div>');
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-label', 'Правка ' + numberOf(it));
    const ta = editor.querySelector('textarea');
    ta.value = it.text || '';
    editor.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'ok') closeEditor(true);
      else if (act === 'cancel') closeEditor(false);
      else if (act === 'del') { const cur = edItem; closeEditor(false, true); removeItem(cur); }
      else if (act === 'noimg') { edImg = null; drawEdImg(); }
    });
    editor.querySelector('.rv-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { edImg = await shrinkImage(f); drawEdImg(); } catch { toast('Не получилось открыть картинку'); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeEditor(true); }
    });
    document.body.appendChild(editor);
    drawEdImg();
    if (!RENDER_ONLY) setTimeout(() => { try { ta.focus({ preventScroll: true }); } catch {} }, 30);
  };

  const closeEditor = (commit, skipSave) => {
    if (!editor) return;
    const it = edItem, wasNew = edNew, img = edImg;
    const text = editor.querySelector('textarea').value.trim();
    editor.remove();
    editor = null;
    edItem = null;
    edImg = null;
    if (skipSave || !state.items.includes(it)) return;
    if (commit) {
      it.text = text;
      if (img) it.img = img; else delete it.img;
    }
    if (it.type === 'note' && !it.text && !it.img && (wasNew || commit)) {
      removeItem(it, true);
      if (commit && !wasNew) toast('Пустая заметка удалена');
      return;
    }
    save();
    render();
    refreshBar();
  };

  // ---------- список правок ----------
  const groups = () => {
    const by = new Map();
    for (const it of state.items) {
      if (!by.has(it.page)) by.set(it.page, []);
      by.get(it.page).push(it);
    }
    const order = Object.keys(PAGE_NAMES);
    return [...by.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  };

  const fileName = () => {
    const d = new Date();
    const p = (v) => String(v).padStart(2, '0');
    return 'bti-pravki-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '.json';
  };
  const exportJson = () => JSON.stringify({
    tool: 'bti-review',
    v: 1,
    exportedAt: new Date().toISOString(),
    site: location.origin + location.pathname.replace(/[^/]*$/, ''),
    ua: navigator.userAgent,
    items: state.items.map((it, i) => Object.assign({ n: i + 1, pageName: pageName(it.page) }, it)),
  });
  const asText = () => {
    const lines = ['Правки к сайту «Кадастровый инженер · ИП Баймурзин А.Р.»', new Date().toLocaleString('ru-RU') + ' · правок: ' + state.items.length, ''];
    for (const [page, items] of groups()) {
      lines.push(pageName(page) + ' (' + page + ')');
      for (const it of items) {
        let s = numberOf(it) + '. ' + (it.type === 'draw' ? '[рисунок] ' : '') + (it.text || (it.type === 'draw' ? 'без комментария' : ''));
        const w = where(it);
        if (w) s += '\n   где: ' + w;
        if (it.img) s += '\n   + приложена картинка';
        lines.push(s);
      }
      lines.push('');
    }
    if (state.items.some((i) => i.type === 'draw' || i.img)) lines.push('Рисунки и картинки — в файле: «Правки» → «Скачать файл».');
    return lines.join('\n').trim();
  };
  const canShareFiles = () => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })); } catch { return false; }
  };

  const copyText = async () => {
    const txt = asText();
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch {}
    if (!ok) {
      const ta = h('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
    }
    toast(ok ? 'Текст скопирован — вставьте его в чат' : 'Не получилось скопировать — скачайте файл', 4000);
  };
  const downloadFile = () => {
    const name = fileName();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    a.download = name;
    a.setAttribute('data-rv-ui', '');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast('Файл сохранён в «Загрузки»: ' + name, 5000);
  };
  const shareFile = async () => {
    const f = new File([exportJson()], fileName(), { type: 'application/json' });
    try { await navigator.share({ files: [f], title: 'Правки к сайту', text: asText() }); } catch {}
  };

  const fillPanel = () => {
    const total = state.items.length;
    let html = '<div class="rv-head"><b>Правки · ' + total + '</b><span></span><button type="button" class="rv-x" data-act="close" aria-label="Закрыть">×</button></div><div class="rv-pbody">';
    if (!total) html += '<p class="rv-empty">Пока пусто. Нажмите «Заметка» или «Рисунок» и отметьте, что поменять.</p>';
    for (const [page, items] of groups()) {
      html += '<div class="rv-page">' + esc(pageName(page)) + (page === PAGE ? ' · эта страница' : '') + '</div>';
      for (const it of items) {
        const n = numberOf(it);
        const body = (it.type === 'draw' ? '<i>рисунок</i> ' : '') + esc(it.text || (it.type === 'draw' ? 'без комментария' : '—')) + (it.img ? ' <i>+ картинка</i>' : '');
        html += '<div class="rv-item"><button type="button" class="rv-go" data-go="' + esc(it.id) + '"><span class="rv-num">' + n + '</span><span>' + body +
          '<small>' + esc(where(it)) + '</small></span></button>' +
          '<button type="button" class="rv-x" data-del="' + esc(it.id) + '" aria-label="Удалить правку ' + n + '">×</button></div>';
      }
    }
    const dis = total ? '' : ' disabled';
    html += '</div><div class="rv-pfoot">' +
      '<button type="button" class="rv-btn rv-btn--red" data-act="copy"' + dis + '>Скопировать текст</button>' +
      '<button type="button" class="rv-btn" data-act="file"' + dis + '>Скачать файл</button>' +
      (canShareFiles() ? '<button type="button" class="rv-btn" data-act="share"' + dis + '>Отправить…</button>' : '') +
      '<button type="button" class="rv-btn rv-btn--ghost" data-act="clear"' + dis + '>Удалить все</button>' +
      '<button type="button" class="rv-btn rv-btn--ghost" data-act="exit">Выйти из режима правок</button></div>';
    panel.innerHTML = html;
  };

  const openPanel = () => {
    setMode(null);
    closeEditor(true);
    panel = h('div', 'rv-card rv-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Список правок');
    panel.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { goTo(go.getAttribute('data-go')); return; }
      const del = e.target.closest('[data-del]');
      if (del) { const it = state.items.find((x) => x.id === del.getAttribute('data-del')); if (it) removeItem(it); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'close') closePanel();
      else if (act === 'copy') copyText();
      else if (act === 'file') downloadFile();
      else if (act === 'share') shareFile();
      else if (act === 'clear') {
        if (confirm('Удалить все правки (' + state.items.length + ')? Вернуть их будет нельзя.')) {
          state.items = [];
          curDraw = null;
          save();
          render();
          refreshBar();
        }
      } else if (act === 'exit') exit();
    });
    fillPanel();
    document.body.appendChild(panel);
    bar.querySelector('[data-act="list"]').setAttribute('aria-pressed', 'true');
  };
  const closePanel = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    bar.querySelector('[data-act="list"]').setAttribute('aria-pressed', 'false');
  };

  const reveal = (id) => {
    render();
    const b = boxOf(id);
    if (!b) { toast('Этот блок сейчас скрыт — откройте меню или окно, где ставилась правка', 5000); return; }
    scrollTo({ top: Math.max(0, b.y + b.h / 2 - innerHeight / 2), behavior: 'smooth' });
    const node = nodes.get(id);
    node.pin.classList.remove('rv-flash');
    void node.pin.offsetWidth;
    node.pin.classList.add('rv-flash');
  };
  const goTo = (id) => {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    if (it.page !== PAGE) {
      try { sessionStorage.setItem(GOTO, id); } catch {}
      location.href = it.page;
      return;
    }
    closePanel();
    reveal(id);
  };

  const showIntro = () => {
    const box = h('div', 'rv-card rv-intro',
      '<b>Режим правок</b>' +
      '<p><b>Заметка</b> — нажмите на нужное место и напишите, что поменять. К заметке можно приложить картинку.</p>' +
      '<p><b>Рисунок</b> — обведите или дорисуйте прямо поверх сайта.</p>' +
      '<p>Всё хранится только в этом браузере, посетители сайта ничего не видят. Закончили — <b>Правки</b> → «Скопировать текст» или «Скачать файл».</p>' +
      '<button type="button" class="rv-btn rv-btn--red">Понятно</button>');
    box.querySelector('button').addEventListener('click', () => {
      box.remove();
      try { localStorage.setItem(HINT_KEY, '1'); } catch {}
    });
    document.body.appendChild(box);
  };

  const exit = () => {
    closeEditor(true);
    closePanel();
    setMode(null);
    alive = false;
    ac.abort();
    ro.disconnect();
    mo.disconnect();
    try { sessionStorage.removeItem(FLAG); } catch {}
    document.querySelectorAll('[data-rv-ui]').forEach((n) => n.remove());
    try {
      const u = new URL(location.href);
      u.searchParams.delete('review');
      history.replaceState(history.state, '', u);
    } catch {}
    window.__btiReview = null;
  };

  // ---------- запуск ----------
  let ro, mo;
  const init = () => {
    mount();
    on(capture, 'click', placeNote);
    on(capture, 'pointerdown', onDown);
    on(capture, 'pointermove', onMove);
    on(capture, 'pointerup', onUp);
    on(capture, 'pointercancel', onUp);
    on(bar, 'click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'note' || act === 'draw') {
        closePanel();
        setMode(mode === act ? null : act);
      } else if (act === 'undo') undo();
      else if (act === 'list') { if (panel) closePanel(); else openPanel(); }
    });
    on(document, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (editor) closeEditor(false);
      else if (panel) closePanel();
      else if (mode) setMode(null);
    });
    on(document, 'scroll', schedule, { capture: true, passive: true });
    on(window, 'resize', schedule);
    on(window, 'load', schedule);
    on(window, 'storage', (e) => { if (e.key === KEY) { state = load(); render(); refreshBar(); } });
    ro = new ResizeObserver(schedule);
    ro.observe(document.documentElement);
    mo = new MutationObserver((ms) => { if (ms.some((m) => !isUi(m.target))) schedule(); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-expanded'] });
    render();
    refreshBar();

    let pending = null;
    try { pending = sessionStorage.getItem(GOTO); sessionStorage.removeItem(GOTO); } catch {}
    if (pending) {
      // Страница дорисовывается после load (компоненты, картинки): ждём, пока метка
      // перестанет двигаться, и только тогда прокручиваем к ней.
      let last = null, tries = 0;
      const tick = () => {
        if (!alive) return;
        render();
        const b = boxOf(pending);
        const y = b ? Math.round(b.y) : null;
        if ((y !== null && y === last) || ++tries > 25) { reveal(pending); return; }
        last = y;
        setTimeout(tick, 300);
      };
      if (document.readyState === 'complete') tick(); else addEventListener('load', tick, { once: true });
    }
    let seen = false;
    try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch {}
    if (!seen && !RENDER_ONLY) showIntro();
  };

  window.__btiReview = {
    boxOf: (id) => boxOf(id),
    render: () => render(),
    items: () => state.items,
    exit: () => exit(),
    debug: () => ({ mode, drawing: curDraw && curDraw.id, pointers: pointers.size, editor: !!editor, panel: !!panel }),
  };
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
