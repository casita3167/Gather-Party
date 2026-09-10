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
  return `<header class="quick-brand"><a class="quick-home" href="./#"><span class="brandmark">⚄</span><span>Gather Party<small>快速約團</small></span></a><a href="./#">← 回到團務首頁</a></header>`;
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
        <label>成團門檻<input name="minPlayers" type="number" min="1" max="20" value="4" required><small class="muted">只用來判斷哪些時段可以成團，不會限制填表人數。</small></label>
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
      minPlayers: Number(form.minPlayers.value),
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
    const firstDate = [...choices.keys()].sort()[0];
    responseMonthCursor = firstDate
      ? new Date(Number(firstDate.slice(0, 4)), Number(firstDate.slice(5, 7)) - 1, 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let rendered = false;
    unsubscribeResponses = onSnapshot(collection(db, "quickSchedules", id, "responses"), result => {
      responses = result.docs.map(item => ({ id: item.id, ...item.data() }));
      if (!rendered) {
        const latestMine = responses.find(item => item.id === user.uid) || mineData;
        if (latestMine) choices = new Map(Object.entries(latestMine.choices || {}).map(([date, values]) => [date, new Set(values)]));
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
    root.innerHTML = `<main class="error-screen"><span class="brandmark">⚄</span><h1>無法開啟約團表</h1><p>${escapeHtml(error.message)}</p><a class="button" href="./quick.html">建立新的約團表</a></main>`;
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

function renderSchedule(mineData) {
  const periodRanges = schedule.periods || {};
  const submitted = responses.filter(item => item.submitted);
  const best = bestSlots(submitted);
  const playerLink = schedule.shortPlayerUrl || quickUrl(schedule.id);
  const privateLink = managementToken ? (managementShortUrl || manageUrl(schedule.id, managementToken)) : "";
  root.innerHTML = `<main class="quick-shell">${brand()}
    <a class="quick-back" href="./quick.html" aria-label="回到建立快速約團頁面">← 上一頁：建立快速約團</a>
    <section class="schedule-banner"><div><span class="eyebrow">QUICK SCHEDULER</span><h1>${escapeHtml(schedule.title)}</h1><p>建立者／統計者：${escapeHtml(schedule.coordinatorName)}${schedule.gmName ? `・實際 GM：${escapeHtml(schedule.gmName)}` : ""}</p></div>${schedule.contact ? `<div class="contact-card"><span>給玩家的聯絡方式</span><b>${escapeHtml(schedule.contact)}</b></div>` : ""}</section>
    ${schedule.note ? `<p class="quick-note">${escapeHtml(schedule.note)}</p>` : ""}
    <div class="schedule-grid"><form id="response-form" class="quick-card"><h2>填寫我的時間</h2><p>先從月曆點選你要填寫的日期，再選早上、下午、晚上或 X。儲存後仍可隨時回來修改日期。</p>${periodLegendMarkup(periodRanges)}<label>玩家名稱<input name="playerName" maxlength="30" value="${escapeHtml(mineData?.playerName || localStorage.getItem("gather-party-player") || "")}" required></label><div class="date-picker-head"><h3 id="response-month-title">${responseMonthCursor.getFullYear()} 年 ${responseMonthCursor.getMonth() + 1} 月</h3><div class="date-picker-nav"><button class="mini-button" id="response-prev" type="button">‹</button><button class="mini-button" id="response-today" type="button">今</button><button class="mini-button" id="response-next" type="button">›</button></div></div><div id="response-calendar">${responseCalendarMarkup()}</div><h3>已選日期與時段</h3><div class="choice-list" id="response-choice-list">${responseChoiceListMarkup(periodRanges)}</div><label>備註<textarea name="note" maxlength="500" placeholder="例如：晚上九點後才有空、這天可能需要再確認">${escapeHtml(mineData?.note || "")}</textarea></label><div class="quick-form-actions"><span class="muted">至少選擇一個日期，且每個日期都要選時段或 X</span><button class="button" type="submit">${mineData?.submitted ? "儲存變更" : "儲存我的時間"}</button></div></form>
      <aside class="quick-card"><h2>可成團時段</h2><p id="response-count">${submitted.length} 人已填寫・填表人數不限・${schedule.minPlayers} 人同時有空即達門檻</p><div class="best-slots" id="best-slots">${bestMarkup(best, submitted.length)}</div><label>玩家填表連結<div class="share-box"><input id="player-link" readonly value="${escapeHtml(playerLink)}" aria-label="玩家填表短網址"><button class="button secondary" id="copy-quick" type="button">複製</button></div></label>${canManageSchedule ? `<div class="management-box"><h3>私人管理連結</h3><p>換裝置時用這條隨機短網址取回管理權限，請勿傳給玩家。</p>${privateLink ? `<div class="share-box"><input id="manager-link" readonly value="${escapeHtml(privateLink)}" aria-label="私人管理短網址"><button class="button secondary" id="copy-manager" type="button">複製</button></div>` : '<p class="muted">私人管理連結建立中。</p>'}<div class="management-actions"><button class="button secondary full" id="edit-current-schedule" type="button">編輯約團設定</button><button class="button reject full" id="delete-current-schedule" type="button">刪除這張約團表</button></div></div>` : ""}</aside>
    </div>
    <section class="quick-card overview"><h2>玩家時間一覽</h2><p>每位玩家的選擇與備註會集中顯示在這裡。</p>${periodLegendMarkup(periodRanges)}<div id="overview-content">${overviewMarkup(submitted)}</div></section>
  </main>`;
  bindChoiceButtons();
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
  dialog.innerHTML = `<form method="dialog" class="dialog-card" id="edit-schedule-form"><div class="dialog-head"><div><span class="eyebrow">MANAGEMENT</span><h2>編輯約團設定</h2></div><button class="icon-button" type="button" data-close aria-label="關閉">×</button></div><label>團務名稱<input name="title" maxlength="80" value="${escapeHtml(schedule.title)}" required></label><div class="form-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" value="${escapeHtml(schedule.coordinatorName)}" required></label><label>實際 GM<input name="gmName" maxlength="40" value="${escapeHtml(schedule.gmName || "")}" placeholder="尚未確定可留白"></label></div><label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" value="${escapeHtml(schedule.contact || "")}"></label><label>給玩家的說明<textarea name="note" maxlength="800">${escapeHtml(schedule.note || "")}</textarea></label><label>成團門檻<input name="minPlayers" type="number" min="1" max="20" value="${Number(schedule.minPlayers || 1)}" required><small class="muted">只影響可成團時段判斷，不限制填表人數。</small></label><h3>時段範圍</h3><div class="period-settings"><label class="period-setting"><span>早上</span><input name="morning" value="${escapeHtml(periods["早上"] || "09:00～12:00")}" required></label><label class="period-setting"><span>下午</span><input name="afternoon" value="${escapeHtml(periods["下午"] || "13:00～18:00")}" required></label><label class="period-setting"><span>晚上</span><input name="evening" value="${escapeHtml(periods["晚上"] || "20:30～24:00")}" required></label></div><div class="dialog-actions"><button class="button secondary" type="button" data-close>取消</button><button class="button" type="submit">儲存設定</button></div></form>`;
  root.appendChild(dialog);
  dialog.showModal();
  dialog.querySelectorAll("[data-close]").forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("#edit-schedule-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
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
      minPlayers: Number(form.minPlayers.value),
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

function bestMarkup(items, total) {
  return items.length
    ? items.slice(0, 10).map(item => `<div class="best-slot"><span>${escapeHtml(dateLabel(item.date, true))}・${escapeHtml(item.period)}</span><small>${total > 0 && item.count === total ? "全員皆可・" : ""}${item.count}／${total} 人</small></div>`).join("")
    : '<div class="empty small">等待更多玩家填寫。</div>';
}

function refreshOverview() {
  const submitted = responses.filter(item => item.submitted);
  const count = document.querySelector("#response-count");
  const best = document.querySelector("#best-slots");
  const overview = document.querySelector("#overview-content");
  if (count) count.textContent = `${submitted.length} 人已填寫・填表人數不限・${schedule.minPlayers} 人同時有空即達門檻`;
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
  const availablePlayers = responses.filter(player =>
    player.submitted && PERIOD_KEYS.some(period => player.choices?.[date]?.includes(period))
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
    const selected = choices.has(date);
    const dayNote = holiday || (date === today ? "今天" : "");
    cells.push(`<button class="quick-day ${selected ? "selected" : ""} ${holiday ? "holiday" : ""} ${date === today ? "today" : ""}" type="button" data-response-date="${date}" title="${escapeHtml(dayNote || date)}" aria-pressed="${selected}"><span>${day}</span>${calendarPlayersMarkup(date)}${dayNote ? `<small>${escapeHtml(dayNote)}</small>` : ""}</button>`);
  }
  return `<div class="quick-calendar"><div class="quick-weekday">一</div><div class="quick-weekday">二</div><div class="quick-weekday">三</div><div class="quick-weekday">四</div><div class="quick-weekday">五</div><div class="quick-weekday">六</div><div class="quick-weekday">日</div>${cells.join("")}</div>`;
}

function responseChoiceListMarkup(ranges) {
  const dates = [...choices.keys()].sort();
  return dates.length
    ? dates.map(date => choiceRow(date, ranges)).join("")
    : '<div class="empty small">請先在上方月曆點選日期。</div>';
}

function bindResponseCalendar(ranges) {
  const refreshCalendar = () => {
    document.querySelector("#response-month-title").textContent = `${responseMonthCursor.getFullYear()} 年 ${responseMonthCursor.getMonth() + 1} 月`;
    document.querySelector("#response-calendar").innerHTML = responseCalendarMarkup();
    bindResponseDayButtons(ranges);
  };
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
    if (choices.has(date)) choices.delete(date);
    else {
      if (choices.size >= 31) return toast("一次最多可填寫 31 個日期。");
      choices.set(date, new Set());
    }
    button.classList.toggle("selected", choices.has(date));
    button.setAttribute("aria-pressed", String(choices.has(date)));
    document.querySelector("#response-choice-list").innerHTML = responseChoiceListMarkup(ranges);
    bindChoiceButtons();
    markResponseDirty();
  });
}

function choiceRow(date, ranges) {
  const selected = choices.get(date) || new Set();
  return `<div class="choice-row"><div class="choice-date"><b>${escapeHtml(dateLabel(date))}</b><span>${escapeHtml(holidayFor(date) || "一般日期")}</span></div>${PERIOD_KEYS.map(period => `<button class="choice-button ${selected.has(period) ? "selected" : ""}" type="button" data-date="${date}" data-choice="${period}" title="${escapeHtml(ranges[period] || "")}" aria-pressed="${selected.has(period)}">${period}</button>`).join("")}<button class="choice-button no ${selected.has("X") ? "selected" : ""}" type="button" data-date="${date}" data-choice="X" aria-pressed="${selected.has("X")}">X</button></div>`;
}

function bindChoiceButtons() {
  document.querySelectorAll(".choice-button").forEach(button => button.onclick = () => {
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
  if (button) button.textContent = "儲存變更";
}

async function saveResponse(event) {
  event.preventDefault();
  if (!choices.size) return toast("請先從月曆選擇至少一個日期。");
  if ([...choices.values()].some(values => !values.size)) return toast("每個已選日期都要選擇早上、下午、晚上或 X。");
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const choiceObject = Object.fromEntries([...choices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => [date, [...values]]));
  try {
    await setDoc(doc(db, "quickSchedules", schedule.id, "responses", user.uid), {
      playerName: form.playerName.value.trim(),
      note: form.note.value.trim(),
      choices: choiceObject,
      submitted: true,
      updatedAt: serverTimestamp()
    });
    localStorage.setItem("gather-party-player", form.playerName.value.trim());
    button.disabled = false;
    button.textContent = "已儲存！仍可繼續修改";
    toast("你的時間已儲存");
  } catch (error) {
    console.error(error);
    toast("儲存失敗，請稍後再試。");
    button.disabled = false;
  }
}

function bestSlots(players) {
  const dates = [...new Set(players.flatMap(player => Object.keys(player.choices || {})))].sort();
  const slots = dates.flatMap(date => PERIOD_KEYS.map(period => ({
    date, period,
    count: players.filter(player => player.choices?.[date]?.includes(period)).length
  })));
  const enough = slots.filter(item => item.count >= Number(schedule.minPlayers || 1));
  return enough.sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || PERIOD_KEYS.indexOf(a.period) - PERIOD_KEYS.indexOf(b.period));
}

function overviewMarkup(players) {
  if (!players.length) return '<div class="empty">目前還沒有人填寫。</div>';
  return `<div class="player-availability-grid">${players.map(player => {
    const dates = Object.keys(player.choices || {}).sort();
    const canDelete = player.id === user?.uid || canManageSchedule;
    const deleteLabel = player.id === user?.uid ? "刪除我的填寫" : `刪除 ${player.playerName} 的登記`;
    const deleteButton = canDelete ? `<button class="delete-my-response" type="button" data-response-id="${escapeHtml(player.id)}" data-player-name="${escapeHtml(player.playerName)}" aria-label="${escapeHtml(deleteLabel)}" title="${escapeHtml(deleteLabel)}">×</button>` : "";
    return `<article class="player-availability"><header><h3>${escapeHtml(player.playerName)}</h3>${deleteButton}</header>${player.note ? `<p class="response-note">${escapeHtml(player.note)}</p>` : ""}<div>${dates.map(date => { const values = player.choices?.[date] || []; const label = values.includes("X") ? "X" : values.join("／"); return `<span class="player-date-choice"><b>${escapeHtml(dateLabel(date, true))}</b><i class="choice-mark ${values.includes("X") ? "no" : ""}">${escapeHtml(label || "未選時段")}</i></span>`; }).join("")}</div></article>`;
  }).join("")}</div>`;
}

function bindOverviewActions() {
  document.querySelectorAll(".delete-my-response").forEach(button => button.addEventListener("click", async event => {
    const target = event.currentTarget;
    const responseId = target.dataset.responseId;
    const isMine = responseId === user?.uid;
    if (!user || (!isMine && !canManageSchedule)) return;
    const playerName = target.dataset.playerName || "這位玩家";
    const message = isMine
      ? "確定要刪除自己的填寫資料嗎？日期、時段與備註都會被移除。"
      : `確定要刪除「${playerName}」的登記嗎？日期、時段與備註都會被移除。`;
    if (!window.confirm(message)) return;
    target.disabled = true;
    try {
      await deleteDoc(doc(db, "quickSchedules", schedule.id, "responses", responseId));
      responses = responses.filter(player => player.id !== responseId);
      if (isMine) {
        choices.clear();
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
