// 技術指標：輸入 K 線陣列 [{date,open,high,low,close,volume}]
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = i >= n - 1 ? prev : null;
  }
  return out;
}

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** KD(9,3,3)，台股常用算法 */
export function kd(bars, n = 9) {
  const K = new Array(bars.length).fill(null), D = new Array(bars.length).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

export function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const dif = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = dif.findIndex((v) => v != null);
  const dea = new Array(closes.length).fill(null);
  if (start >= 0) {
    const sub = ema(dif.slice(start), sig);
    sub.forEach((v, i) => { dea[start + i] = v; });
  }
  const hist = dif.map((v, i) => (v != null && dea[i] != null ? v - dea[i] : null));
  return { dif, dea, hist };
}

const last = (a, back = 0) => a[a.length - 1 - back];

/** 綜合訊號：回傳分數 -100~100 與文字理由 */
export function signals(bars, chips) {
  if (!bars || bars.length < 30) return { score: 0, items: [] };
  const c = bars.map((b) => b.close);
  const ma5 = sma(c, 5), ma20 = sma(c, 20), ma60 = sma(c, 60);
  const { K, D } = kd(bars);
  const r = rsi(c);
  const m = macd(c);
  const items = [];
  const add = (w, text) => items.push({ w, text });
  const px = last(c);

  if (last(ma20) != null) add(px > last(ma20) ? 15 : -15, px > last(ma20) ? '站上月線（MA20）' : '跌破月線（MA20）');
  if (last(ma60) != null) add(px > last(ma60) ? 10 : -10, px > last(ma60) ? '站上季線（MA60）' : '位於季線之下');
  if (last(ma5) != null && last(ma20) != null && last(ma5, 1) != null && last(ma20, 1) != null) {
    if (last(ma5, 1) <= last(ma20, 1) && last(ma5) > last(ma20)) add(15, '5 日線上穿 20 日線（黃金交叉）');
    if (last(ma5, 1) >= last(ma20, 1) && last(ma5) < last(ma20)) add(-15, '5 日線下穿 20 日線（死亡交叉）');
  }
  if (last(K) != null && last(K, 1) != null) {
    if (last(K, 1) <= last(D, 1) && last(K) > last(D)) add(last(K) < 30 ? 20 : 10, `KD 黃金交叉（K=${last(K).toFixed(0)}）`);
    if (last(K, 1) >= last(D, 1) && last(K) < last(D)) add(last(K) > 70 ? -20 : -10, `KD 死亡交叉（K=${last(K).toFixed(0)}）`);
    if (last(K) > 80) add(-5, 'KD 高檔鈍化區（>80）');
    if (last(K) < 20) add(5, 'KD 低檔區（<20）');
  }
  if (last(r) != null) {
    if (last(r) > 70) add(-10, `RSI 過熱（${last(r).toFixed(0)}）`);
    else if (last(r) < 30) add(10, `RSI 超賣（${last(r).toFixed(0)}）`);
  }
  if (last(m.hist) != null && last(m.hist, 1) != null) {
    if (last(m.hist, 1) <= 0 && last(m.hist) > 0) add(10, 'MACD 柱狀體翻正');
    if (last(m.hist, 1) >= 0 && last(m.hist) < 0) add(-10, 'MACD 柱狀體翻負');
  }
  if (chips?.length) {
    const st = streak(chips.map((x) => x.trust));
    if (st >= 3) add(15, `投信連買 ${st} 日`);
    if (st <= -3) add(-15, `投信連賣 ${-st} 日`);
    const f5 = chips.slice(-5).reduce((s, x) => s + x.foreign, 0);
    if (f5 > 0) add(8, `外資近 5 日買超 ${fmtLots(f5)}`);
    if (f5 < 0) add(-8, `外資近 5 日賣超 ${fmtLots(-f5)}`);
    const r5 = chips.slice(-5).reduce((s, x) => s + (x.retail ?? 0), 0);
    if (r5 > 0 && f5 < 0) add(-6, '散戶融資增、法人減：籌碼渙散');
  }
  const score = Math.max(-100, Math.min(100, items.reduce((s, x) => s + x.w, 0)));
  return { score, items, ma5, ma20, ma60, K, D, rsi: r, macd: m };
}

/** 連續買(+)/賣(-)天數 */
export function streak(arr) {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (!v) break;
    if (n === 0) n = v > 0 ? 1 : -1;
    else if ((v > 0) === (n > 0)) n += n > 0 ? 1 : -1;
    else break;
  }
  return n;
}

export function fmtLots(n) { return `${Math.round(n).toLocaleString('zh-TW')} 張`; }
