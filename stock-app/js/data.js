// 資料層：FinMind 開放資料（日 K、三大法人、融資券）＋ 選配的即時報價代理 ＋ 示範資料
import { state, load, save } from './store.js';

const API = 'https://api.finmindtrade.com/api/v4/data';
const cache = new Map();
export const source = { mode: 'unknown', error: '' }; // live | demo

const fmtDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => fmtDate(new Date(Date.now() - n * 864e5));

async function finmind(dataset, params) {
  const q = new URLSearchParams({ dataset, ...params });
  if (state.settings.finmindToken) q.set('token', state.settings.finmindToken);
  const res = await fetch(`${API}?${q}`);
  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200) throw new Error(j.msg || 'FinMind error');
  return j.data;
}

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

/* ---------- 股票清單（代號→名稱） ---------- */
const FALLBACK_NAMES = {
  2330: '台積電', 2317: '鴻海', 2454: '聯發科', 2345: '智邦', 2382: '廣達', 3231: '緯創', 2308: '台達電',
  2881: '富邦金', 2882: '國泰金', 2891: '中信金', 2603: '長榮', 2412: '中華電', 3711: '日月光投控',
  2376: '技嘉', 3017: '奇鋐', 6669: '緯穎', 2303: '聯電', 1301: '台塑', 2002: '中鋼', 3008: '大立光',
  '0050': '元大台灣50', '0056': '元大高股息', '00878': '國泰永續高股息', '00919': '群益台灣精選高息',
  '006208': '富邦台50', '00679B': '元大美債20年',
};
let names = { ...FALLBACK_NAMES, ...load('names', {}).map };

export async function loadNames() {
  const stored = load('names', null);
  if (stored && Date.now() - stored.t < 7 * 864e5) { names = { ...FALLBACK_NAMES, ...stored.map }; return names; }
  if (state.settings.useDemo) return names;
  try {
    const rows = await finmind('TaiwanStockInfo', {});
    const map = {};
    for (const r of rows) if (/^\w{4,6}$/.test(r.stock_id)) map[r.stock_id] = r.stock_name;
    names = { ...FALLBACK_NAMES, ...map };
    save('names', { t: Date.now(), map });
  } catch (_) { /* 用內建清單 */ }
  return names;
}
export const nameOf = (code) => names[code] || '';
export function searchStocks(q, limit = 8) {
  q = q.trim();
  if (!q) return [];
  const out = [];
  for (const [code, n] of Object.entries(names)) {
    if (code.startsWith(q) || n.includes(q)) out.push({ code, name: n });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------- 日 K ---------- */
export async function getBars(code) {
  return cached(`bars:${code}`, 5 * 60e3, async () => {
    if (!state.settings.useDemo) {
      try {
        const rows = await finmind('TaiwanStockPrice', { data_id: code, start_date: daysAgo(400) });
        if (rows.length) {
          source.mode = 'live';
          return rows.filter((r) => r.close > 0).map((r) => ({
            date: r.date, open: r.open, high: r.max, low: r.min, close: r.close,
            volume: Math.round(r.Trading_Volume / 1000),
          }));
        }
      } catch (e) { source.error = e.message; }
    }
    source.mode = 'demo';
    return demo(code).bars;
  });
}

/* ---------- 籌碼：外資 / 投信 / 自營 / 主力(估) / 散戶(融資) ，單位：張 ---------- */
export async function getChips(code) {
  return cached(`chips:${code}`, 10 * 60e3, async () => {
    if (!state.settings.useDemo) {
      try {
        const start = daysAgo(400);
        const [inst, margin] = await Promise.all([
          finmind('TaiwanStockInstitutionalInvestorsBuySell', { data_id: code, start_date: start }),
          finmind('TaiwanStockMarginPurchaseShortSale', { data_id: code, start_date: start }).catch(() => []),
        ]);
        if (inst.length) {
          const byDate = {};
          for (const r of inst) {
            const d = (byDate[r.date] ||= { date: r.date, foreign: 0, trust: 0, dealer: 0 });
            const net = (r.buy - r.sell) / 1000;
            if (r.name.startsWith('Foreign')) d.foreign += net;
            else if (r.name === 'Investment_Trust') d.trust += net;
            else if (r.name.startsWith('Dealer')) d.dealer += net;
          }
          for (const m of margin) {
            const d = byDate[m.date];
            if (d) {
              d.retail = m.MarginPurchaseTodayBalance - m.MarginPurchaseYesterdayBalance;
              d.marginBal = m.MarginPurchaseTodayBalance;
              d.shortBal = m.ShortSaleTodayBalance;
            }
          }
          return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(finishChip);
        }
      } catch (e) { source.error = e.message; }
    }
    return demo(code).chips;
  });
}

function finishChip(d) {
  const r = (x) => Math.round(x || 0);
  const out = { ...d, foreign: r(d.foreign), trust: r(d.trust), dealer: r(d.dealer), retail: r(d.retail) };
  // 免費資料無券商分點：主力以「三大法人合計」估算
  out.main = out.foreign + out.trust + out.dealer;
  return out;
}

/* ---------- 即時報價（需設定代理；否則以最新日 K 代替） ---------- */
export async function getQuotes(codes) {
  const out = {};
  const proxy = state.settings.quoteProxy?.trim();
  if (proxy && !state.settings.useDemo && codes.length) {
    try {
      const exch = codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join('|');
      const res = await fetch(`${proxy}${proxy.includes('?') ? '&' : '?'}ex_ch=${encodeURIComponent(exch)}`);
      const j = await res.json();
      for (const m of j.msgArray || []) {
        const prev = +m.y;
        let px = parseFloat(m.z);
        if (!isFinite(px)) px = parseFloat((m.b || '').split('_')[0]) || prev;
        out[m.c] = {
          price: px, prev, open: +m.o || px, high: +m.h || px, low: +m.l || px,
          volume: +m.v || 0, time: m.t, realtime: true,
        };
        if (m.n && !names[m.c]) names[m.c] = m.n;
      }
    } catch (e) { source.error = `即時報價：${e.message}`; }
  }
  await Promise.all(codes.filter((c) => !out[c]).map(async (c) => {
    const bars = await getBars(c);
    const b = bars[bars.length - 1], p = bars[bars.length - 2] || b;
    if (b) out[c] = { price: b.close, prev: p.close, open: b.open, high: b.high, low: b.low, volume: b.volume, time: b.date, realtime: false };
  }));
  return out;
}

export function clearCache() { cache.clear(); }

/* ---------- 示範資料（離線或 API 無法連線時使用，數值為模擬） ---------- */
const demoCache = {};
function demo(code) {
  if (demoCache[code]) return demoCache[code];
  let seed = [...String(code)].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const base = { 2330: 1450, 2345: 1300, 2454: 1400, 2317: 220, '0050': 62, 2382: 290, 3231: 140, 2308: 900 }[code] || 30 + rnd() * 400;

  const days = [];
  const d = new Date();
  while (days.length < 260) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days.unshift(fmtDate(d));
    d.setDate(d.getDate() - 1);
  }
  let px = base * (0.75 + rnd() * 0.3);
  const drift = (Math.log(base) - Math.log(px)) / days.length;
  const bars = [], chips = [];
  let margin = 5000 + Math.round(rnd() * 8000);
  for (const date of days) {
    const ret = drift + gauss() * 0.018;
    const open = px * (1 + gauss() * 0.006);
    const close = Math.max(1, px * (1 + ret));
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.008);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.008);
    const volume = Math.round((2000 + rnd() * 6000) * (1 + Math.abs(ret) * 25) * (1000 / Math.max(px, 50)) * 4);
    const r2 = (v) => +v.toFixed(px < 100 ? 2 : 1);
    bars.push({ date, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume });
    const flow = ret * volume * 3;
    const foreign = Math.round(flow * (0.6 + rnd()) + gauss() * volume * 0.05);
    const trust = Math.round(flow * 0.25 * rnd() + gauss() * volume * 0.02);
    const dealer = Math.round(gauss() * volume * 0.02);
    const retail = Math.round(-flow * 0.15 + gauss() * volume * 0.03);
    margin = Math.max(0, margin + retail);
    chips.push(finishChip({ date, foreign, trust, dealer, retail, marginBal: margin }));
    px = close;
  }
  return (demoCache[code] = { bars, chips });
}
