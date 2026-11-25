// 抓取上市（TWSE OpenAPI）＋上櫃（TPEx OpenAPI）全部個股當日成交資料，輸出 data/market.json
// 交易所 API 不允許瀏覽器跨站讀取，所以由 GitHub Actions 收盤後執行，把結果存進網站目錄
//
// 用法：node stock-app/scripts/fetch-market.mjs [--stocks 2330,2345]
//   --stocks：另外把這些個股的 FinMind 日 K／法人／融資資料存成 data/stocks/<code>.json（離線快照）
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TWSE = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const KEEP = /^(\d{4}|00\d{2,4}[A-Z]?)$/; // 一般股票與 ETF，排除權證、債券等

const num = (s) => { const v = parseFloat(String(s ?? '').replace(/[,+\s]/g, '')); return Number.isFinite(v) ? v : null; };
const rocDate = (s) => { const m = String(s || '').match(/^(\d{2,3})(\d{2})(\d{2})$/); return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null; };

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === 2) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// 欄位：代號, 名稱, 市場(T上市/O上櫃), 收盤, 漲跌, 成交量(張), 成交金額(元), 開, 高, 低, 成交筆數
function row(code, name, mkt, close, chg, shares, value, open, high, low, trades) {
  return [code, name.trim(), mkt, close, chg ?? 0, Math.round(shares / 1000), Math.round(value), open, high, low, trades];
}

async function market() {
  const [twse, tpex] = await Promise.all([getJSON(TWSE), getJSON(TPEX)]);
  const rows = [];
  const dates = new Set();
  for (const r of twse) {
    const close = num(r.ClosingPrice);
    if (!KEEP.test(r.Code) || close == null) continue;
    dates.add(rocDate(r.Date));
    rows.push(row(r.Code, r.Name, 'T', close, num(r.Change), num(r.TradeVolume) || 0, num(r.TradeValue) || 0,
      num(r.OpeningPrice), num(r.HighestPrice), num(r.LowestPrice), num(r.Transaction) || 0));
  }
  for (const r of tpex) {
    const close = num(r.Close);
    if (!KEEP.test(r.SecuritiesCompanyCode) || close == null) continue;
    dates.add(rocDate(r.Date));
    rows.push(row(r.SecuritiesCompanyCode, r.CompanyName, 'O', close, num(r.Change), num(r.TradingShares) || 0,
      num(r.TransactionAmount) || 0, num(r.Open), num(r.High), num(r.Low), num(r.TransactionNumber) || 0));
  }
  if (rows.length < 500) throw new Error(`資料筆數異常：${rows.length}`);
  rows.sort((a, b) => b[5] - a[5]);
  const date = [...dates].filter(Boolean).sort().pop();
  const out = {
    date, updated: new Date().toISOString(), source: 'TWSE OpenAPI / TPEx OpenAPI',
    fields: ['code', 'name', 'market', 'close', 'change', 'volume', 'value', 'open', 'high', 'low', 'trades'],
    rows,
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'market.json'), JSON.stringify(out));
  console.log(`market.json：${date}，${rows.length} 檔（上市 ${rows.filter((r) => r[2] === 'T').length}、上櫃 ${rows.filter((r) => r[2] === 'O').length}）`);
  console.log('成交量前 5：', rows.slice(0, 5).map((r) => `${r[0]} ${r[1]} ${r[5].toLocaleString()} 張`).join('、'));
}

async function stockSnapshots(codes) {
  const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const fm = async (dataset, id) => {
    const q = new URLSearchParams({ dataset, data_id: id, start_date: start });
    if (process.env.FINMIND_TOKEN) q.set('token', process.env.FINMIND_TOKEN);
    const j = await getJSON(`https://api.finmindtrade.com/api/v4/data?${q}`);
    if (j.status !== 200) throw new Error(j.msg);
    return j.data;
  };
  await mkdir(join(root, 'stocks'), { recursive: true });
  for (const code of codes) {
    const [price, inst, margin] = await Promise.all([
      fm('TaiwanStockPrice', code),
      fm('TaiwanStockInstitutionalInvestorsBuySell', code),
      fm('TaiwanStockMarginPurchaseShortSale', code).catch(() => []),
    ]);
    // 只保留 App 用得到的欄位，縮小檔案
    const snap = {
      updated: new Date().toISOString(),
      price: price.map(({ date, open, max, min, close, Trading_Volume }) => ({ date, open, max, min, close, Trading_Volume })),
      inst: inst.map(({ date, name, buy, sell }) => ({ date, name, buy, sell })),
      margin: margin.map(({ date, MarginPurchaseTodayBalance, MarginPurchaseYesterdayBalance, ShortSaleTodayBalance }) =>
        ({ date, MarginPurchaseTodayBalance, MarginPurchaseYesterdayBalance, ShortSaleTodayBalance })),
    };
    await writeFile(join(root, 'stocks', `${code}.json`), JSON.stringify(snap));
    console.log(`stocks/${code}.json：${price.length} 天`);
  }
}

const i = process.argv.indexOf('--stocks');
await market();
if (i > 0) await stockSnapshots(process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
