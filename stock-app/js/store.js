// 本機儲存：所有讀寫都包在 try/catch，無痕模式或封鎖儲存時仍可運作（退回記憶體）
const mem = {};
const PREFIX = 'twstock:';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return key in mem ? mem[key] : structuredClone(fallback);
}

export function save(key, value) {
  mem[key] = value;
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (_) { /* ignore */ }
}

export const DEFAULT_SETTINGS = {
  theme: 'system',          // system | light | dark
  finmindToken: '',
  quoteProxy: '',           // 即時報價代理（Cloudflare Worker URL），選填
  feeDiscount: 0.6,         // 手續費折數（6 折 = 0.6）
  minFee: 20,               // 整股最低手續費
  minFeeOdd: 1,             // 零股最低手續費
  refreshSec: 60,           // 自動更新秒數
  useDemo: false,           // 強制使用示範資料
  notify: true,
};

export const state = {
  settings: { ...DEFAULT_SETTINGS, ...load('settings', {}) },
  watchlist: load('watchlist', ['2330', '2345', '2454', '2317', '0050']),
  trades: load('trades', []),       // {id,date,code,side:'buy'|'sell',shares,price,fee?,tax?,note?}
  alerts: load('alerts', []),       // {id,code,type,value,enabled,lastFired?}
  alertLog: load('alertLog', []),   // {ts,code,msg}
};

export function persist(...keys) {
  for (const k of keys) save(k, state[k]);
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
