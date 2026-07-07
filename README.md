# 血壓記錄 App

純前端網頁 App（PWA），可記錄每日血壓／心跳，具備：新增、編輯、刪除紀錄、趨勢折線圖、依血壓標準自動分級（正常／偏高／第一期／第二期／危象）、近 7 天平均、CSV 匯出。資料儲存在手機瀏覽器的 localStorage，不需要網路或帳號。

## 本機測試（在電腦上）

```
node serve.js
```

再用瀏覽器開啟 http://localhost:5173

## 安裝到 Android 手機

Service Worker（離線快取＋「加入主畫面」安裝功能）只有在 **https** 或 **localhost** 才會啟用，所以要讓手機真正「安裝」這個 App，需要把這個資料夾放到一個網址上，例如：

1. **GitHub Pages / Netlify / Vercel**：把 `blood-pressure-tracker` 資料夾內容部署上去（皆有免費方案），取得一個 https 網址。
2. 用手機 Chrome 開啟該網址。
3. 點右上角「⋮」選單 →「新增至主畫面」或「安裝應用程式」。
4. 之後就會像一般 App 一樣有圖示，可離線使用、資料留在手機本機。

若只是想在同一個 Wi-Fi 下用手機瀏覽器直接使用（不需要真的「安裝」），也可以：
1. 在電腦上執行 `node serve.js`。
2. 查詢電腦的區網 IP（例如 `ipconfig` 看到的 192.168.x.x）。
3. 手機瀏覽器開啟 `http://192.168.x.x:5173`，即可使用（此模式無法安裝為獨立 App，也無離線快取）。

## 檔案結構

- `index.html` / `style.css` / `app.js`：主程式
- `manifest.json` / `sw.js`：PWA 安裝與離線快取設定
- `icons/`：App 圖示
- `serve.js`：本機測試用的簡易伺服器
