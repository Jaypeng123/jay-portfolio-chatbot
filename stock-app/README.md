# 台股籌碼決策（TW Equity Desk）

純前端 PWA。不需要建置，可直接放上 GitHub Pages，也能在手機上「加入主畫面」當 App 用。

## 功能

| 模組 | 內容 |
|---|---|
| 總覽 | 持股市值、未實現／今日／已實現損益；自選股報價、走勢、外資／投信買賣超、投信連買天數、多空訊號；今日籌碼焦點 |
| 個股籌碼 | K 線＋MA5/20/60＋成交量，下方同步顯示 **外資、投信、自營商、主力（估）、散戶（融資增減）** 每日買賣超（參考理財節目常用的籌碼 K 線版面）；1／5／20／60 日籌碼統計與連買／連賣天數；KD、RSI、MACD、乖離率；綜合多空分數與理由；K 線上標示自己的買賣點 |
| 我的庫存 | 手動記錄交易，或匯入券商／集保 CSV（自動辨識欄位、Big5、民國年）；平均成本法（含手續費）、含費稅損益、**損益兩平價** |
| 交易試算 | 買賣損益（手續費折數、最低手續費、證交稅：一般 0.3%／ETF 0.1%／當沖 0.15%／債券 ETF 免稅）、兩平與目標價（依升降單位進位）、依風險計算部位、攤平均價 |
| 買賣提醒 | 股價上下限、漲跌幅、停損／停利（依持股均價）、突破／跌破月線、KD 黃金／死亡交叉、投信連買 N 日、外資單日買／賣超 N 張；瀏覽器通知＋**GitHub Actions 背景推播到手機** |
| 設定 | 淺色／深色／跟隨系統、手續費折數、FinMind token、即時報價代理、備份還原 |

## 資料來源

- **FinMind 開放資料**（`api.finmindtrade.com`）：日 K、三大法人買賣超、融資融券、股票清單。免 token 可用；[免費註冊](https://finmindtrade.com/) 取得 token 可提高請求上限。
- **證交所即時行情**（`mis.twse.com.tw`）：瀏覽器有 CORS 限制，需部署 `notifier/quote-proxy.js` 到 Cloudflare Workers（免費方案即可），再把網址填到「設定 → 即時報價代理網址」。沒有代理時以最新日 K 顯示，頂部標示「盤後資料」。
- 連不上 API 時自動改用**示範資料**（頂部標示「示範資料」），數值為模擬，不可作為投資依據。

**關於「主力」**：常見 App 的主力是「買超前 15 大券商分點 − 賣超前 15 大」，需要分點進出資料，屬付費資料。本 App 先以「三大法人合計」估算並標示「（估）」；散戶以融資餘額增減代表。

## 串接國泰證券／集保 e手掌握

國泰證券與集保 e手掌握目前未提供讓第三方 App 讀取個人庫存的公開 API，所以改用「匯出 → 匯入」：

1. 從國泰證券網頁版或電子交易平台匯出「成交明細／對帳單」或「庫存」（Excel 請另存為 CSV）。
2. 到「我的庫存 → 匯入 CSV」。有「買賣別」欄位視為成交明細，沒有則視為庫存快照。

可辨識的欄位名稱有：股票代號／證券代號／代號、股數／成交股數／庫存股數／張數、成交價／均價／平均成本、買賣別、成交日期、手續費、交易稅。
若之後改用有官方 API 的券商（例如永豐 Shioaji、富邦 Neo API），可以再接上自動同步。

## 手機推播（App 關閉時也會通知）

`.github/workflows/stock-alerts.yml` 在台灣時間週一到週五 09:00–13:55 每 5 分鐘、以及 15:30 執行一次 `notifier/check-alerts.mjs`，條件成立時推播。

1. App「買賣提醒」頁按 **匯出推播設定 alerts.json**，把檔案放到 `stock-app/notifier/alerts.json` 後 commit（格式見 `alerts.example.json`）。
   > 注意：alerts.json 內含持股均價與股數。若 repo 是公開的，別人看得到，介意的話請把 repo 設為私人。
2. 選一種推播方式，在 GitHub repo → Settings → Secrets and variables → Actions 新增：
   - **ntfy**（最簡單）：手機安裝 ntfy App，訂閱一個不容易被猜到的主題名稱（例如 `jay-tw-9f3k2`），設定 secret `NTFY_TOPIC` 為同一個名稱。
   - **Telegram**：找 @BotFather 建立 bot 取得 `TELEGRAM_BOT_TOKEN`，與 bot 對話後取得 `TELEGRAM_CHAT_ID`。
   - 選填：`FINMIND_TOKEN`。
3. 在 Actions 頁手動 Run workflow 一次，確認可以收到通知。

GitHub 的排程可能延遲幾分鐘，所以不適合秒級當沖；如果需要更即時，可以把同一支程式放到自己的主機或 Cloudflare Cron 上執行。

## 本機執行

```bash
cd stock-app
python3 -m http.server 8000   # 開啟 http://localhost:8000
```

ES modules 與 Service Worker 需要用 http 開啟，不能直接雙擊 `index.html`。

## 檔案結構

```
stock-app/
  index.html  styles.css  sw.js  manifest.webmanifest  icon.svg
  js/app.js         畫面與互動
  js/data.js        FinMind / 即時報價 / 示範資料
  js/calc.js        手續費、證交稅、兩平價、部位與攤平
  js/indicators.js  MA、KD、RSI、MACD、多空訊號
  js/alerts.js      提醒規則與通知
  js/importer.js    CSV 匯入
  notifier/check-alerts.mjs  背景推播（GitHub Actions）
  notifier/quote-proxy.js    即時報價 CORS 代理（Cloudflare Worker）
```

> 本工具的訊號與提醒僅供參考，不構成投資建議。投資有風險，請謹慎評估。
