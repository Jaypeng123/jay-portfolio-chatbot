// 提醒規則：價格、漲跌幅、停損停利、技術訊號、籌碼
import { state, persist, uid } from './store.js';
import { getBars, getChips, getQuotes, nameOf } from './data.js';
import { sma, kd, streak } from './indicators.js';
import { buildPositions } from './calc.js';

export const ALERT_TYPES = {
  price_above:   { label: '股價 ≥', unit: '元', needsValue: true },
  price_below:   { label: '股價 ≤', unit: '元', needsValue: true },
  change_up:     { label: '漲幅 ≥', unit: '%', needsValue: true },
  change_down:   { label: '跌幅 ≥', unit: '%', needsValue: true },
  stop_loss:     { label: '持股虧損 ≥（停損）', unit: '%', needsValue: true },
  take_profit:   { label: '持股獲利 ≥（停利）', unit: '%', needsValue: true },
  ma20_up:       { label: '突破月線 MA20（買進訊號）', needsValue: false },
  ma20_down:     { label: '跌破月線 MA20（賣出訊號）', needsValue: false },
  kd_golden:     { label: 'KD 黃金交叉（買進訊號）', needsValue: false },
  kd_death:      { label: 'KD 死亡交叉（賣出訊號）', needsValue: false },
  trust_streak:  { label: '投信連買 ≥', unit: '日', needsValue: true },
  foreign_buy:   { label: '外資單日買超 ≥', unit: '張', needsValue: true },
  foreign_sell:  { label: '外資單日賣超 ≥', unit: '張', needsValue: true },
};

export const SIDE = (type) =>
  ['price_below', 'change_down', 'stop_loss', 'ma20_down', 'kd_death', 'foreign_sell'].includes(type) ? 'sell'
    : ['take_profit'].includes(type) ? 'sell' : 'buy';

export function describe(a) {
  const t = ALERT_TYPES[a.type];
  return `${t.label}${t.needsValue ? ` ${a.value}${t.unit === '元' ? ' 元' : t.unit}` : ''}`;
}

function crossed(prevA, prevB, a, b, up) {
  if ([prevA, prevB, a, b].some((v) => v == null)) return false;
  return up ? prevA <= prevB && a > b : prevA >= prevB && a < b;
}

/** 評估單一規則，回傳觸發訊息或 null */
export async function evaluate(a, quote, positions) {
  const px = quote?.price;
  const chg = quote && quote.prev ? ((px - quote.prev) / quote.prev) * 100 : 0;
  const v = Number(a.value);
  switch (a.type) {
    case 'price_above': return px >= v ? `股價 ${px} 已達 ${v} 元` : null;
    case 'price_below': return px <= v ? `股價 ${px} 已跌至 ${v} 元以下` : null;
    case 'change_up': return chg >= v ? `今日上漲 ${chg.toFixed(2)}%` : null;
    case 'change_down': return chg <= -v ? `今日下跌 ${chg.toFixed(2)}%` : null;
    case 'stop_loss':
    case 'take_profit': {
      const p = positions.find((x) => x.code === a.code && x.shares > 0);
      if (!p) return null;
      const r = ((px - p.avg) / p.avg) * 100;
      if (a.type === 'stop_loss' && r <= -v) return `持股虧損 ${r.toFixed(2)}%（均價 ${p.avg.toFixed(2)}），已達停損條件`;
      if (a.type === 'take_profit' && r >= v) return `持股獲利 ${r.toFixed(2)}%（均價 ${p.avg.toFixed(2)}），已達停利條件`;
      return null;
    }
    case 'ma20_up':
    case 'ma20_down': {
      const bars = await getBars(a.code);
      const c = bars.map((b) => b.close);
      if (px && quote?.realtime) c[c.length - 1] = px;
      const m = sma(c, 20), n = c.length - 1;
      return crossed(c[n - 1], m[n - 1], c[n], m[n], a.type === 'ma20_up')
        ? `收盤 ${c[n]} ${a.type === 'ma20_up' ? '突破' : '跌破'} 月線 ${m[n].toFixed(2)}` : null;
    }
    case 'kd_golden':
    case 'kd_death': {
      const bars = await getBars(a.code);
      const { K, D } = kd(bars), n = bars.length - 1;
      return crossed(K[n - 1], D[n - 1], K[n], D[n], a.type === 'kd_golden')
        ? `KD ${a.type === 'kd_golden' ? '黃金' : '死亡'}交叉（K ${K[n].toFixed(1)} / D ${D[n].toFixed(1)}）` : null;
    }
    case 'trust_streak': {
      const chips = await getChips(a.code);
      const s = streak(chips.map((x) => x.trust));
      return s >= v ? `投信已連買 ${s} 日` : null;
    }
    case 'foreign_buy':
    case 'foreign_sell': {
      const chips = await getChips(a.code);
      const l = chips[chips.length - 1];
      if (!l) return null;
      if (a.type === 'foreign_buy' && l.foreign >= v) return `外資 ${l.date} 買超 ${l.foreign.toLocaleString()} 張`;
      if (a.type === 'foreign_sell' && -l.foreign >= v) return `外資 ${l.date} 賣超 ${(-l.foreign).toLocaleString()} 張`;
      return null;
    }
  }
  return null;
}

/** 檢查全部規則；同一規則同一天只通知一次 */
export async function checkAll() {
  const active = state.alerts.filter((a) => a.enabled);
  if (!active.length) return [];
  const codes = [...new Set(active.map((a) => a.code))];
  const quotes = await getQuotes(codes);
  const positions = buildPositions(state.trades, state.settings);
  const today = new Date().toISOString().slice(0, 10);
  const fired = [];
  for (const a of active) {
    let msg = null;
    try { msg = await evaluate(a, quotes[a.code], positions); } catch (_) { /* 略過 */ }
    if (msg && a.lastFired !== today) {
      a.lastFired = today;
      const side = SIDE(a.type);
      const entry = { id: uid(), ts: Date.now(), code: a.code, side, title: `${side === 'buy' ? '🔴 買進提醒' : '🟢 賣出提醒'}｜${a.code} ${nameOf(a.code)}`, msg };
      state.alertLog.unshift(entry);
      fired.push(entry);
      await notify(entry.title, msg, a.code);
    }
  }
  if (fired.length) {
    state.alertLog = state.alertLog.slice(0, 200);
    persist('alerts', 'alertLog');
  }
  return fired;
}

export async function notify(title, body, tag) {
  if (!state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, tag: `${tag}-${Date.now()}`, icon: 'icon.svg', badge: 'icon.svg', data: { code: tag } };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (_) { /* 某些瀏覽器僅允許在 SW 中顯示 */ }
}

/** 匯出給 GitHub Actions 推播服務使用的設定檔（alerts.json） */
export function exportConfig() {
  const positions = buildPositions(state.trades, state.settings)
    .filter((p) => p.shares > 0)
    .map((p) => ({ code: p.code, shares: p.shares, avg: +p.avg.toFixed(4) }));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    alerts: state.alerts.filter((a) => a.enabled).map(({ id, code, type, value }) => ({ id, code, type, value })),
    positions,
  };
}
