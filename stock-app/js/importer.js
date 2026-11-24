// 匯入券商／集保匯出的 CSV（自動偵測 UTF-8 / Big5 編碼與欄位）
import { uid } from './store.js';

export async function readFileText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try { text = new TextDecoder('big5').decode(buf); } catch (_) { /* 保留 utf-8 */ }
  }
  return text.replace(/^﻿/, '');
}

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const COLS = {
  code: ['股票代號', '證券代號', '商品代號', '代號', '股號', '代碼', 'code', 'symbol'],
  name: ['股票名稱', '證券名稱', '商品名稱', '名稱', 'name'],
  side: ['買賣別', '買賣', '交易類別', '交易別', '類別', 'side'],
  shares: ['成交股數', '庫存股數', '股數', '集保庫存', '庫存數量', '數量', '餘額', 'shares', 'qty'],
  lots: ['張數', '庫存張數'],
  price: ['成交均價', '成交價格', '成交價', '持有均價', '平均成本', '成本均價', '均價', '單價', 'price', 'avg'],
  fee: ['手續費', 'fee'],
  tax: ['交易稅', '證交稅', 'tax'],
  date: ['成交日期', '交易日期', '日期', 'date'],
};

function findCol(header, keys) {
  for (const k of keys) {
    const i = header.findIndex((h) => h.replace(/\s/g, '').toLowerCase() === k.toLowerCase());
    if (i >= 0) return i;
  }
  for (const k of keys) {
    const i = header.findIndex((h) => h.replace(/\s/g, '').toLowerCase().includes(k.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

const num = (s) => {
  const v = parseFloat(String(s ?? '').replace(/[,\s元股$]/g, ''));
  return isFinite(v) ? v : 0;
};

function normDate(s) {
  if (!s) return new Date().toISOString().slice(0, 10);
  const m = String(s).match(/(\d{2,4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!m) return new Date().toISOString().slice(0, 10);
  let y = +m[1];
  if (y < 1911) y += 1911; // 民國年
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 將 CSV 轉成交易紀錄。
 * - 有「買賣別」欄位 → 視為成交明細（逐筆買／賣）
 * - 沒有 → 視為庫存（每檔建立一筆「期初買進」）
 */
export function toTrades(rows) {
  const hi = rows.findIndex((r) => findCol(r, COLS.code) >= 0);
  if (hi < 0) throw new Error('找不到「股票代號」欄位，請確認 CSV 標題列');
  const header = rows[hi];
  const c = Object.fromEntries(Object.entries(COLS).map(([k, keys]) => [k, findCol(header, keys)]));
  if (c.price < 0) throw new Error('找不到「均價／成交價」欄位');
  const isLedger = c.side >= 0;
  const trades = [];
  for (const r of rows.slice(hi + 1)) {
    const code = String(r[c.code] || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (!/^\w{4,6}$/.test(code)) continue;
    let shares = c.shares >= 0 ? num(r[c.shares]) : 0;
    if (!shares && c.lots >= 0) shares = num(r[c.lots]) * 1000;
    const price = num(r[c.price]);
    if (!shares || !price) continue;
    const sideRaw = isLedger ? String(r[c.side]) : '買';
    const side = /賣|sell|^S$/i.test(sideRaw) ? 'sell' : 'buy';
    const t = { id: uid(), date: normDate(c.date >= 0 ? r[c.date] : ''), code, side, shares: Math.abs(shares), price, note: isLedger ? '匯入' : '匯入庫存' };
    if (c.fee >= 0 && r[c.fee] !== '') t.fee = num(r[c.fee]);
    if (c.tax >= 0 && r[c.tax] !== '') t.tax = num(r[c.tax]);
    trades.push(t);
  }
  return { trades, kind: isLedger ? '成交明細' : '庫存' };
}
