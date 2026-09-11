import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, getFirestore, onSnapshot,
  query, serverTimestamp, setDoc, updateDoc, where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { holidayFor } from "./taiwan-holidays.js?v=20260910-5";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const PERIOD_KEYS = ["早上", "下午", "晚上"];
const SHORTENER_URL = "https://gather-party-link.gather-party.workers.dev";
const SHORT_LINK_PREVIEW_VERSION = 3;

let auth;
let db;
let user;
let responseMonthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let schedule = null;
let responses = [];
let choices = new Map();
let batchGroups = new Map();
let batchDates = new Set();
let batchApplied = false;
let unsubscribeResponses = null;
let canManageSchedule = false;
let managementToken = "";
let managementShortUrl = "";
let managementShortTitle = "";
let managementPreviewVersion = 0;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function taiwanTodayKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 2200);
}

function brand() {
  return `<header class="quick-brand"><a class="quick-home" href="./#"><span class="brandmark brandmark-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><span>Gather Party<small>快速約團</small></span></a><a href="./#">← 回到團務首頁</a></header>`;
}

function routeInfo() {
  const manage = location.hash.match(/^#manage=([A-Za-z0-9]+)\.([A-Za-z0-9_-]{24,})$/);
  if (manage) return { id: manage[1], token: manage[2] };
  const quick = location.hash.match(/^#quick=([A-Za-z0-9]+)$/);
  return quick ? { id: quick[1], token: "" } : { id: "", token: "" };
}

function randomManagementToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function quickUrl(id) {
  return `${new URL("./quick.html", location.href).href.split("#")[0]}#quick=${id}`;
}

function manageUrl(id, token) {
  return `${new URL("./quick.html", location.href).href.split("#")[0]}#manage=${id}.${token}`;
}

async function createShortUrl(target, type, title = "") {
  const response = await fetch(`${SHORTENER_URL}/api/shorten`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target,
      type,
      title: title.trim().slice(0, 80),
      description: type === "player" ? "打開月曆，填寫你可以跑團的日期與時段。" : ""
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.shortUrl) throw new Error(result.error || "短網址建立失敗");
  return result.shortUrl;
}

function dateLabel(date, short = false) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = DAY_NAMES[new Date(year, month - 1, day).getDay()];
  return short ? `${month}/${day}（${weekday}）` : `${year} 年 ${month} 月 ${day} 日（週${weekday}）`;
}

function renderCreate() {
  root.innerHTML = `<main class="quick-shell">${brand()}
    <section class="quick-head"><span class="eyebrow">QUICK SCHEDULER</span><h1>一眼找出能跑團的時間。</h1><p>建立者可以只是負責統計的人，不必是實際 GM。選好候選日期與早、中、晚的範圍，再把連結交給玩家即可。</p></section>
    <section class="quick-card my-schedules"><div class="my-schedules-head"><h2>我的快速約團表</h2><p>這台裝置建立的約團表會保留在這裡，不需要 GM 權限。</p></div><div id="my-schedules-list" class="my-schedules-list"><span class="muted">正在讀取⋯</span></div></section>
    <form id="create-quick" class="quick-card quick-create-form">
      <section><h2>團務與聯絡資訊</h2><p>建立者只需要設定團務資訊與時段範圍；每位玩家打開連結後，會自行從月曆選擇可跑日期。</p>
        <label>團務名稱<input name="title" maxlength="80" required placeholder="例如：十月團務時間調查"></label>
        <div class="form-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" required placeholder="你的名稱"></label><label>實際 GM<input name="gmName" maxlength="40" placeholder="尚未確定可留白"></label></div>
        <label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" placeholder="Discord、LINE 或其他聯絡方式"></label>
        <label>給玩家的說明<textarea name="note" maxlength="800" placeholder="預計遊玩的系統、時數或其他提醒"></textarea></label>
        <div class="form-grid"><label>最低成團人數<input name="minPlayers" type="number" min="1" max="20" value="4" required></label><label>最多參加人數（選填）<input name="maxPlayers" type="number" min="1" max="20" value="6" placeholder="不設上限"></label></div><small class="muted">同一天、同一時段達到最低人數即可成團；超過參加上限仍保留時段，由團務管理者協調名單。</small>
        <h3>時段範圍</h3><div class="period-settings"><label class="period-setting"><span>早上</span><input name="morning" value="09:00～12:00" required></label><label class="period-setting"><span>下午</span><input name="afternoon" value="13:00～18:00" required></label><label class="period-setting"><span>晚上</span><input name="evening" value="20:30～24:00" required></label></div>
        <p class="quick-note">玩家只會看到「早上／下午／晚上／X」四個按鈕；滑鼠移到時段上即可查看你設定的範圍。</p>
        <button class="button full" type="submit">建立快速約團表</button>
      </section>
    </form>
  </main>`;
  document.querySelector("#create-quick").addEventListener("submit", createSchedule);
  loadMySchedules();
}

async function loadMySchedules() {
  const container = document.querySelector("#my-schedules-list");
  if (!container || !user) return;
  try {
    const result = await getDocs(query(collection(db, "quickSchedules"), where("ownerUid", "==", user.uid)));
    const items = result.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    container.innerHTML = items.length
      ? items.map(item => `<article class="my-schedule-row"><a href="#quick=${item.id}"><span><b>${escapeHtml(item.title)}</b><small>${item.dates?.length ? `${escapeHtml(dateLabel(item.dates[0], true))}${item.dates.length > 1 ? ` 起・${item.dates.length} 個候選日` : ""}` : "日期未定"}</small></span><span class="open-schedule">開啟 →</span></a><button class="delete-schedule" type="button" data-id="${item.id}" data-title="${escapeHtml(item.title)}" aria-label="刪除 ${escapeHtml(item.title)}">刪除</button></article>`).join("")
      : '<div class="empty small">還沒有建立過快速約團表。</div>';
    container.querySelectorAll(".delete-schedule").forEach(button => {
      button.onclick = () => deleteQuickSchedule(button.dataset.id, button.dataset.title, button);
    });
  } catch (error) {
    console.error(error);
    container.innerHTML = '<div class="empty small">目前無法讀取清單，請確認新版 Firestore Rules 已發布。</div>';
  }
}

async function deleteQuickSchedule(id, title, button) {
  if (!window.confirm(`確定要刪除「${title}」嗎？玩家已填寫的時間也會一起刪除，且無法復原。`)) return;
  button.disabled = true;
  try {
    const [responseSnap, tokenSnap, managerSnap] = await Promise.all([
      getDocs(collection(db, "quickSchedules", id, "responses")),
      getDocs(collection(db, "quickSchedules", id, "managementTokens")),
      getDocs(collection(db, "quickSchedules", id, "managers"))
    ]);
    await Promise.all(responseSnap.docs.map(item => deleteDoc(item.ref)));
    await Promise.all(tokenSnap.docs.map(item => deleteDoc(item.ref)));
    await Promise.all(managerSnap.docs.filter(item => item.id !== user.uid).map(item => deleteDoc(item.ref)));
    await deleteDoc(doc(db, "quickSchedules", id));
    const ownManager = managerSnap.docs.find(item => item.id === user.uid);
    if (ownManager) await deleteDoc(ownManager.ref);
    toast("快速約團表已刪除");
    if (schedule?.id === id) location.hash = "";
    else loadMySchedules();
  } catch (error) {
    console.error(error);
    toast("刪除失敗，請稍後再試。");
    button.disabled = false;
  }
}

async function createSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const minPlayers = Number(form.minPlayers.value);
  const maxPlayers = Number(form.maxPlayers.value || 0);
  if (maxPlayers && maxPlayers < minPlayers) {
    toast("最多參加人數不能少於最低成團人數。");
    button.disabled = false;
    return;
  }
  let ref = null;
  try {
    const token = randomManagementToken();
    ref = await addDoc(collection(db, "quickSchedules"), {
      ownerUid: user.uid,
      title: form.elements.title.value.trim(),
      coordinatorName: form.coordinatorName.value.trim(),
      gmName: form.gmName.value.trim(),
      contact: form.contact.value.trim(),
      note: form.note.value.trim(),
      minPlayers,
      maxPlayers: maxPlayers || null,
      dates: [],
      periods: {
        "早上": form.morning.value.trim(),
        "下午": form.afternoon.value.trim(),
        "晚上": form.evening.value.trim()
      },
      createdAt: serverTimestamp()
    });
    let playerShortUrl = "";
    let managerShortUrl = "";
    try {
      [playerShortUrl, managerShortUrl] = await Promise.all([
        createShortUrl(quickUrl(ref.id), "player", form.elements.title.value.trim()),
        createShortUrl(manageUrl(ref.id, token), "manager", form.elements.title.value.trim())
      ]);
    } catch (shortenerError) {
      console.error(shortenerError);
    }
    await setDoc(doc(db, "quickSchedules", ref.id, "managementTokens", token), {
      createdAt: serverTimestamp(),
      ...(managerShortUrl ? {
        shortUrl: managerShortUrl,
        shortTitle: form.elements.title.value.trim(),
        previewVersion: SHORT_LINK_PREVIEW_VERSION
      } : {})
    });
    if (playerShortUrl) await updateDoc(ref, {
      shortPlayerUrl: playerShortUrl,
      shortPlayerTitle: form.elements.title.value.trim(),
      shortPlayerPreviewVersion: SHORT_LINK_PREVIEW_VERSION
    });
    location.hash = `manage=${ref.id}.${token}`;
  } catch (error) {
    console.error(error);
    if (ref) await deleteDoc(ref).catch(() => {});
    toast("建立失敗，請確認 Firestore 規則已更新。");
    button.disabled = false;
  }
}

async function openSchedule(id, routeManagementToken = "") {
  unsubscribeResponses?.();
  root.innerHTML = '<main class="loading-screen"><div class="spinner"></div><p>正在讀取快速約團表⋯</p></main>';
  try {
    const snap = await getDoc(doc(db, "quickSchedules", id));
    if (!snap.exists()) throw new Error("找不到這張快速約團表。");
    schedule = { id: snap.id, ...snap.data() };
    await loadManagementAccess(routeManagementToken);
    await ensureShortLinks();
    const mine = await getDoc(doc(db, "quickSchedules", id, "responses", user.uid));
    const mineData = mine.exists() ? mine.data() : null;
    const savedChoices = mineData?.choices || {};
    const initialDates = mineData ? Object.keys(savedChoices) : (schedule.dates || []);
    choices = new Map(initialDates.map(date => [date, new Set(savedChoices[date] || [])]));
    batchGroups = normalizeBatchGroups(savedChoices, mineData?.batchGroups || {});
    batchDates = new Set();
    batchApplied = false;
    const firstDate = [...choices.keys()].sort()[0];
    responseMonthCursor = firstDate
      ? new Date(Number(firstDate.slice(0, 4)), Number(firstDate.slice(5, 7)) - 1, 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let rendered = false;
    unsubscribeResponses = onSnapshot(collection(db, "quickSchedules", id, "responses"), result => {
      responses = result.docs.map(item => ({ id: item.id, ...item.data() }));
      if (!rendered) {
        const latestMine = responses.find(item => item.id === user.uid) || mineData;
        if (latestMine) {
          choices = new Map(Object.entries(latestMine.choices || {}).map(([date, values]) => [date, new Set(values)]));
          batchGroups = normalizeBatchGroups(latestMine.choices || {}, latestMine.batchGroups || {});
        }
        renderSchedule(latestMine);
        rendered = true;
      } else {
        refreshOverview();
      }
    }, error => {
      console.error(error);
      toast("無法同步玩家資料。");
    });
  } catch (error) {
    root.innerHTML = `<main class="error-screen"><span class="brandmark brandmark-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><h1>無法開啟約團表</h1><p>${escapeHtml(error.message)}</p><a class="button" href="./quick.html">建立新的約團表</a></main>`;
  }
}

async function claimManagementAccess(id, token) {
  const managerRef = doc(db, "quickSchedules", id, "managers", user.uid);
  const existing = await getDoc(managerRef);
  if (existing.exists()) await deleteDoc(managerRef);
  await setDoc(managerRef, { token, claimedAt: serverTimestamp() });
}

async function loadManagementAccess(routeManagementToken = "") {
  canManageSchedule = false;
  managementToken = "";
  managementShortUrl = "";
  managementShortTitle = "";
  managementPreviewVersion = 0;
  if (!routeManagementToken) return;

  const tokenSnap = await getDoc(doc(
    db, "quickSchedules", schedule.id, "managementTokens", routeManagementToken
  ));
  if (!tokenSnap.exists()) throw new Error("管理連結無效");

  const tokenData = tokenSnap.data();
  managementToken = routeManagementToken;
  managementShortUrl = tokenData.shortUrl || "";
  managementShortTitle = tokenData.shortTitle || "";
  managementPreviewVersion = Number(tokenData.previewVersion || 0);
  canManageSchedule = true;
}

async function ensureShortLinks() {
  if (!canManageSchedule || !managementToken) return;
  try {
    const playerLinkNeedsRefresh = !schedule.shortPlayerUrl
      || schedule.shortPlayerTitle !== schedule.title
      || schedule.shortPlayerPreviewVersion !== SHORT_LINK_PREVIEW_VERSION;
    const playerPromise = playerLinkNeedsRefresh
      ? createShortUrl(quickUrl(schedule.id), "player", schedule.title)
      : Promise.resolve(schedule.shortPlayerUrl);
    const managerLinkNeedsRefresh = !managementShortUrl
      || managementShortTitle !== schedule.title
      || managementPreviewVersion !== SHORT_LINK_PREVIEW_VERSION;
    const managerPromise = managerLinkNeedsRefresh
      ? createShortUrl(manageUrl(schedule.id, managementToken), "manager", schedule.title)
      : Promise.resolve(managementShortUrl);
    const [playerShortUrl, managerShortUrl] = await Promise.all([playerPromise, managerPromise]);
    if (playerLinkNeedsRefresh) {
      await updateDoc(doc(db, "quickSchedules", schedule.id), {
        shortPlayerUrl: playerShortUrl,
        shortPlayerTitle: schedule.title,
        shortPlayerPreviewVersion: SHORT_LINK_PREVIEW_VERSION
      });
      schedule.shortPlayerUrl = playerShortUrl;
      schedule.shortPlayerTitle = schedule.title;
      schedule.shortPlayerPreviewVersion = SHORT_LINK_PREVIEW_VERSION;
    }
    if (managerLinkNeedsRefresh) {
      await setDoc(doc(db, "quickSchedules", schedule.id, "managementTokens", managementToken), {
        shortUrl: managerShortUrl,
        shortTitle: schedule.title,
        previewVersion: SHORT_LINK_PREVIEW_VERSION
      }, { merge: true });
      managementShortUrl = managerShortUrl;
      managementShortTitle = schedule.title;
      managementPreviewVersion = SHORT_LINK_PREVIEW_VERSION;
    }
  } catch (error) {
    console.error("短網址建立失敗，暫時使用原始網址。", error);
  }
}

function responseUpdatedMillis(response) {
  if (typeof response.updatedAt?.toMillis === "function") return response.updatedAt.toMillis();
  return Number(response.updatedAt?.seconds || 0) * 1000;
}

function normalizedPlayerName(name = "") {
  return String(name).trim().normalize("NFKC").toLocaleLowerCase("zh-Hant-TW");
}

function mergedResponseChoices(group) {
  const merged = {};
  for (const response of group) {
    for (const [date, values] of Object.entries(response.choices || {})) {
      const selected = new Set(merged[date] || []);
      const availablePeriods = PERIOD_KEYS.filter(period => values.includes(period));
      if (availablePeriods.length) {
        selected.delete("X");
        availablePeriods.forEach(period => selected.add(period));
      } else if (values.includes("X") && !PERIOD_KEYS.some(period => selected.has(period))) {
        selected.add("X");
      }
      if (selected.size) {
        merged[date] = [
          ...PERIOD_KEYS.filter(period => selected.has(period)),
          ...(selected.has("X") ? ["X"] : [])
        ];
      }
    }
  }
  return merged;
}

function uniqueSubmittedResponses(items = []) {
  const responseGroups = new Map();
  for (const response of items.filter(item => item.submitted)) {
    const nameKey = normalizedPlayerName(response.playerName) || `__response__${response.id}`;
    const group = responseGroups.get(nameKey) || [];
    group.push(response);
    responseGroups.set(nameKey, group);
  }

  return [...responseGroups.values()].map(group => {
    const latest = [...group].sort((a, b) =>
      responseUpdatedMillis(b) - responseUpdatedMillis(a)
    )[0];
    const choices = mergedResponseChoices(group);
    const notes = [...new Set(group.map(response => response.note?.trim()).filter(Boolean))];
    return {
      ...latest,
      choices,
      batchGroups: Object.fromEntries(normalizeBatchGroups(choices)),
      note: notes.join("／"),
      responseIds: group.map(response => response.id),
      mergedCount: group.length
    };
  });
}

function playerRangeLabel(scheduleData = schedule) {
  const minimum = Number(scheduleData?.minPlayers || 1);
  const maximum = Number(scheduleData?.maxPlayers || 0);
  return maximum >= minimum
    ? `至少 ${minimum} 人同時有空即可成團，最多 ${maximum} 人參加`
    : `至少 ${minimum} 人同時有空即可成團`;
}

function renderSchedule(mineData) {
  const periodRanges = schedule.periods || {};
  const submitted = uniqueSubmittedResponses(responses);
  const best = bestSlots(submitted);
  const playerLink = schedule.shortPlayerUrl || quickUrl(schedule.id);
  const privateLink = managementToken ? (managementShortUrl || manageUrl(schedule.id, managementToken)) : "";
  root.innerHTML = `<main class="quick-shell">${brand()}
    <a class="quick-back" href="./quick.html" aria-label="回到建立快速約團頁面">← 上一頁：建立快速約團</a>
    <section class="schedule-banner"><div><span class="eyebrow">QUICK SCHEDULER</span><h1>${escapeHtml(schedule.title)}</h1><p>建立者／統計者：${escapeHtml(schedule.coordinatorName)}${schedule.gmName ? `・實際 GM：${escapeHtml(schedule.gmName)}` : ""}</p></div>${schedule.contact ? `<div class="contact-card"><span>給玩家的聯絡方式</span><b>${escapeHtml(schedule.contact)}</b></div>` : ""}</section>
    ${schedule.note ? `<p class="quick-note">${escapeHtml(schedule.note)}</p>` : ""}
    <div class="schedule-grid"><form id="response-form" class="quick-card"><h2>填寫我的時間</h2><p>先從月曆點選你要填寫的日期，再選早上、下午、晚上或 X。儲存後仍可隨時回來修改日期。</p>${periodLegendMarkup(periodRanges)}<label>玩家名稱<input name="playerName" maxlength="30" value="${escapeHtml(mineData?.playerName || localStorage.getItem("gather-party-player") || "")}" required></label><div class="date-picker-head"><h3 id="response-month-title">${responseMonthCursor.getFullYear()} 年 ${responseMonthCursor.getMonth() + 1} 月</h3><div class="date-picker-nav"><button class="mini-button" id="response-prev" type="button">‹</button><button class="mini-button" id="response-today" type="button">今</button><button class="mini-button" id="response-next" type="button">›</button></div></div><div class="date-preset-bar" aria-label="快速選擇本月日期"><span>快速選日期</span><button class="date-preset-button" type="button" data-date-preset="weekdays">週一～週五</button><button class="date-preset-button" type="button" data-date-preset="weekends">週末</button><button class="date-preset-button" type="button" data-date-preset="all">全月</button><button class="date-preset-button clear" type="button" data-date-preset="clear">清除本月</button></div><div id="response-calendar">${responseCalendarMarkup()}</div><section class="batch-choice-panel"><div><h3>批次設定時段</h3><p id="batch-choice-count">目前批次 0 天</p><small>套用時段後按「儲存時間」，日期會收進編號批次；接著即可繼續選下一批。</small></div><div class="batch-choice-actions">${PERIOD_KEYS.map(period => `<button class="choice-button batch-choice-button" type="button" data-batch-choice="${period}">${period}</button>`).join("")}<button class="choice-button no batch-choice-button" type="button" data-batch-choice="X">X</button><button class="choice-button clear batch-choice-button" type="button" data-batch-choice="clear">清除時段</button></div></section><details class="choice-details" id="choice-details" ${choices.size <= 3 ? "open" : ""}><summary>逐日調整 <span id="choice-summary-count">${choices.size} 天</span></summary><div class="choice-list" id="response-choice-list">${responseChoiceListMarkup(periodRanges)}</div></details><label>備註<textarea name="note" maxlength="500" placeholder="例如：晚上九點後才有空、這天可能需要再確認">${escapeHtml(mineData?.note || "")}</textarea></label><div class="quick-form-actions"><span class="muted">至少選擇一個日期，且每個日期都要選時段或 X</span><button class="button" type="submit">儲存時間</button></div></form>
      <aside class="quick-card"><h2>可成團時段</h2><p id="response-count">${submitted.length} 人已填寫・填表人數不限・${playerRangeLabel()}</p><div class="best-slots" id="best-slots">${bestMarkup(best, submitted.length)}</div><label>玩家填表連結<div class="share-box"><input id="player-link" readonly value="${escapeHtml(playerLink)}" aria-label="玩家填表短網址"><button class="button secondary" id="copy-quick" type="button">複製</button></div></label>${canManageSchedule ? `<div class="management-box"><h3>私人管理連結</h3><p>換裝置時用這條隨機短網址取回管理權限，請勿傳給玩家。</p>${privateLink ? `<div class="share-box"><input id="manager-link" readonly value="${escapeHtml(privateLink)}" aria-label="私人管理短網址"><button class="button secondary" id="copy-manager" type="button">複製</button></div>` : '<p class="muted">私人管理連結建立中。</p>'}<div class="management-actions"><button class="button secondary full" id="edit-current-schedule" type="button">編輯約團設定</button><button class="button reject full" id="delete-current-schedule" type="button">刪除這張約團表</button></div></div>` : ""}</aside>
    </div>
    <section class="quick-card overview"><h2>玩家時間一覽</h2><p>每位玩家的選擇與備註會集中顯示在這裡。</p>${periodLegendMarkup(periodRanges)}<div id="overview-content">${overviewMarkup(submitted)}</div></section>
  </main>`;
  bindChoiceControls(periodRanges);
  bindResponseCalendar(periodRanges);
  bindOverviewActions();
  const responseForm = document.querySelector("#response-form");
  responseForm.onsubmit = saveResponse;
  responseForm.addEventListener("input", markResponseDirty);
  document.querySelector("#copy-quick").onclick = async () => {
    try { await navigator.clipboard.writeText(playerLink); toast("已複製玩家填表連結"); } catch { toast("請手動複製網址。"); }
  };
  document.querySelector("#copy-manager")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(privateLink); toast("已複製私人管理連結"); } catch { toast("請手動複製網址。"); }
  });
  document.querySelector("#edit-current-schedule")?.addEventListener("click", openEditScheduleDialog);
  document.querySelector("#delete-current-schedule")?.addEventListener("click", event => {
    deleteQuickSchedule(schedule.id, schedule.title, event.currentTarget);
  });
}

function openEditScheduleDialog() {
  if (!canManageSchedule) return;
  const dialog = document.createElement("dialog");
  dialog.id = "edit-schedule-dialog";
  const periods = schedule.periods || {};
  dialog.innerHTML = `<form method="dialog" class="dialog-card" id="edit-schedule-form"><div class="dialog-head"><div><span class="eyebrow">MANAGEMENT</span><h2>編輯約團設定</h2></div><button class="icon-button" type="button" data-close aria-label="關閉">×</button></div><label>團務名稱<input name="title" maxlength="80" value="${escapeHtml(schedule.title)}" required></label><div class="form-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" value="${escapeHtml(schedule.coordinatorName)}" required></label><label>實際 GM<input name="gmName" maxlength="40" value="${escapeHtml(schedule.gmName || "")}" placeholder="尚未確定可留白"></label></div><label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" value="${escapeHtml(schedule.contact || "")}"></label><label>給玩家的說明<textarea name="note" maxlength="800">${escapeHtml(schedule.note || "")}</textarea></label><div class="form-grid"><label>最低成團人數<input name="minPlayers" type="number" min="1" max="20" value="${Number(schedule.minPlayers || 1)}" required></label><label>最多參加人數（選填）<input name="maxPlayers" type="number" min="1" max="20" value="${schedule.maxPlayers ? Number(schedule.maxPlayers) : ""}" placeholder="不設上限"></label></div><small class="muted">同一天、同一時段達到最低人數即可成團；超過參加上限仍保留時段，由團務管理者協調名單。</small><h3>時段範圍</h3><div class="period-settings"><label class="period-setting"><span>早上</span><input name="morning" value="${escapeHtml(periods["早上"] || "09:00～12:00")}" required></label><label class="period-setting"><span>下午</span><input name="afternoon" value="${escapeHtml(periods["下午"] || "13:00～18:00")}" required></label><label class="period-setting"><span>晚上</span><input name="evening" value="${escapeHtml(periods["晚上"] || "20:30～24:00")}" required></label></div><div class="dialog-actions"><button class="button secondary" type="button" data-close>取消</button><button class="button" type="submit">儲存設定</button></div></form>`;
  root.appendChild(dialog);
  dialog.showModal();
  dialog.querySelectorAll("[data-close]").forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("#edit-schedule-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    const minPlayers = Number(form.minPlayers.value);
    const maxPlayers = Number(form.maxPlayers.value || 0);
    if (maxPlayers && maxPlayers < minPlayers) {
      toast("最多參加人數不能少於最低成團人數。");
      button.disabled = false;
      return;
    }
    const periods = {
      "早上": form.morning.value.trim(),
      "下午": form.afternoon.value.trim(),
      "晚上": form.evening.value.trim()
    };
    const changes = {
      title: form.elements.title.value.trim(),
      coordinatorName: form.coordinatorName.value.trim(),
      gmName: form.gmName.value.trim(),
      contact: form.contact.value.trim(),
      note: form.note.value.trim(),
      minPlayers,
      maxPlayers: maxPlayers || null,
      periods,
      updatedAt: serverTimestamp()
    };
    try {
      await updateDoc(doc(db, "quickSchedules", schedule.id), changes);
      schedule = { ...schedule, ...changes };
      if (schedule.shortPlayerTitle !== changes.title || managementShortTitle !== changes.title) {
        const [refreshedPlayerUrl, refreshedManagerUrl] = await Promise.all([
          createShortUrl(quickUrl(schedule.id), "player", changes.title),
          createShortUrl(manageUrl(schedule.id, managementToken), "manager", changes.title)
        ]);
        await Promise.all([
          updateDoc(doc(db, "quickSchedules", schedule.id), {
            shortPlayerUrl: refreshedPlayerUrl,
            shortPlayerTitle: changes.title,
            shortPlayerPreviewVersion: SHORT_LINK_PREVIEW_VERSION
          }),
          setDoc(doc(db, "quickSchedules", schedule.id, "managementTokens", managementToken), {
            shortUrl: refreshedManagerUrl,
            shortTitle: changes.title,
            previewVersion: SHORT_LINK_PREVIEW_VERSION
          }, { merge: true })
        ]);
        schedule.shortPlayerUrl = refreshedPlayerUrl;
        schedule.shortPlayerTitle = changes.title;
        schedule.shortPlayerPreviewVersion = SHORT_LINK_PREVIEW_VERSION;
        managementShortUrl = refreshedManagerUrl;
        managementShortTitle = changes.title;
        managementPreviewVersion = SHORT_LINK_PREVIEW_VERSION;
      }
      dialog.close();
      renderSchedule(responses.find(item => item.id === user.uid) || null);
      toast("約團設定已更新");
    } catch (error) {
      console.error(error);
      toast("設定儲存失敗，請稍後再試。");
      button.disabled = false;
    }
  };
}

function periodLegendMarkup(ranges) {
  const defaults = { "早上": "09:00～12:00", "下午": "13:00～18:00", "晚上": "20:30～24:00" };
  return `<div class="period-legend" aria-label="本團時段範圍">${PERIOD_KEYS.map(period => `<span><b>${period}</b>${escapeHtml(ranges[period] || defaults[period])}</span>`).join("")}</div>`;
}

function bestSlotPlayersMarkup(players = []) {
  const names = players.map(player => player.playerName || "玩家");
  return `<span class="best-slot-players" aria-label="可以的玩家：${escapeHtml(names.join("、"))}">${names.map(name => `<span class="best-slot-player" title="${escapeHtml(name)}">${escapeHtml(Array.from(name.trim())[0] || "玩")}</span>`).join("")}</span>`;
}

function bestMarkup(items, total) {
  return items.length
    ? items.slice(0, 10).map(item => `<div class="best-slot"><span class="best-slot-time">${escapeHtml(dateLabel(item.date, true))}・${escapeHtml(item.period)}</span><div class="best-slot-availability">${bestSlotPlayersMarkup(item.players)}<small>${item.count}／${total} 人${Number(schedule.maxPlayers) > 0 && item.count > Number(schedule.maxPlayers) ? `・可成團，最多 ${Number(schedule.maxPlayers)} 人參加` : ""}</small></div></div>`).join("")
    : '<div class="empty small">目前沒有達到最低成團人數的時段。</div>';
}

function refreshOverview() {
  const submitted = uniqueSubmittedResponses(responses);
  const count = document.querySelector("#response-count");
  const best = document.querySelector("#best-slots");
  const overview = document.querySelector("#overview-content");
  if (count) count.textContent = `${submitted.length} 人已填寫・填表人數不限・${playerRangeLabel()}`;
  if (best) best.innerHTML = bestMarkup(bestSlots(submitted), submitted.length);
  if (overview) {
    overview.innerHTML = overviewMarkup(submitted);
    bindOverviewActions();
  }
  const calendar = document.querySelector("#response-calendar");
  if (calendar) {
    calendar.innerHTML = responseCalendarMarkup();
    bindResponseDayButtons(schedule.periods || {});
  }
}

function calendarPlayersMarkup(date) {
  const availablePlayers = uniqueSubmittedResponses(responses).filter(player =>
    PERIOD_KEYS.some(period => player.choices?.[date]?.includes(period))
  );
  if (!availablePlayers.length) return "";
  const names = availablePlayers.map(player => player.playerName || "玩家");
  const visible = names.slice(0, 3);
  return `<span class="calendar-players" aria-label="已有空的玩家：${escapeHtml(names.join("、"))}">${visible.map(name => `<span class="calendar-player" title="${escapeHtml(name)}">${escapeHtml(Array.from(name.trim())[0] || "玩")}</span>`).join("")}${names.length > 3 ? `<span class="calendar-player more">+${names.length - 3}</span>` : ""}</span>`;
}

function responseCalendarMarkup() {
  const year = responseMonthCursor.getFullYear();
  const month = responseMonthCursor.getMonth();
  const first = (new Date(year, month, 1).getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const today = taiwanTodayKey();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<button class="quick-day outside" tabindex="-1"></button>');
  for (let day = 1; day <= total; day++) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const holiday = holidayFor(date);
    const chosen = choices.has(date);
    const inBatch = batchDates.has(date);
    const batchNumber = batchGroups.get(date);
    const dayNote = holiday || (date === today ? "今天" : "");
    const title = inBatch
      ? `目前選取・${dayNote || date}`
      : batchNumber ? `第 ${batchNumber} 批・${dayNote || date}` : dayNote || date;
    cells.push(`<button class="quick-day ${inBatch ? "selected batch-target" : ""} ${chosen && !inBatch ? "committed" : ""} ${holiday ? "holiday" : ""} ${date === today ? "today" : ""}" type="button" data-response-date="${date}" title="${escapeHtml(title)}" aria-pressed="${chosen}"><span>${day}</span>${batchNumber && !inBatch ? `<span class="calendar-batch-number" aria-label="第 ${batchNumber} 批">${batchNumber}</span>` : ""}${calendarPlayersMarkup(date)}${dayNote ? `<small>${escapeHtml(dayNote)}</small>` : ""}</button>`);
  }
  return `<div class="quick-calendar"><div class="quick-weekday">一</div><div class="quick-weekday">二</div><div class="quick-weekday">三</div><div class="quick-weekday">四</div><div class="quick-weekday">五</div><div class="quick-weekday">六</div><div class="quick-weekday">日</div>${cells.join("")}</div>`;
}

function responseChoiceListMarkup(ranges) {
  const dates = [...choices.keys()].sort();
  return dates.length
    ? dates.map(date => choiceRow(date, ranges)).join("")
    : '<div class="empty small">請先在上方月曆點選日期。</div>';
}

function updateChoiceControlState() {
  const totalCount = choices.size;
  const batchCount = batchDates.size;
  const batchCountNode = document.querySelector("#batch-choice-count");
  const summaryCount = document.querySelector("#choice-summary-count");
  if (batchCountNode) batchCountNode.textContent = batchCount
    ? `目前批次 ${batchCount} 天${batchApplied ? "・完成後請儲存時間" : ""}`
    : (totalCount ? "請從月曆點選下一批日期" : "請先從月曆選擇日期");
  if (summaryCount) summaryCount.textContent = `${totalCount} 天`;
  document.querySelectorAll("[data-batch-choice]").forEach(button => {
    button.disabled = batchCount === 0;
  });
}

function refreshChoiceControls(ranges) {
  const list = document.querySelector("#response-choice-list");
  if (list) list.innerHTML = responseChoiceListMarkup(ranges);
  bindChoiceButtons();
  updateChoiceControlState();
}

function applyBatchChoice(value, ranges) {
  if (!batchDates.size) return toast("請先從月曆選擇這一批日期。");
  const targetDates = [...batchDates];
  for (const date of targetDates) {
    const selected = choices.get(date);
    if (!selected) continue;
    if (value === "clear") {
      selected.clear();
    } else if (value === "X") {
      selected.clear();
      selected.add("X");
    } else {
      selected.delete("X");
      selected.add(value);
    }
  }
  batchApplied = true;
  refreshChoiceControls(ranges);
  markResponseDirty();
  toast(value === "clear" ? `已清除目前批次 ${targetDates.length} 天的時段` : `已將「${value}」套用到目前批次 ${targetDates.length} 天`);
}

function bindChoiceControls(ranges) {
  bindChoiceButtons();
  document.querySelectorAll("[data-batch-choice]").forEach(button => {
    button.onclick = () => applyBatchChoice(button.dataset.batchChoice, ranges);
  });
  updateChoiceControlState();
}

function applyMonthDatePreset(preset, ranges, refreshCalendar) {
  const year = responseMonthCursor.getFullYear();
  const month = responseMonthCursor.getMonth();
  const total = new Date(year, month + 1, 0).getDate();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;

  if (preset === "clear") {
    for (const date of [...choices.keys()]) {
      if (date.startsWith(monthPrefix)) {
        choices.delete(date);
        batchGroups.delete(date);
      }
    }
    for (const date of [...batchDates]) {
      if (date.startsWith(monthPrefix)) batchDates.delete(date);
    }
    batchApplied = false;
    refreshCalendar();
    refreshChoiceControls(ranges);
    markResponseDirty();
    toast("已清除本月選取日期");
    return;
  }

  if (batchApplied) return toast("請先按「儲存時間」完成目前批次。");

  const dates = [];
  for (let day = 1; day <= total; day += 1) {
    const weekday = new Date(year, month, day).getDay();
    const matches = preset === "all"
      || (preset === "weekdays" && weekday >= 1 && weekday <= 5)
      || (preset === "weekends" && (weekday === 0 || weekday === 6));
    if (matches) dates.push(`${monthPrefix}${String(day).padStart(2, "0")}`);
  }

  batchDates.clear();
  batchApplied = false;
  let skipped = 0;
  for (const date of dates) {
    if (!choices.has(date)) {
      if (choices.size >= 31) {
        skipped += 1;
        continue;
      }
      choices.set(date, new Set());
    }
    batchDates.add(date);
  }
  refreshCalendar();
  refreshChoiceControls(ranges);
  markResponseDirty();

  if (skipped) {
    toast("最多可選 31 天，已將可容納的日期設為目前批次。");
  } else {
    const label = preset === "weekdays" ? "週一～週五" : preset === "weekends" ? "週末" : "全月";
    toast(`已將本月${label}設為目前批次`);
  }
}

function bindResponseCalendar(ranges) {
  const refreshCalendar = () => {
    document.querySelector("#response-month-title").textContent = `${responseMonthCursor.getFullYear()} 年 ${responseMonthCursor.getMonth() + 1} 月`;
    document.querySelector("#response-calendar").innerHTML = responseCalendarMarkup();
    bindResponseDayButtons(ranges);
  };
  document.querySelectorAll("[data-date-preset]").forEach(button => {
    button.onclick = () => applyMonthDatePreset(button.dataset.datePreset, ranges, refreshCalendar);
  });
  document.querySelector("#response-prev").onclick = () => {
    responseMonthCursor = new Date(responseMonthCursor.getFullYear(), responseMonthCursor.getMonth() - 1, 1);
    refreshCalendar();
  };
  document.querySelector("#response-next").onclick = () => {
    responseMonthCursor = new Date(responseMonthCursor.getFullYear(), responseMonthCursor.getMonth() + 1, 1);
    refreshCalendar();
  };
  document.querySelector("#response-today").onclick = () => {
    responseMonthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    refreshCalendar();
  };
  bindResponseDayButtons(ranges);
}

function bindResponseDayButtons(ranges) {
  document.querySelectorAll(".quick-day[data-response-date]").forEach(button => button.onclick = () => {
    const date = button.dataset.responseDate;
    if (choices.has(date)) {
      choices.delete(date);
      batchGroups.delete(date);
      batchDates.delete(date);
    } else {
      if (choices.size >= 31) return toast("一次最多可填寫 31 個日期。");
      if (batchApplied) return toast("請先按「儲存時間」完成目前批次。");
      choices.set(date, new Set());
      batchDates.add(date);
    }
    button.classList.toggle("selected", batchDates.has(date));
    button.classList.toggle("batch-target", batchDates.has(date));
    button.classList.toggle("committed", choices.has(date) && !batchDates.has(date));
    button.setAttribute("aria-pressed", String(choices.has(date)));
    refreshChoiceControls(ranges);
    markResponseDirty();
  });
}

function choiceRow(date, ranges) {
  const selected = choices.get(date) || new Set();
  return `<div class="choice-row"><div class="choice-date"><b>${escapeHtml(dateLabel(date))}</b><span>${escapeHtml(holidayFor(date) || "一般日期")}</span></div>${PERIOD_KEYS.map(period => `<button class="choice-button ${selected.has(period) ? "selected" : ""}" type="button" data-date="${date}" data-choice="${period}" title="${escapeHtml(ranges[period] || "")}" aria-pressed="${selected.has(period)}">${period}</button>`).join("")}<button class="choice-button no ${selected.has("X") ? "selected" : ""}" type="button" data-date="${date}" data-choice="X" aria-pressed="${selected.has("X")}">X</button></div>`;
}

function bindChoiceButtons() {
  document.querySelectorAll(".choice-button[data-date]").forEach(button => button.onclick = () => {
    const set = choices.get(button.dataset.date) || new Set();
    const value = button.dataset.choice;
    if (value === "X") {
      set.clear();
      if (!button.classList.contains("selected")) set.add("X");
    } else {
      set.delete("X");
      set.has(value) ? set.delete(value) : set.add(value);
    }
    choices.set(button.dataset.date, set);
    markResponseDirty();
    document.querySelectorAll(`.choice-button[data-date="${button.dataset.date}"]`).forEach(item => {
      const active = set.has(item.dataset.choice);
      item.classList.toggle("selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
}

function markResponseDirty() {
  const button = document.querySelector('#response-form button[type="submit"]');
  if (button) button.textContent = "儲存時間";
}

async function saveResponse(event) {
  event.preventDefault();
  if (!choices.size) return toast("請先從月曆選擇至少一個日期。");
  if ([...choices.values()].some(values => !values.size)) return toast("每個已選日期都要選擇早上、下午、晚上或 X。");
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const choiceObject = Object.fromEntries([...choices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => [date, [...values]]));
  const nextBatchGroups = new Map(batchGroups);
  let savedBatchNumber = 0;
  if (batchDates.size) {
    savedBatchNumber = Math.max(0, ...nextBatchGroups.values()) + 1;
    for (const date of batchDates) {
      if (choices.has(date)) nextBatchGroups.set(date, savedBatchNumber);
    }
  }
  const batchGroupObject = Object.fromEntries(
    [...nextBatchGroups.entries()].filter(([date]) => choices.has(date))
  );
  try {
    await setDoc(doc(db, "quickSchedules", schedule.id, "responses", user.uid), {
      playerName: form.playerName.value.trim(),
      note: form.note.value.trim(),
      choices: choiceObject,
      batchGroups: batchGroupObject,
      submitted: true,
      updatedAt: serverTimestamp()
    });
    batchGroups = nextBatchGroups;
    batchDates.clear();
    batchApplied = false;
    localStorage.setItem("gather-party-player", form.playerName.value.trim());
    const calendar = document.querySelector("#response-calendar");
    if (calendar) {
      calendar.innerHTML = responseCalendarMarkup();
      bindResponseDayButtons(schedule.periods || {});
    }
    refreshChoiceControls(schedule.periods || {});
    button.disabled = false;
    button.textContent = "已儲存，可繼續新增時間";
    toast(savedBatchNumber ? `第 ${savedBatchNumber} 批時間已儲存` : "你的時間已儲存");
  } catch (error) {
    console.error(error);
    toast("儲存失敗，請稍後再試。");
    button.disabled = false;
  }
}

function bestSlots(players) {
  const dates = [...new Set(players.flatMap(player => Object.keys(player.choices || {})))].sort();
  const slots = dates.flatMap(date => PERIOD_KEYS.map(period => {
    const availablePlayers = players.filter(player => player.choices?.[date]?.includes(period));
    return {
      date,
      period,
      count: availablePlayers.length,
      players: availablePlayers
    };
  }));
  const minimum = Number(schedule.minPlayers || 1);
  const enough = slots.filter(item => item.count >= minimum);
  return enough.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || PERIOD_KEYS.indexOf(a.period) - PERIOD_KEYS.indexOf(b.period));
}

function areConsecutiveDates(previous, current) {
  const previousTime = Date.parse(`${previous}T00:00:00Z`);
  const currentTime = Date.parse(`${current}T00:00:00Z`);
  return currentTime - previousTime === 86400000;
}

function compactDateRangeLabel(start, end) {
  if (start === end) return dateLabel(start, true);
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  if (startYear === endYear) return `${startMonth}/${startDay}～${endMonth}/${endDay}`;
  return `${startYear}/${startMonth}/${startDay}～${endYear}/${endMonth}/${endDay}`;
}

function choiceLabel(values = []) {
  return values.includes("X")
    ? "X"
    : PERIOD_KEYS.filter(period => values.includes(period)).join("／") || "未選時段";
}

function normalizeBatchGroups(choiceObject = {}, savedGroups = {}) {
  const result = new Map();
  let highest = 0;
  for (const [date, value] of Object.entries(savedGroups)) {
    const number = Number(value);
    if (choiceObject[date] && Number.isInteger(number) && number > 0) {
      result.set(date, number);
      highest = Math.max(highest, number);
    }
  }

  let previousDate = "";
  let previousLabel = "";
  let previousGroup = 0;
  for (const date of Object.keys(choiceObject).sort()) {
    const label = choiceLabel(choiceObject[date]);
    let group = result.get(date);
    if (!group) {
      group = previousGroup && previousLabel === label && areConsecutiveDates(previousDate, date)
        ? previousGroup
        : ++highest;
      result.set(date, group);
    }
    previousDate = date;
    previousLabel = label;
    previousGroup = group;
  }
  return result;
}

function groupedPlayerChoices(choiceObject = {}, savedGroups = {}) {
  const groups = [];
  const normalizedGroups = normalizeBatchGroups(choiceObject, savedGroups);
  for (const date of Object.keys(choiceObject).sort()) {
    const values = choiceObject[date] || [];
    const label = choiceLabel(values);
    const batchNumber = normalizedGroups.get(date);
    const previous = groups.at(-1);
    if (previous
      && previous.batchNumber === batchNumber
      && previous.label === label
      && areConsecutiveDates(previous.end, date)) {
      previous.end = date;
    } else {
      groups.push({
        start: date,
        end: date,
        label,
        batchNumber,
        isUnavailable: values.includes("X")
      });
    }
  }
  return groups;
}

function overviewMarkup(players) {
  if (!players.length) return '<div class="empty">目前還沒有人填寫。</div>';
  return `<div class="player-availability-grid">${players.map(player => {
    const groupedChoices = groupedPlayerChoices(player.choices, player.batchGroups);
    const responseIds = player.responseIds || [player.id];
    const isMine = responseIds.includes(user?.uid);
    const canDelete = isMine || canManageSchedule;
    const deleteLabel = isMine ? "刪除我的填寫" : `刪除 ${player.playerName} 的登記`;
    const deleteButton = canDelete ? `<button class="delete-my-response" type="button" data-response-ids="${escapeHtml(responseIds.join(","))}" data-player-name="${escapeHtml(player.playerName)}" aria-label="${escapeHtml(deleteLabel)}" title="${escapeHtml(deleteLabel)}">×</button>` : "";
    const mergeNotice = player.mergedCount > 1
      ? `<p class="response-note">已將 ${player.mergedCount} 筆同名填寫合併整理。請確認下方日期與時段是否正確；若不正確，請由管理者刪除後再重新填寫。</p>`
      : "";
    return `<article class="player-availability"><header><h3>${escapeHtml(player.playerName)}</h3>${deleteButton}</header>${mergeNotice}${player.note ? `<p class="response-note">${escapeHtml(player.note)}</p>` : ""}<div>${groupedChoices.map(group => `<span class="player-date-choice"><b>${escapeHtml(compactDateRangeLabel(group.start, group.end))}</b><i class="choice-mark ${group.isUnavailable ? "no" : ""}">${escapeHtml(group.label)}</i></span>`).join("")}</div></article>`;
  }).join("")}</div>`;
}

function bindOverviewActions() {
  document.querySelectorAll(".delete-my-response").forEach(button => button.addEventListener("click", async event => {
    const target = event.currentTarget;
    const responseIds = (target.dataset.responseIds || "").split(",").filter(Boolean);
    const isMine = responseIds.includes(user?.uid);
    if (!user || !responseIds.length || (!isMine && !canManageSchedule)) return;
    const deletableResponseIds = canManageSchedule
      ? responseIds
      : responseIds.filter(responseId => responseId === user.uid);
    const playerName = target.dataset.playerName || "這位玩家";
    const message = isMine
      ? "確定要刪除自己的填寫資料嗎？日期、時段與備註都會被移除。"
      : `確定要刪除「${playerName}」的登記嗎？日期、時段與備註都會被移除。`;
    if (!window.confirm(message)) return;
    target.disabled = true;
    try {
      await Promise.all(deletableResponseIds.map(responseId =>
        deleteDoc(doc(db, "quickSchedules", schedule.id, "responses", responseId))
      ));
      responses = responses.filter(player => !deletableResponseIds.includes(player.id));
      if (isMine) {
        choices.clear();
        batchGroups.clear();
        batchDates.clear();
        batchApplied = false;
        renderSchedule(null);
      } else {
        refreshOverview();
      }
      toast(isMine ? "你的填寫資料已刪除" : `${playerName} 的登記已刪除`);
    } catch (error) {
      console.error(error);
      toast("刪除失敗，請稍後再試。");
      target.disabled = false;
    }
  }));
}

async function handleRoute() {
  const route = routeInfo();
  if (route.id) {
    canManageSchedule = false;
    managementToken = "";
    managementShortUrl = "";
    managementShortTitle = "";
    managementPreviewVersion = 0;
    if (route.token) {
      try {
        await claimManagementAccess(route.id, route.token);
      } catch (error) {
        console.error(error);
        root.innerHTML = '<main class="error-screen"><h1>管理連結無效</h1><p>請確認連結完整，或請建立者重新提供。</p><a class="button" href="./quick.html">回快速約團</a></main>';
        return;
      }
    }
    await openSchedule(route.id, route.token || "");
  }
  else {
    schedule = null;
    canManageSchedule = false;
    managementToken = "";
    managementShortUrl = "";
    managementShortTitle = "";
    managementPreviewVersion = 0;
    unsubscribeResponses?.();
    unsubscribeResponses = null;
    renderCreate();
  }
}

async function start() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, account => {
    user = account;
    if (!user) return signInAnonymously(auth);
    handleRoute();
  });
  window.addEventListener("hashchange", handleRoute);
}

start().catch(error => {
  console.error(error);
  root.innerHTML = '<main class="error-screen"><h1>網站初始化失敗</h1><p>請確認 Firebase 設定。</p></main>';
});
