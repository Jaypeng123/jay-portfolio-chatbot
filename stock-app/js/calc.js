// 台股交易成本試算
export const FEE_RATE = 0.001425;

export function isETF(code) { return /^00/.test(code || ''); }
export function isBondETF(code) { return /^00\d{3,4}B$/i.test(code || ''); }

/** 證交稅率：一般股 0.3%、ETF 0.1%、債券 ETF 免稅（至 2026/12/31）、現股當沖 0.15% */
export function taxRate(code, { dayTrade = false } = {}) {
  if (isBondETF(code)) return 0;
  if (isETF(code)) return 0.001;
  return dayTrade ? 0.0015 : 0.003;
}

/** 升降單位（tick） */
export function tickSize(price, code) {
  if (isETF(code)) return price < 50 ? 0.01 : 0.05;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

export function roundTick(price, code, dir = 'up') {
  const t = tickSize(price, code);
  const n = price / t;
  const r = dir === 'up' ? Math.ceil(n - 1e-9) : dir === 'down' ? Math.floor(n + 1e-9) : Math.round(n);
  return +(r * t).toFixed(2);
}

export function fee(amount, shares, s) {
  if (amount <= 0) return 0;
  const min = shares % 1000 === 0 ? s.minFee : s.minFeeOdd;
  return Math.max(Math.floor(amount * FEE_RATE * s.feeDiscount), min);
}

export function tax(amount, code, opts) {
  return Math.floor(amount * taxRate(code, opts));
}

/** 買進成本 */
export function buyCost(price, shares, s) {
  const amount = price * shares;
  const f = fee(amount, shares, s);
  return { amount, fee: f, total: amount + f };
}

/** 賣出實收 */
export function sellProceeds(price, shares, code, s, opts) {
  const amount = price * shares;
  const f = fee(amount, shares, s);
  const t = tax(amount, code, opts);
  return { amount, fee: f, tax: t, net: amount - f - t };
}

/** 完整來回試算 */
export function roundTrip({ code, buyPrice, sellPrice, shares, dayTrade = false }, s) {
  const b = buyCost(buyPrice, shares, s);
  const sl = sellProceeds(sellPrice, shares, code, s, { dayTrade });
  const pnl = sl.net - b.total;
  return {
    buy: b, sell: sl, pnl,
    roi: b.total ? pnl / b.total : 0,
    breakEven: breakEvenPrice(b.total, shares, code, s, { dayTrade }),
  };
}

/** 損益兩平賣價（含手續費與稅，進位至最近升降單位） */
export function breakEvenPrice(totalCost, shares, code, s, opts) {
  if (!shares) return 0;
  const k = 1 - FEE_RATE * s.feeDiscount - taxRate(code, opts);
  let p = totalCost / (shares * k);
  p = roundTick(p, code, 'up');
  // 最低手續費可能讓理論價不足，往上逐檔補足
  for (let i = 0; i < 50 && sellProceeds(p, shares, code, s, opts).net < totalCost; i++) {
    p = roundTick(p + tickSize(p, code), code, 'up');
  }
  return p;
}

/** 目標報酬率所需賣價 */
export function targetPrice(totalCost, shares, code, s, roi, opts) {
  return breakEvenPrice(totalCost * (1 + roi), shares, code, s, opts);
}

/** 依風險金額計算部位：最多可虧 riskAmt，停損價 stop */
export function positionSize({ entry, stop, riskAmt, capital }) {
  const perShare = entry - stop;
  if (perShare <= 0) return null;
  let shares = Math.floor(riskAmt / perShare);
  if (capital) shares = Math.min(shares, Math.floor(capital / entry));
  return { shares, lots: Math.floor(shares / 1000), odd: shares % 1000, cost: shares * entry, perShare };
}

/** 攤平試算：已有部位 + 新買進後的均價 */
export function averageDown(curShares, curAvg, addShares, addPrice) {
  const total = curShares + addShares;
  if (!total) return 0;
  return (curShares * curAvg + addShares * addPrice) / total;
}

/** 由交易紀錄算出庫存（平均成本法，成本含買進手續費） */
export function buildPositions(trades, s) {
  const pos = {};
  const sorted = [...trades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const t of sorted) {
    const p = (pos[t.code] ||= { code: t.code, shares: 0, cost: 0, realized: 0, trades: 0 });
    p.trades++;
    const amount = t.price * t.shares;
    if (t.side === 'buy') {
      const f = t.fee ?? fee(amount, t.shares, s);
      p.shares += t.shares;
      p.cost += amount + f;
    } else {
      const sellShares = Math.min(t.shares, p.shares);
      if (!sellShares) continue;
      const f = t.fee ?? fee(amount, t.shares, s);
      const tx = t.tax ?? tax(amount, t.code);
      const avg = p.cost / p.shares;
      p.realized += amount - f - tx - avg * sellShares;
      p.cost -= avg * sellShares;
      p.shares -= sellShares;
    }
  }
  return Object.values(pos).map((p) => ({ ...p, avg: p.shares ? p.cost / p.shares : 0 }));
}
