// 背景推播：由 GitHub Actions 盤中定時執行，條件成立時推播到手機（ntfy / Telegram）
// 用法：node stock-app/notifier/check-alerts.mjs
// 環境變數：NTFY_TOPIC、NTFY_SERVER（預設 https://ntfy.sh）、TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID、FINMIND_TOKEN（皆選填）
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sma, kd, streak } from '../js/indicators.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.ALERTS_FILE || join(here, 'alerts.json');
const STATE = process.env.STATE_FILE || join(here, '.state.json');
const env = process.env;

const twNow = () => new Date(Date.now() + 8 * 3600e3);
const today = () => twNow().toISOString().slice(0, 10);

async function readJSON(p, fb) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fb; } }

/* ---------- 證交所即時行情（上市 tse / 上櫃 otc 都查） ---------- */
async function realtime(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 20) {
    const chunk = codes.slice(i, i + 20);
    const exch = chunk.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join('|');
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0&_=${Date.now()}`;
    try {
      const j = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } })).json();
      for (const m of j.msgArray || []) {
        let px = parseFloat(m.z);
        if (!isFinite(px)) px = parseFloat((m.b || '').split('_')[0]) || +m.y;
        out[m.c] = { price: px, prev: +m.y, name: m.n };
      }
    } catch (e) { console.warn('realtime failed', e.message); }
  }
  return out;
}

/* ---------- FinMind 日 K 與籌碼 ---------- */
async function finmind(dataset, id) {
  const start = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({ dataset, data_id: id, start_date: start });
  if (env.FINMIND_TOKEN) q.set('token', env.FINMIND_TOKEN);
  const j = await (await fetch(`https://api.finmindtrade.com/api/v4/data?${q}`)).json();
  if (j.status !== 200) throw new Error(j.msg);
  return j.data;
}
const memo = {};
async function bars(code) {
  return (memo[`b${code}`] ||= finmind('TaiwanStockPrice', code).then((r) =>
    r.filter((x) => x.close > 0).map((x) => ({ date: x.date, open: x.open, high: x.max, low: x.min, close: x.close }))));
}
async function chips(code) {
  return (memo[`c${code}`] ||= finmind('TaiwanStockInstitutionalInvestorsBuySell', code).then((rows) => {
    const by = {};
    for (const r of rows) {
      const d = (by[r.date] ||= { date: r.date, foreign: 0, trust: 0 });
      const net = (r.buy - r.sell) / 1000;
      if (r.name.startsWith('Foreign')) d.foreign += net;
      if (r.name === 'Investment_Trust') d.trust += net;
    }
    return Object.values(by).sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, foreign: Math.round(d.foreign), trust: Math.round(d.trust) }));
  }));
}

const crossed = (pa, pb, a, b, up) => [pa, pb, a, b].every((v) => v != null) && (up ? pa <= pb && a > b : pa >= pb && a < b);

async function evaluate(a, q, positions) {
  const v = Number(a.value);
  const px = q?.price;
  if (px == null && /^(price|change|stop|take)/.test(a.type)) return null;
  const chg = q?.prev ? ((px - q.prev) / q.prev) * 100 : 0;
  switch (a.type) {
    case 'price_above': return px >= v ? `股價 ${px} 已達 ${v} 元` : null;
    case 'price_below': return px <= v ? `股價 ${px} 已跌至 ${v} 元以下` : null;
    case 'change_up': return chg >= v ? `今日上漲 ${chg.toFixed(2)}%` : null;
    case 'change_down': return chg <= -v ? `今日下跌 ${chg.toFixed(2)}%` : null;
    case 'stop_loss':
    case 'take_profit': {
      const p = positions.find((x) => x.code === a.code);
      if (!p) return null;
      const r = ((px - p.avg) / p.avg) * 100;
      if (a.type === 'stop_loss' && r <= -v) return `虧損 ${r.toFixed(2)}%（均價 ${p.avg}），達停損條件`;
      if (a.type === 'take_profit' && r >= v) return `獲利 ${r.toFixed(2)}%（均價 ${p.avg}），達停利條件`;
      return null;
    }
    case 'ma20_up':
    case 'ma20_down': {
      const c = (await bars(a.code)).map((b) => b.close);
      if (px && c.length) { if ((await bars(a.code)).at(-1).date !== today()) c.push(px); else c[c.length - 1] = px; }
      const m = sma(c, 20), n = c.length - 1;
      return crossed(c[n - 1], m[n - 1], c[n], m[n], a.type === 'ma20_up') ? `股價 ${c[n]} ${a.type === 'ma20_up' ? '突破' : '跌破'}月線 ${m[n].toFixed(2)}` : null;
    }
    case 'kd_golden':
    case 'kd_death': {
      const b = await bars(a.code);
      const { K, D } = kd(b), n = b.length - 1;
      return crossed(K[n - 1], D[n - 1], K[n], D[n], a.type === 'kd_golden') ? `KD ${a.type === 'kd_golden' ? '黃金' : '死亡'}交叉（K ${K[n].toFixed(1)}）` : null;
    }
    case 'trust_streak': {
      const s = streak((await chips(a.code)).map((x) => x.trust));
      return s >= v ? `投信已連買 ${s} 日` : null;
    }
    case 'foreign_buy':
    case 'foreign_sell': {
      const l = (await chips(a.code)).at(-1);
      if (!l) return null;
      if (a.type === 'foreign_buy' && l.foreign >= v) return `外資 ${l.date} 買超 ${l.foreign} 張`;
      if (a.type === 'foreign_sell' && -l.foreign >= v) return `外資 ${l.date} 賣超 ${-l.foreign} 張`;
      return null;
    }
  }
  return null;
}

const SELL = new Set(['price_below', 'change_down', 'stop_loss', 'take_profit', 'ma20_down', 'kd_death', 'foreign_sell']);

async function push(title, body, type) {
  const sent = [];
  if (env.NTFY_TOPIC) {
    const server = env.NTFY_SERVER || 'https://ntfy.sh';
    const res = await fetch(server, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: body, priority: 4,
        tags: [SELL.has(type) ? 'chart_with_downwards_trend' : 'chart_with_upwards_trend'] }),
    });
    sent.push(`ntfy ${res.status}`);
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${title}\n${body}` }),
    });
    sent.push(`telegram ${res.status}`);
  }
  return sent;
}

async function main() {
  const cfg = await readJSON(CONFIG, null);
  if (!cfg?.alerts?.length) { console.log(`沒有提醒規則（${CONFIG}）`); return; }
  if (!env.NTFY_TOPIC && !env.TELEGRAM_BOT_TOKEN) console.warn('未設定 NTFY_TOPIC 或 TELEGRAM_BOT_TOKEN，只會印出結果不推播');
  const state = await readJSON(STATE, {});
  const codes = [...new Set(cfg.alerts.map((a) => a.code))];
  const quotes = await realtime(codes);
  let count = 0;
  for (const a of cfg.alerts) {
    const key = `${a.id || `${a.code}-${a.type}-${a.value}`}`;
    if (state[key] === today()) continue;
    let msg = null;
    try { msg = await evaluate(a, quotes[a.code], cfg.positions || []); } catch (e) { console.warn(a.code, a.type, e.message); }
    if (!msg) continue;
    const name = quotes[a.code]?.name || '';
    const title = `${SELL.has(a.type) ? '賣出提醒' : '買進提醒'}｜${a.code} ${name}`;
    const r = await push(title, msg, a.type);
    console.log(`[觸發] ${title} - ${msg} ${r.join(', ')}`);
    state[key] = today();
    count++;
  }
  await writeFile(STATE, JSON.stringify(state));
  console.log(`檢查 ${cfg.alerts.length} 條規則，觸發 ${count} 則`);
}
main().catch((e) => { console.error(e); process.exit(1); });
