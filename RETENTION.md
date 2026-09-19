# 三個月未使用自動刪除（待部署）
每天臺灣時間 04:00 執行，最後開啟或更新後滿三個日曆月清除。
月末日期會對齊到期月份的最後一天。開放與已結束約團都適用。
初次掃描的舊表給予三個月寬限期，不根據舊建立日期立即刪除。
刪除包含 responses、managementTokens、managers 及其他子集合。
Cloudflare KV 的短網址對照仍存在，但對應約團已不存在。
清理先以交易鎖定，禁止後续前端寫入；失敗時下次繼續移除子集合，最後刪主文件。

## 啟用
需要 Firebase 專案管理權限、可部署 Cloud Functions 的計費方案及 Cloud Scheduler API。
本提交沒有開啟計費、沒有部署定時工作，也沒有刪除既有資料。
1. 安裝後端相依套件：`npm --prefix retention-functions install`。
2. 登入專案的 Firebase CLI：`npx firebase-tools login`。
3. 先发布规则：`npx firebase-tools deploy --config firebase.retention.json --project gather-party-394dd --only firestore:rules`。
4. 發布包含最後開啟紀錄的網站版本，確認玩家與管理者開啟都會更新 lastOpenedAt。
5. 部署工作：`npx firebase-tools deploy --config firebase.retention.json --project gather-party-394dd --only functions:retention`。
6. 檢查 Cloud Scheduler 執行記錄與 Functions 日誌。
前端與規則必須先上線再啟用清理，否則無法正確記錄訪問。
`node --test retention-functions/policy.test.js` 可驗證日期政策。
部署前應在 Emulator 驗證規則：訪客僅能更新 serverTimestamp 的 lastOpenedAt，
不得修改權限／刪除旗標；清理鎖定後全部子集合寫入被拒絕。
