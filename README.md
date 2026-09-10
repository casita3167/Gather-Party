# Gather Party：GitHub 原生 TRPG 約團日曆

網站會讀取 GitHub Issue、留言與 `adventures/` 裡的 Markdown，在 GitHub Pages 顯示目前招募、時間交集與正式場次。

原本使用 Firebase 的快速約團頁保留在 `legacy.html`；舊分享網址的 `#event=...` 會自動轉過去，因此既有約團資料仍可使用。

## 使用流程

### 1. 發起揪團

1. 到倉庫的 **Issues → New issue**，選擇「揪團與時間協調」。
2. GM 填寫團務資訊，並將候選時段換成實際日期。
3. 玩家複製 Issue 內的回覆表格到留言，以 `O`、`X`、`▲` 表示能否參加。
4. 網站會讀取標記 `揪團`，或標題以 `[揪團]` 開頭的未關閉 Issue：
   - 所有人都填 `O`：綠色「完美交集」。
   - 所有人都填 `O` 或 `▲`，但至少一人為 `▲`：黃色「候選時段」。
   - 缺少回覆或有人填 `X`：不列入交集。

> 請勿更改 Issue 表格的「日期／時段」結構。時段限用：`全天`、`早上`、`下午`、`晚上`、`時間由GM決定`。

### 2. 建立正式場次

複製 `adventures/example.md`，改成容易辨識且不含空白的檔名。網站會讀取 YAML Front Matter：

```yaml
---
title: "瘋狂山脈的呼喚"
date: 2026-10-15
time: "20:00 - 24:00"
system: "CoC 7th"
gm: "GM 名稱"
status: "已成團"
links:
  character: "https://角色卡網址"
  discord: "https://discord.gg/..."
  ccfolia: "https://ccfolia.com/..."
  fvtt: ""
---
```

狀態色彩：

- `已成團`：綠色。
- `待協調`：黃色。
- `有人請假`：紅色。

玩家要請假或提議改期時，可編輯該 Markdown 並發起 Pull Request。GM Merge 後，GitHub Pages 下一次載入就會反映變更。

## 網站設定

倉庫與資料夾設定集中在 `github-config.js`。GitHub Pages 請使用 `main` 分支的根目錄發布。

這是無後端的公開網站，使用 GitHub 公開 API；未登入訪客通常每小時可讀取 60 次。網站只抓取最多 20 張開放中的揪團 Issue，單一 Issue 最多解析 100 則留言。若團務很多，建議關閉已結束的 Issue。
