// Cloudflare Worker：讓瀏覽器能讀取證交所即時行情（解決 CORS）
// 部署：Cloudflare 後台 → Workers → 建立 → 貼上本檔 → 部署，把網址填到 App「設定 → 即時報價代理網址」
// 只轉送 mis.twse.com.tw 的 getStockInfo，並限制參數格式，避免被當成開放代理
export default {
  async fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Cache-Control': 'max-age=5' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const exch = new URL(req.url).searchParams.get('ex_ch') || '';
    if (!/^((tse|otc)_\w{4,6}\.tw\|?){1,60}$/.test(exch)) return new Response('bad ex_ch', { status: 400, headers: cors });
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/' } });
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
  },
};
