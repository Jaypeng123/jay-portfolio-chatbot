import { state, persist, uid, DEFAULT_SETTINGS } from './store.js';
import { getBars, getChips, getQuotes, loadNames, nameOf, searchStocks, source, clearCache } from './data.js';
import { signals, streak, sma, kd, rsi, macd } from './indicators.js';
import * as C from './calc.js';
import { ALERT_TYPES, describe, checkAll, notify, exportConfig } from './alerts.js';
import { readFileText, parseCSV, toTrades } from './importer.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt0 = (n) => fmt(n, 0);
const sign = (n) => (n > 0 ? '+' : '');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const pct = (n) => `${sign(n)}${fmt(n * 100)}%`;
const money = (n) => `${sign(n)}${fmt0(n)}`;
const stockLabel = (code) => `<span class="code">${esc(code)}</span><span class="name">${esc(nameOf(code))}</span>`;

let current = { view: 'home', code: state.watchlist[0] || '2330', range: 120, chipN: 5 };
let quotes = {};
let timer = null;

/* ===================== 工具 ===================== */
function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  $('#toast').append(el);
  setTimeout(() => el.remove(), 3200);
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function sparkline(values) {
  if (!values.length) return '';
  const min = Math.min(...values), max = Math.max(...values), w = 84, h = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`).join(' ');
  const color = values[values.length - 1] >= values[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}
function updateSourceBadge() {
  const b = $('#srcBadge');
  const rt = state.settings.quoteProxy && !state.settings.useDemo;
  if (source.mode === 'live') { b.className = 'src-badge live'; b.textContent = rt ? '● 即時行情' : '● 盤後資料'; }
  else if (source.mode === 'demo') { b.className = 'src-badge demo'; b.textContent = '示範資料'; b.title = source.error || '已開啟示範資料'; }
}

/* ===================== 主題 ===================== */
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = isDark();
  $('#themeBtn use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('meta[name=theme-color]').content = dark ? '#0b1220' : '#1d3a6b';
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
}
const isDark = () => state.settings.theme === 'dark' || (state.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); if (current.view === 'stock') renderStock(); });
$('#themeBtn').onclick = () => {
  state.settings.theme = isDark() ? 'light' : 'dark';
  persist('settings'); applyTheme(); if (current.view === 'stock') renderStock();
};

/* ===================== 路由 ===================== */
function route() {
  const [view, code] = (location.hash.slice(1) || 'home').split('/');
  current.view = $(`#view-${view}`) ? view : 'home';
  if (code) current.code = code.toUpperCase();
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${current.view}`));
  $$('[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === current.view));
  render();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);
const goStock = (code) => { location.hash = `stock/${code}`; };

async function render() {
  try {
    if (current.view === 'home') await renderHome();
    if (current.view === 'stock') await renderStock();
    if (current.view === 'portfolio') await renderPortfolio();
    if (current.view === 'calc') renderCalc();
    if (current.view === 'alerts') renderAlerts();
    if (current.view === 'settings') renderSettings();
  } catch (e) {
    console.error(e);
    toast(`載入失敗：${e.message}`);
  }
  updateSourceBadge();
}

/* ===================== 搜尋 ===================== */
const search = $('#search'), suggest = $('#suggest');
let sIdx = -1;
search.addEventListener('input', () => {
  const list = searchStocks(search.value);
  sIdx = -1;
  suggest.innerHTML = list.map((s) => `<button data-code="${esc(s.code)}"><b>${esc(s.code)}</b>${esc(s.name)}</button>`).join('');
  suggest.classList.toggle('open', list.length > 0);
});
search.addEventListener('keydown', (e) => {
  const items = $$('button', suggest);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('active', i === sIdx));
  } else if (e.key === 'Enter') {
    const code = items[sIdx]?.dataset.code || items[0]?.dataset.code || search.value.trim().toUpperCase();
    if (code) pick(code);
  } else if (e.key === 'Escape') suggest.classList.remove('open');
});
suggest.addEventListener('mousedown', (e) => { const b = e.target.closest('button'); if (b) pick(b.dataset.code); });
search.addEventListener('blur', () => setTimeout(() => suggest.classList.remove('open'), 150));
function pick(code) { search.value = ''; suggest.classList.remove('open'); search.blur(); goStock(code); }

/* ===================== 總覽 ===================== */
async function renderHome() {
  $('#homeDate').textContent = `${new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`;
  const positions = C.buildPositions(state.trades, state.settings);
  const codes = [...new Set([...state.watchlist, ...positions.filter((p) => p.shares).map((p) => p.code)])];
  quotes = await getQuotes(codes);
  renderKpis($('#kpis'), positions);

  const rows = await Promise.all(state.watchlist.map(async (code) => {
    const [bars, chips] = await Promise.all([getBars(code), getChips(code)]);
    return { code, bars, chips, q: quotes[code], sig: signals(bars, chips) };
  }));
  $('#watchTable').innerHTML = rows.length ? `
    <thead><tr><th>股票</th><th class="n">成交</th><th class="n">漲跌幅</th><th class="hide-sm">走勢</th><th class="n hide-sm">量(張)</th><th class="n">外資</th><th class="n">投信</th><th class="n hide-sm">投信連買</th><th class="n">訊號</th><th></th></tr></thead>
    <tbody>${rows.map(({ code, bars, chips, q, sig }) => {
      const chg = q ? (q.price - q.prev) / q.prev : 0;
      const l = chips[chips.length - 1] || {};
      const st = streak(chips.map((x) => x.trust));
      return `<tr class="click" data-code="${esc(code)}">
        <td>${stockLabel(code)}</td>
        <td class="n ${cls(chg)}"><b>${fmt(q?.price)}</b></td>
        <td class="n"><span class="pill ${cls(chg)}">${pct(chg)}</span></td>
        <td class="hide-sm">${sparkline(bars.slice(-40).map((b) => b.close))}</td>
        <td class="n hide-sm">${fmt0(q?.volume)}</td>
        <td class="n ${cls(l.foreign)}">${money(l.foreign)}</td>
        <td class="n ${cls(l.trust)}">${money(l.trust)}</td>
        <td class="n hide-sm">${st > 0 ? `<span class="up">連買 ${st}</span>` : st < 0 ? `<span class="down">連賣 ${-st}</span>` : '—'}</td>
        <td class="n">${scorePill(sig.score)}</td>
        <td><button class="btn sm ghost" data-rm="${esc(code)}" title="移除自選">✕</button></td></tr>`;
    }).join('')}</tbody>` : `<tbody><tr><td><div class="empty"><b>還沒有自選股</b>用上方搜尋加入</div></td></tr></tbody>`;
  $('#watchTable').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); state.watchlist = state.watchlist.filter((c) => c !== rm.dataset.rm); persist('watchlist'); renderHome(); return; }
    const tr = e.target.closest('tr[data-code]');
    if (tr) goStock(tr.dataset.code);
  };

  renderLog($('#homeLog'), 5);

  // 籌碼焦點：投信連買、外資大買
  const focus = [];
  for (const r of rows) {
    const st = streak(r.chips.map((x) => x.trust));
    const f5 = r.chips.slice(-5).reduce((s, x) => s + x.foreign, 0);
    if (st >= 3) focus.push(`<li><b>${esc(r.code)} ${esc(nameOf(r.code))}</b>：投信連買 <span class="up">${st} 日</span></li>`);
    if (st <= -3) focus.push(`<li><b>${esc(r.code)} ${esc(nameOf(r.code))}</b>：投信連賣 <span class="down">${-st} 日</span></li>`);
    if (Math.abs(f5) > 0) focus.push(`<li><b>${esc(r.code)} ${esc(nameOf(r.code))}</b>：外資 5 日${f5 > 0 ? '買' : '賣'}超 <span class="${cls(f5)}">${fmt0(Math.abs(f5))} 張</span></li>`);
  }
  $('#homeFocus').innerHTML = focus.length ? `<ul style="margin:0;padding-left:18px;line-height:2">${focus.slice(0, 8).join('')}</ul>` : '<div class="empty">暫無明顯籌碼動向</div>';
}

function scorePill(s) {
  const label = s >= 30 ? '偏多' : s <= -30 ? '偏空' : '中性';
  return `<span class="pill ${s >= 30 ? 'up' : s <= -30 ? 'down' : 'neutral'}">${label} ${sign(s)}${s}</span>`;
}

function renderKpis(el, positions) {
  let mv = 0, cost = 0, today = 0, realized = 0;
  for (const p of positions) {
    realized += p.realized;
    if (!p.shares) continue;
    const q = quotes[p.code];
    const px = q?.price ?? p.avg;
    mv += px * p.shares; cost += p.cost;
    if (q) today += (q.price - q.prev) * p.shares;
  }
  const unreal = mv - cost;
  el.innerHTML = [
    ['持股市值', fmt0(mv), `成本 ${fmt0(cost)}`, ''],
    ['未實現損益', money(unreal), cost ? pct(unreal / cost) : '—', cls(unreal)],
    ['今日損益', money(today), mv ? pct(today / (mv - today || 1)) : '—', cls(today)],
    ['已實現損益', money(realized), '含手續費與交易稅', cls(realized)],
  ].map(([l, v, s, c]) => `<div class="card kpi"><div class="kpi-l">${l}</div><div class="kpi-v ${c}">${v}</div><div class="kpi-s ${c}">${s}</div></div>`).join('');
}

function renderLog(el, limit = 100) {
  const items = state.alertLog.slice(0, limit);
  el.innerHTML = items.length ? items.map((x) => `
    <div class="log-item"><span class="log-dot ${x.side}"></span><div style="min-width:0">
      <div><b>${esc(x.title)}</b></div><div class="small">${esc(x.msg)}</div>
      <div class="small muted">${new Date(x.ts).toLocaleString('zh-TW')}</div></div></div>`).join('')
    : '<div class="empty"><b>尚無提醒</b>到「買賣提醒」設定條件</div>';
}

/* ===================== 個股 ===================== */
let charts = [];
function destroyCharts() { charts.forEach((c) => c.remove()); charts = []; }

function makeChart(el, height, opts = {}) {
  const LC = window.LightweightCharts;
  const chart = LC.createChart(el, {
    height, autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: cssVar('--text-3'), fontFamily: 'Inter, "Noto Sans TC", sans-serif', fontSize: 11, attributionLogo: !!opts.logo },
    grid: { vertLines: { color: cssVar('--chart-grid') }, horzLines: { color: cssVar('--chart-grid') } },
    rightPriceScale: { borderVisible: false, minimumWidth: 64 },
    timeScale: { borderVisible: false, visible: !!opts.showTime },
    crosshair: { mode: 0 },
    localization: { locale: 'zh-TW' },
    handleScroll: { vertTouchDrag: false },
    ...opts.chart,
  });
  charts.push(chart);
  return chart;
}

async function renderStock() {
  const code = current.code;
  const [bars, chips] = await Promise.all([getBars(code), getChips(code)]);
  const q = (await getQuotes([code]))[code];
  quotes[code] = q;
  const chg = q ? q.price - q.prev : 0;
  $('#sTitle').innerHTML = `${esc(code)} ${esc(nameOf(code))}`;
  $('#sPx').textContent = fmt(q?.price);
  $('#sPx').className = `px ${cls(chg)}`;
  $('#sChg').innerHTML = q ? `<span class="pill ${cls(chg)}" style="font-size:13px">${chg > 0 ? '▲' : chg < 0 ? '▼' : ''} ${fmt(Math.abs(chg))}（${pct(chg / q.prev)}）</span>` : '';
  const ma = (n) => { const m = sma(bars.map((b) => b.close), n); return m[m.length - 1]; };
  $('#sMeta').innerHTML = q ? `
    <span>開<b>${fmt(q.open)}</b></span><span>高<b class="up">${fmt(q.high)}</b></span><span>低<b class="down">${fmt(q.low)}</b></span>
    <span>昨收<b>${fmt(q.prev)}</b></span><span>量<b>${fmt0(q.volume)} 張</b></span><span>${q.realtime ? '即時' : '資料日'}<b>${esc(q.time)}</b></span>` : '';
  $('#sWatch').textContent = state.watchlist.includes(code) ? '✓ 已自選' : '＋ 自選';

  // ----- 圖表 -----
  destroyCharts();
  $$('#view-stock .chart-box').forEach((el) => { [...el.children].forEach((c) => { if (!c.classList.contains('chart-label')) c.remove(); }); });
  if (!window.LightweightCharts) { $('#cMain').innerHTML = '<div class="empty">圖表元件載入失敗，請確認網路連線</div>'; }
  else {
    const UP = cssVar('--up'), DN = cssVar('--down');
    const main = makeChart($('#cMain'), $('#cMain').clientHeight, { logo: true });
    const candle = main.addCandlestickSeries({ upColor: UP, downColor: DN, borderUpColor: UP, borderDownColor: DN, wickUpColor: UP, wickDownColor: DN, priceLineVisible: true });
    candle.setData(bars.map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close })));
    const closes = bars.map((b) => b.close);
    const maDefs = [[5, '#d4a017'], [20, '#3b82c4'], [60, '#9b59b6']];
    for (const [n, color] of maDefs) {
      const s = main.addLineSeries({ color, lineWidth: 1.4, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(sma(closes, n).map((v, i) => (v == null ? null : { time: bars[i].date, value: +v.toFixed(2) })).filter(Boolean));
    }
    $('#maLegend').innerHTML = maDefs.map(([n, c]) => `<span><i style="background:${c}"></i>MA${n} ${fmt(ma(n))}</span>`).join('');
    const vol = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    main.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
    vol.setData(bars.map((b, i) => ({ time: b.date, value: b.volume, color: (b.close >= (bars[i - 1]?.close ?? b.open) ? UP : DN) + '66' })));

    // 交易標記（買點／賣點）
    const marks = state.trades.filter((t) => t.code === code).map((t) => ({
      time: nearestDate(bars, t.date), position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: t.side === 'buy' ? UP : DN, shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', text: `${t.side === 'buy' ? '買' : '賣'} ${t.price}`,
    })).filter((m) => m.time).sort((a, b) => a.time.localeCompare(b.time));
    candle.setMarkers(marks);

    // 籌碼子圖（日期對齊 K 線）
    const chipMap = Object.fromEntries(chips.map((c) => [c.date, c]));
    const subs = [['#cForeign', 'foreign'], ['#cTrust', 'trust'], ['#cDealer', 'dealer'], ['#cMainForce', 'main'], ['#cRetail', 'retail']];
    const subCharts = subs.map(([sel, key], idx) => {
      const el = $(sel);
      const ch = makeChart(el, el.clientHeight, { showTime: idx === subs.length - 1 });
      const h = ch.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
      h.setData(bars.map((b) => {
        const v = chipMap[b.date]?.[key];
        return v == null ? { time: b.date } : { time: b.date, value: v, color: v >= 0 ? UP : DN };
      }));
      const l = chips[chips.length - 1]?.[key] ?? 0;
      const st = streak(chips.map((c) => c[key]));
      el.querySelector('.chart-label').innerHTML = `${el.querySelector('.chart-label').textContent.split(' ')[0].replace(/[+-].*/, '')} <em class="${cls(l)}">${money(l)} 張${Math.abs(st) >= 2 ? `・連${st > 0 ? '買' : '賣'} ${Math.abs(st)}` : ''}</em>`;
      return ch;
    });

    // 同步捲動縮放
    const all = [main, ...subCharts];
    let syncing = false;
    all.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      all.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(r));
      syncing = false;
    }));
    const n = bars.length;
    main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - current.range), to: n + 2 });
  }

  // ----- 籌碼統計 -----
  renderChipTable(chips);

  // ----- 訊號 -----
  const sig = signals(bars, chips);
  $('#scorePill').innerHTML = scorePill(sig.score);
  $('#gaugeNeedle').style.left = `${50 + sig.score / 2}%`;
  $('#reasons').innerHTML = sig.items.length
    ? sig.items.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).map((x) => `<li><span>${esc(x.text)}</span><span class="${cls(x.w)}">${sign(x.w)}${x.w}</span></li>`).join('')
    : '<li class="muted">資料不足</li>';
  const L = (a) => a?.[a.length - 1];
  $('#indGrid').innerHTML = [
    ['K / D (9)', `${fmt(L(sig.K), 1)} / ${fmt(L(sig.D), 1)}`],
    ['RSI (14)', fmt(L(sig.rsi), 1)],
    ['MACD DIF', fmt(L(sig.macd?.dif))],
    ['MACD 柱', `<span class="${cls(L(sig.macd?.hist))}">${fmt(L(sig.macd?.hist))}</span>`],
    ['乖離率 MA20', sig.ma20 ? pct((L(bars).close - L(sig.ma20)) / L(sig.ma20)) : '—'],
    ['融資餘額', chips.length && L(chips).marginBal != null ? `${fmt0(L(chips).marginBal)} 張` : '—'],
  ].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
}

function nearestDate(bars, d) {
  for (const b of bars) if (b.date >= d) return b.date;
  return null;
}

function renderChipTable(chips) {
  const n = current.chipN;
  const win = chips.slice(-n);
  const rows = [['外資', 'foreign'], ['投信', 'trust'], ['自營商', 'dealer'], ['主力（估）', 'main'], ['散戶（融資）', 'retail']];
  $('#chipTable').innerHTML = `<thead><tr><th>身分</th><th class="n">${n} 日合計</th><th class="n">最新一日</th><th class="n">連續</th></tr></thead><tbody>${rows.map(([label, k]) => {
    const sum = win.reduce((s, x) => s + (x[k] || 0), 0);
    const lastV = chips[chips.length - 1]?.[k] ?? 0;
    const st = streak(chips.map((x) => x[k]));
    return `<tr><td>${label}</td><td class="n ${cls(sum)}"><b>${money(sum)}</b></td><td class="n ${cls(lastV)}">${money(lastV)}</td>
      <td class="n">${st > 0 ? `<span class="up">買 ${st}</span>` : st < 0 ? `<span class="down">賣 ${-st}</span>` : '—'}</td></tr>`;
  }).join('')}</tbody>`;
}

$('#rangeSeg').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  current.range = +b.dataset.r;
  $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  const main = charts[0];
  if (main) { const n = main.timeScale().getVisibleLogicalRange(); main.timeScale().setVisibleLogicalRange({ from: Math.max(0, (n?.to ?? 0) - 2 - current.range), to: n?.to }); }
};
$('#chipSeg').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  current.chipN = +b.dataset.n;
  $$('#chipSeg button').forEach((x) => x.classList.toggle('on', x === b));
  renderChipTable(await getChips(current.code));
};
$('#sWatch').onclick = () => {
  const c = current.code;
  state.watchlist = state.watchlist.includes(c) ? state.watchlist.filter((x) => x !== c) : [...state.watchlist, c];
  persist('watchlist');
  $('#sWatch').textContent = state.watchlist.includes(c) ? '✓ 已自選' : '＋ 自選';
  toast(state.watchlist.includes(c) ? `已加入自選：${c}` : `已移除自選：${c}`);
};
$('#sAlert').onclick = () => { location.hash = 'alerts'; setTimeout(() => { $('#alertForm [name=code]').value = current.code; $('#alertForm [name=value]').focus(); }, 50); };
$('#sCalc').onclick = () => { calcPrefill = { code: current.code, price: quotes[current.code]?.price }; calcMode = 'pnl'; location.hash = 'calc'; };
$('#sTrade').onclick = () => openTradeDialog({ code: current.code, price: quotes[current.code]?.price });

/* ===================== 庫存 ===================== */
async function renderPortfolio() {
  const positions = C.buildPositions(state.trades, state.settings);
  const held = positions.filter((p) => p.shares > 0);
  quotes = { ...quotes, ...(await getQuotes(held.map((p) => p.code))) };
  renderKpis($('#pfKpis'), positions);
  const s = state.settings;
  $('#posTable').innerHTML = held.length ? `
    <thead><tr><th>股票</th><th class="n">股數</th><th class="n">均價</th><th class="n">現價</th><th class="n">市值</th><th class="n">損益（含費稅）</th><th class="n">報酬率</th><th class="n">兩平價</th></tr></thead>
    <tbody>${held.map((p) => {
      const px = quotes[p.code]?.price ?? p.avg;
      const net = C.sellProceeds(px, p.shares, p.code, s).net;
      const pnl = net - p.cost;
      const be = C.breakEvenPrice(p.cost, p.shares, p.code, s);
      return `<tr class="click" data-code="${esc(p.code)}"><td>${stockLabel(p.code)}</td><td class="n">${fmt0(p.shares)}</td><td class="n">${fmt(p.avg)}</td>
        <td class="n ${cls(px - p.avg)}">${fmt(px)}</td><td class="n">${fmt0(px * p.shares)}</td>
        <td class="n ${cls(pnl)}"><b>${money(pnl)}</b></td><td class="n"><span class="pill ${cls(pnl)}">${pct(pnl / p.cost)}</span></td><td class="n">${fmt(be)}</td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td><div class="empty"><b>目前沒有持股</b>新增交易或匯入券商 CSV</div></td></tr></tbody>';
  $('#posTable').onclick = (e) => { const tr = e.target.closest('tr[data-code]'); if (tr) goStock(tr.dataset.code); };

  const trades = [...state.trades].sort((a, b) => b.date.localeCompare(a.date));
  $('#tradeTable').innerHTML = trades.length ? `
    <thead><tr><th>日期</th><th>股票</th><th>買賣</th><th class="n">價格</th><th class="n">股數</th><th class="n">金額</th><th class="n">費＋稅</th><th></th></tr></thead>
    <tbody>${trades.map((t) => {
      const amt = t.price * t.shares;
      const f = t.fee ?? C.fee(amt, t.shares, s);
      const tx = t.side === 'sell' ? (t.tax ?? C.tax(amt, t.code)) : 0;
      return `<tr><td>${esc(t.date)}</td><td>${stockLabel(t.code)}</td><td><span class="pill ${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '買進' : '賣出'}</span></td>
        <td class="n">${fmt(t.price)}</td><td class="n">${fmt0(t.shares)}</td><td class="n">${fmt0(amt)}</td><td class="n">${fmt0(f + tx)}</td>
        <td><button class="btn sm ghost" data-del="${esc(t.id)}">刪除</button></td></tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td><div class="empty">尚無交易紀錄</div></td></tr></tbody>';
  $('#tradeTable').onclick = (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!confirm('確定刪除這筆交易？')) return;
    state.trades = state.trades.filter((t) => t.id !== b.dataset.del);
    persist('trades'); renderPortfolio();
  };
}

$('#addTradeBtn').onclick = () => openTradeDialog({});
$('#csvInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const { trades, kind } = toTrades(parseCSV(await readFileText(f)));
    if (!trades.length) throw new Error('沒有讀到有效資料列');
    const replace = kind === '庫存' && state.trades.length && confirm(`讀到 ${trades.length} 檔庫存。\n按「確定」取代現有紀錄，按「取消」附加在後面。`);
    state.trades = replace ? trades : [...state.trades, ...trades];
    for (const t of trades) if (!state.watchlist.includes(t.code)) state.watchlist.push(t.code);
    persist('trades', 'watchlist');
    toast(`已匯入 ${trades.length} 筆${kind}`);
    renderPortfolio();
  } catch (err) { toast(`匯入失敗：${err.message}`); }
};
$('#exportTrades').onclick = () => {
  const lines = [['日期', '股票代號', '股票名稱', '買賣別', '成交價', '股數', '手續費', '交易稅']];
  for (const t of state.trades) lines.push([t.date, t.code, nameOf(t.code), t.side === 'buy' ? '買' : '賣', t.price, t.shares, t.fee ?? '', t.tax ?? '']);
  download('交易紀錄.csv', '﻿' + lines.map((r) => r.join(',')).join('\n'), 'text/csv');
};

let tradeSide = 'buy';
function openTradeDialog({ code = '', price = '' }) {
  const f = $('#tradeForm');
  f.reset();
  f.code.value = code; f.price.value = price ?? ''; f.date.value = new Date().toISOString().slice(0, 10);
  setSide('buy');
  updateTradePreview();
  $('#tradeDlg').showModal();
}
function setSide(s) { tradeSide = s; $$('#sideSeg button').forEach((b) => b.classList.toggle('on', b.dataset.s === s)); updateTradePreview(); }
$('#sideSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setSide(b.dataset.s); };
function updateTradePreview() {
  const f = $('#tradeForm');
  const p = +f.price.value, n = +f.shares.value, code = f.code.value.trim().toUpperCase();
  if (!p || !n) { $('#tradePreview').textContent = ''; return; }
  const s = state.settings;
  $('#tradePreview').textContent = tradeSide === 'buy'
    ? `買進成本：${fmt0(C.buyCost(p, n, s).total)} 元（手續費 ${fmt0(C.buyCost(p, n, s).fee)}）`
    : (() => { const r = C.sellProceeds(p, n, code, s); return `賣出實收：${fmt0(r.net)} 元（手續費 ${fmt0(r.fee)}、證交稅 ${fmt0(r.tax)}）`; })();
}
$('#tradeForm').addEventListener('input', updateTradePreview);
$('#tradeDlg').addEventListener('close', () => {
  if ($('#tradeDlg').returnValue !== 'ok') return;
  const f = $('#tradeForm');
  const code = f.code.value.trim().toUpperCase();
  const t = { id: uid(), date: f.date.value, code, side: tradeSide, price: +f.price.value, shares: Math.round(+f.shares.value) };
  if (!code || !t.price || !t.shares) return;
  state.trades.push(t);
  if (!state.watchlist.includes(code)) state.watchlist.push(code);
  persist('trades', 'watchlist');
  toast(`已記錄：${tradeSide === 'buy' ? '買進' : '賣出'} ${code} ${t.shares} 股 @ ${t.price}`);
  render();
});

/* ===================== 試算 ===================== */
let calcMode = 'pnl';
let calcPrefill = null;
const calcState = { code: '2345', buy: 1200, sell: 1350, shares: 1000, dayTrade: false, roi: 10, entry: 1200, stop: 1100, risk: 20000, capital: 500000, curShares: 1000, curAvg: 1350, addShares: 1000, addPrice: 1200 };

function renderCalc() {
  if (calcPrefill) {
    calcState.code = calcPrefill.code;
    if (calcPrefill.price) Object.assign(calcState, { buy: calcPrefill.price, entry: calcPrefill.price, addPrice: calcPrefill.price, sell: C.roundTick(calcPrefill.price * 1.1, calcPrefill.code) });
    calcPrefill = null;
  }
  $$('#calcSeg button').forEach((b) => b.classList.toggle('on', b.dataset.c === calcMode));
  const F = (k, label, attrs = '', hint = '') => `<div class="field"><label>${label}</label><input data-k="${k}" value="${esc(calcState[k])}" ${attrs || 'type="number" step="any"'} />${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const forms = {
    pnl: F('code', '股票代號', 'type="text"') + F('buy', '買進價') + F('sell', '賣出價') + F('shares', '股數', 'type="number" step="1"', '1 張 = 1000 股') +
      `<label class="check"><span class="switch"><input type="checkbox" data-k="dayTrade" ${calcState.dayTrade ? 'checked' : ''}/><span></span></span>現股當沖（稅率 0.15%）</label>`,
    target: F('code', '股票代號', 'type="text"') + F('buy', '買進價') + F('shares', '股數', 'type="number" step="1"') + F('roi', '目標報酬率 %'),
    risk: F('entry', '進場價') + F('stop', '停損價') + F('risk', '最多可承受虧損（元）') + F('capital', '可用資金（元）'),
    avg: F('code', '股票代號', 'type="text"') + F('curShares', '目前股數') + F('curAvg', '目前均價') + F('addShares', '加碼股數') + F('addPrice', '加碼價格'),
  };
  $('#calcCard').innerHTML = `<div class="form-grid">${forms[calcMode]}</div><div class="result" id="calcResult"></div>`;
  $('#calcCard').oninput = (e) => {
    const k = e.target.dataset.k; if (!k) return;
    calcState[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? +e.target.value : e.target.value.trim().toUpperCase();
    calcResult();
  };
  calcResult();
}
function calcResult() {
  const s = state.settings, c = calcState;
  const R = (label, v, cl = '', hero = false) => `<div class="${hero ? 'hero' : ''}"><small>${label}</small><b class="${cl}">${v}</b></div>`;
  let html = '';
  if (calcMode === 'pnl') {
    const r = C.roundTrip({ code: c.code, buyPrice: c.buy, sellPrice: c.sell, shares: c.shares, dayTrade: c.dayTrade }, s);
    html = R('淨損益', money(r.pnl), cls(r.pnl), true) + R('報酬率', pct(r.roi), cls(r.roi), true) + R('買進總成本', fmt0(r.buy.total)) + R('買進手續費', fmt0(r.buy.fee))
      + R('賣出實收', fmt0(r.sell.net)) + R('賣出手續費', fmt0(r.sell.fee)) + R(`證交稅（${(C.taxRate(c.code, { dayTrade: c.dayTrade }) * 100).toFixed(2)}%）`, fmt0(r.sell.tax)) + R('損益兩平賣價', fmt(r.breakEven));
  } else if (calcMode === 'target') {
    const b = C.buyCost(c.buy, c.shares, s);
    const be = C.breakEvenPrice(b.total, c.shares, c.code, s);
    const tp = C.targetPrice(b.total, c.shares, c.code, s, c.roi / 100);
    html = R('損益兩平賣價', fmt(be), '', true) + R(`目標 ${c.roi}% 賣價`, fmt(tp), 'up', true) + R('需上漲', pct((tp - c.buy) / c.buy)) + R('買進總成本', fmt0(b.total))
      + R(`升降單位`, fmt(C.tickSize(c.buy, c.code))) + R('兩平需漲幾檔', fmt0(Math.round((be - c.buy) / C.tickSize(c.buy, c.code))));
  } else if (calcMode === 'risk') {
    const r = C.positionSize({ entry: c.entry, stop: c.stop, riskAmt: c.risk, capital: c.capital });
    html = r ? R('建議股數', fmt0(r.shares), '', true) + R('約當', `${r.lots} 張 ${r.odd} 股`, '', true) + R('所需資金', fmt0(r.cost)) + R('每股風險', fmt(r.perShare))
      + R('停損幅度', pct(-r.perShare / c.entry), 'down') + R('佔可用資金', c.capital ? pct(r.cost / c.capital) : '—')
      : R('提示', '停損價需低於進場價');
  } else {
    const avg = C.averageDown(c.curShares, c.curAvg, c.addShares, c.addPrice);
    const total = c.curShares + c.addShares;
    const be = C.breakEvenPrice(avg * total * (1 + C.FEE_RATE * s.feeDiscount), total, c.code, s);
    html = R('攤平後均價', fmt(avg), '', true) + R('總股數', fmt0(total), '', true) + R('均價下降', pct((avg - c.curAvg) / c.curAvg), 'down') + R('新增資金', fmt0(c.addShares * c.addPrice)) + R('攤平後兩平價', fmt(be));
  }
  $('#calcResult').innerHTML = html;
}
$('#calcSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { calcMode = b.dataset.c; renderCalc(); } };

/* ===================== 提醒 ===================== */
function renderAlerts() {
  const sel = $('#alertType');
  if (!sel.options.length) {
    sel.innerHTML = Object.entries(ALERT_TYPES).map(([k, t]) => `<option value="${k}">${t.label}${t.unit ? `（${t.unit}）` : ''}</option>`).join('');
    sel.onchange = syncAlertValue;
  }
  syncAlertValue();
  updatePermBtn();
  $('#alertTable').innerHTML = state.alerts.length ? `
    <thead><tr><th>股票</th><th>條件</th><th>最近觸發</th><th>啟用</th><th></th></tr></thead>
    <tbody>${state.alerts.map((a) => `<tr><td>${stockLabel(a.code)}</td><td>${esc(describe(a))}</td><td class="muted">${esc(a.lastFired || '—')}</td>
      <td><label class="switch"><input type="checkbox" data-toggle="${esc(a.id)}" ${a.enabled ? 'checked' : ''}/><span></span></label></td>
      <td><button class="btn sm ghost" data-del="${esc(a.id)}">刪除</button></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td><div class="empty"><b>尚未設定規則</b>例如：2345 投信連買 ≥ 3 日、股價 ≤ 1200</div></td></tr></tbody>';
  renderLog($('#alertLog'));
}
function syncAlertValue() {
  const t = ALERT_TYPES[$('#alertType').value];
  $('#alertValWrap').style.display = t.needsValue ? '' : 'none';
  $('#alertValLabel').textContent = `數值（${t.unit || ''}）`;
  $('#alertForm [name=value]').required = t.needsValue;
}
function updatePermBtn() {
  const b = $('#permBtn');
  if (!('Notification' in window)) { b.textContent = '此瀏覽器不支援通知'; b.disabled = true; return; }
  b.textContent = Notification.permission === 'granted' ? '✓ 通知已開啟' : Notification.permission === 'denied' ? '通知已被封鎖（請至瀏覽器設定開啟）' : '開啟通知權限';
  b.disabled = Notification.permission !== 'default';
}
$('#permBtn').onclick = async () => {
  const r = await Notification.requestPermission();
  updatePermBtn();
  if (r === 'granted') notify('通知已開啟', '條件成立時會在這裡提醒你', 'init');
};
$('#alertForm').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const a = { id: uid(), code: f.code.value.trim().toUpperCase(), type: f.type.value, value: ALERT_TYPES[f.type.value].needsValue ? +f.value.value : null, enabled: true };
  state.alerts.push(a);
  persist('alerts');
  f.value.value = '';
  toast(`已新增：${a.code} ${describe(a)}`);
  renderAlerts();
};
$('#alertTable').onclick = (e) => {
  const d = e.target.closest('[data-del]');
  if (d) { state.alerts = state.alerts.filter((a) => a.id !== d.dataset.del); persist('alerts'); renderAlerts(); }
};
$('#alertTable').onchange = (e) => {
  const id = e.target.dataset.toggle; if (!id) return;
  const a = state.alerts.find((x) => x.id === id); a.enabled = e.target.checked; persist('alerts');
};
$('#checkNow').onclick = async () => {
  const fired = await checkAll();
  toast(fired.length ? `觸發 ${fired.length} 則提醒` : '目前沒有條件成立（或今日已提醒過）');
  renderAlerts();
};
$('#clearLog').onclick = () => { state.alertLog = []; persist('alertLog'); renderAlerts(); };
$('#exportAlerts').onclick = () => download('alerts.json', JSON.stringify(exportConfig(), null, 2));
$('#testNotify').onclick = async () => {
  if (Notification?.permission !== 'granted') { toast('請先開啟通知權限'); return; }
  await notify('🔴 買進提醒｜測試', '這是一則測試通知', 'test');
};

/* ===================== 設定 ===================== */
function renderSettings() {
  const s = state.settings;
  $('#setDiscount').value = s.feeDiscount; $('#setMinFee').value = s.minFee; $('#setMinFeeOdd').value = s.minFeeOdd;
  $('#setToken').value = s.finmindToken; $('#setProxy').value = s.quoteProxy; $('#setRefresh').value = s.refreshSec; $('#setDemo').checked = s.useDemo;
  applyTheme();
}
$('#themeSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.settings.theme = b.dataset.t; persist('settings'); applyTheme(); };
const bindSetting = (sel, key, conv = (v) => v) => $(sel).addEventListener('change', (e) => {
  state.settings[key] = e.target.type === 'checkbox' ? e.target.checked : conv(e.target.value);
  persist('settings');
  if (['finmindToken', 'quoteProxy', 'useDemo'].includes(key)) { clearCache(); loadNames(); }
  if (key === 'refreshSec') startTimer();
  toast('設定已儲存');
});
bindSetting('#setDiscount', 'feeDiscount', (v) => Math.min(1, Math.max(0.1, +v || 1)));
bindSetting('#setMinFee', 'minFee', (v) => +v || 0);
bindSetting('#setMinFeeOdd', 'minFeeOdd', (v) => +v || 0);
bindSetting('#setToken', 'finmindToken', (v) => v.trim());
bindSetting('#setProxy', 'quoteProxy', (v) => v.trim());
bindSetting('#setRefresh', 'refreshSec', (v) => Math.max(15, +v || 60));
bindSetting('#setDemo', 'useDemo');
$('#backupBtn').onclick = () => download(`twstock-backup-${new Date().toISOString().slice(0, 10)}.json`,
  JSON.stringify({ watchlist: state.watchlist, trades: state.trades, alerts: state.alerts, settings: { ...state.settings, finmindToken: '' } }, null, 2));
$('#restoreInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (Array.isArray(d.watchlist)) state.watchlist = d.watchlist;
    if (Array.isArray(d.trades)) state.trades = d.trades;
    if (Array.isArray(d.alerts)) state.alerts = d.alerts;
    if (d.settings) state.settings = { ...state.settings, ...d.settings, finmindToken: state.settings.finmindToken };
    persist('watchlist', 'trades', 'alerts', 'settings');
    toast('已還原備份'); applyTheme(); render();
  } catch (err) { toast(`還原失敗：${err.message}`); }
};
$('#resetBtn').onclick = () => {
  if (!confirm('確定清除所有自選股、交易紀錄、提醒與設定？此動作無法復原。')) return;
  Object.assign(state, { watchlist: [], trades: [], alerts: [], alertLog: [], settings: { ...DEFAULT_SETTINGS } });
  persist('watchlist', 'trades', 'alerts', 'alertLog', 'settings');
  applyTheme(); render();
};

/* ===================== 自動更新與提醒輪詢 ===================== */
function isMarketHours() {
  const tw = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60e3);
  const m = tw.getHours() * 60 + tw.getMinutes();
  return tw.getDay() >= 1 && tw.getDay() <= 5 && m >= 9 * 60 - 5 && m <= 13 * 60 + 35;
}
function startTimer() {
  clearInterval(timer);
  timer = setInterval(async () => {
    if (document.hidden && !state.alerts.some((a) => a.enabled)) return;
    if (isMarketHours()) { clearCache(); if (!document.hidden && ['home', 'portfolio', 'stock'].includes(current.view)) render(); }
    const fired = await checkAll().catch(() => []);
    fired.forEach((f) => toast(`${f.title}：${f.msg}`));
  }, Math.max(15, state.settings.refreshSec) * 1000);
}
$('#refreshBtn').onclick = () => { clearCache(); render(); toast('已重新整理'); };

/* ===================== 啟動 ===================== */
(async function init() {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.code) goStock(e.data.code); });
  await loadNames();
  $('#codeList').innerHTML = Object.entries({ ...Object.fromEntries(state.watchlist.map((c) => [c, nameOf(c)])) })
    .map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
  route();
  startTimer();
  setTimeout(() => checkAll().then((f) => f.forEach((x) => toast(`${x.title}：${x.msg}`))).catch(() => {}), 3000);
})();
