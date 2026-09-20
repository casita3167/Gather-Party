import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, getFirestore, onSnapshot,
  query, runTransaction, serverTimestamp, setDoc, updateDoc, where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { holidayFor } from "./taiwan-holidays.js?v=20260912-1";

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
let draftLockedDates = new Set();
const shownMergeConfirmations = new Set();
let responses = [];
let choices = new Map();
let batchGroups = new Map();
let batchDates = new Set();
let batchApplied = false;
let unsubscribeResponses = null;
let unsubscribeSchedule = null;
let canManageSchedule = false;
let managementToken = "";
let managementShortUrl = "";
let managementShortTitle = "";
let managementPreviewVersion = 0;
let bestSlotSort = "count";
let bestSlotPlayerKey = "";

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
  draftLockedDates = new Set();
  root.innerHTML = `<main class="quick-shell">${brand()}
    <section class="quick-head"><span class="eyebrow">QUICK SCHEDULER</span><h1>一眼找出能跑團的時間。</h1><p>建立者可以只是負責統計的人，不必是實際 GM。選好候選日期與早、中、晚的範圍，再把連結交給玩家即可。</p></section>
    <section class="quick-card my-schedules"><div class="my-schedules-head"><h2>我的快速約團表</h2><p>這台裝置建立的約團表會保留在這裡，不需要 GM 權限。</p></div><div id="my-schedules-list" class="my-schedules-list"><span class="muted">正在讀取⋯</span></div></section>
    <form id="create-quick" class="quick-card quick-create-form">
      <section><h2>團務與聯絡資訊</h2><p>建立者只需要設定團務資訊與時段範圍；每位玩家打開連結後，會自行從月曆選擇可跑日期。</p>
        <label>團務名稱<input name="title" maxlength="80" required placeholder="例如：十月團務時間調查"></label>
        <div class="form-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" required placeholder="你的名稱"></label><label>預定 GM（選填）<input name="gmName" maxlength="40" placeholder="實際 GM 仍須由填表者認領"></label></div>
        <label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" placeholder="Discord、LINE 或其他聯絡方式"></label>
        <label>給玩家的說明<textarea name="note" maxlength="800" placeholder="預計遊玩的系統、時數或其他提醒"></textarea></label>
        <div class="form-grid"><label>最低成團人數<input name="minPlayers" type="number" min="1" max="20" value="4" required></label><label>最多參加人數（選填）<input name="maxPlayers" type="number" min="1" max="20" value="6" placeholder="不設上限"></label></div><small class="muted">同一天、同一時段 GM 有空且玩家達到最低人數即可成團；超過參加上限仍保留時段，由團務管理者協調名單。</small>
        <h3>時段範圍</h3><div class="period-settings"><label class="period-setting"><span>早上</span><input name="morning" value="09:00～12:00" required></label><label class="period-setting"><span>下午</span><input name="afternoon" value="13:00～18:00" required></label><label class="period-setting"><span>晚上</span><input name="evening" value="20:30～24:00" required></label></div>
        <p class="quick-note">玩家只會看到「早上／下午／晚上／△ 不確定／X」五個按鈕；滑鼠移到時段上即可查看你設定的範圍。</p>
        <section aria-label="不開放日期"><h3>不開放日期（選填）</h3><p>點選要鎖定的日期，再點一次即可取消。建立後，只能透過私人管理連結修改。</p><div class="date-picker-head"><h3 id="draft-lock-month"></h3><div class="date-picker-nav"><button type="button" class="mini-button" id="draft-lock-prev" aria-label="上個月">‹</button><button type="button" class="mini-button" id="draft-lock-next" aria-label="下個月">›</button></div></div><div id="draft-lock-calendar"></div><p id="draft-lock-count" role="status"></p></section>
        <button class="button full" type="submit">建立快速約團表</button>
      </section>
    </form>
  </main>`;
  document.querySelector("#create-quick").addEventListener("submit", createSchedule);
  bindDraftLockedDates();
  loadMySchedules();
}


function bindDraftLockedDates() {
  const today = taiwanTodayKey();
  let cursor = new Date(Number(today.slice(0,4)), Number(today.slice(5,7))-1, 1);
  const draw = () => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    document.querySelector("#draft-lock-month").textContent = y + " 年 " + (m+1) + " 月";
    let html = ["一","二","三","四","五","六","日"].map(day => '<div class="quick-weekday">' + day + '</div>').join("");
    for (let i=0; i<(new Date(y,m,1).getDay()+6)%7; i++) html += '<div></div>';
    for (let d=1; d<=new Date(y,m+1,0).getDate(); d++) {
      const date = y + "-" + String(m+1).padStart(2,"0") + "-" + String(d).padStart(2,"0");
      const locked = draftLockedDates.has(date), holiday = holidayFor(date);
      html += '<button type="button" class="quick-day ' + (locked ? 'locked' : holiday ? 'holiday' : '') + '" data-draft-lock="' + date + '" aria-label="' + date + (locked ? ' 已鎖定，點擊取消' : ' 點擊鎖定') + '" aria-pressed="' + locked + '"><span>' + d + '</span>' + (locked ? '<small>🔒 不開放</small>' : holiday ? '<small>' + escapeHtml(holiday) + '</small>' : '') + '</button>';
    }
    document.querySelector("#draft-lock-calendar").innerHTML = '<div class="quick-calendar">' + html + '</div>';
    document.querySelector("#draft-lock-count").textContent = "已設定 " + draftLockedDates.size + " 天不開放";
    document.querySelectorAll("[data-draft-lock]").forEach(button => button.onclick = () => {
      const date = button.dataset.draftLock;
      draftLockedDates.has(date) ? draftLockedDates.delete(date) : draftLockedDates.add(date);
      draw();
    });
  };
  document.querySelector("#draft-lock-prev").onclick = () => { cursor = new Date(cursor.getFullYear(),cursor.getMonth()-1,1); draw(); };
  document.querySelector("#draft-lock-next").onclick = () => { cursor = new Date(cursor.getFullYear(),cursor.getMonth()+1,1); draw(); };
  draw();
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
      maxGMs: 3,
      contact: form.contact.value.trim(),
      note: form.note.value.trim(),
      minPlayers,
      maxPlayers: maxPlayers || null,
      dates: [],
      lockedDates: Object.fromEntries([...draftLockedDates].map(date => [date, true])),
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
    bestSlotSort = "count";
    bestSlotPlayerKey = "";
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
        requestAnimationFrame(maybeOpenMergeConfirmDialog);
        unsubscribeSchedule = onSnapshot(doc(db, "quickSchedules", id), latest => {
          if (!latest.exists() || schedule?.id !== id) return;
          schedule.closed = latest.data().closed === true;
          schedule.lockedDates = latest.data().lockedDates || {};
          schedule.maxGMs = latest.data().maxGMs || 3;
          restoreLockedChoices();
          refreshChoiceControls(schedule.periods || {});
          refreshOverview();
        }, error => { console.error(error); toast("無法同步日期鎖定，請重新整理。"); });
      } else {
        refreshOverview();
        requestAnimationFrame(maybeOpenMergeConfirmDialog);
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
        selected.delete("△");
        availablePeriods.forEach(period => selected.add(period));
      } else if (values.includes("△") && !PERIOD_KEYS.some(period => selected.has(period))) {
        selected.delete("X");
        selected.add("△");
      } else if (values.includes("X") && !selected.has("△") && !PERIOD_KEYS.some(period => selected.has(period))) {
        selected.add("X");
      }
      if (selected.size) {
        merged[date] = [
          ...PERIOD_KEYS.filter(period => selected.has(period)),
          ...(selected.has("X") ? ["X"] : []),
          ...(selected.has("△") ? ["△"] : [])
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
    const responseIds = group.map(response => response.id);
    const reconciled = [...group]
      .sort((a, b) => responseUpdatedMillis(b) - responseUpdatedMillis(a))
      .find(response => Array.isArray(response.reconciledResponseIds)
        && responseIds.every(id => response.reconciledResponseIds.includes(id)));
    const source = reconciled || latest;
    const choices = reconciled ? (reconciled.choices || {}) : mergedResponseChoices(group);
    const notes = reconciled
      ? [reconciled.note?.trim()].filter(Boolean)
      : [...new Set(group.map(response => response.note?.trim()).filter(Boolean))];
    return {
      ...source,
      choices,
      batchGroups: reconciled
        ? (reconciled.batchGroups || Object.fromEntries(normalizeBatchGroups(choices)))
        : Object.fromEntries(normalizeBatchGroups(choices)),
      note: notes.join("／"),
      responseIds,
      mergedCount: group.length,
      needsReconciliation: group.length > 1 && !reconciled
    };
  });
}

function playerRangeLabel(scheduleData = schedule) {
  const minimum = Number(scheduleData?.minPlayers || 1);
  const maximum = Number(scheduleData?.maxPlayers || 0);
  return maximum >= minimum
    ? `GM 有空且至少 ${minimum} 位玩家同時有空即可成團，最多 ${maximum} 位玩家參加（不含 GM）`
    : `至少 ${minimum} 人同時有空即可成團`;
}


function maxGMCount(scheduleData = schedule) {
  const value = Number(scheduleData?.maxGMs || 3);
  return Number.isInteger(value) ? Math.min(20, Math.max(1, value)) : 3;
}
function gmClaimMarkup(isGM = false) {
  const claimed = uniqueSubmittedResponses(responses).filter(r => r.isGM === true);
  const limit = maxGMCount();
  const full = !isGM && claimed.length >= limit;
  return `<label class="gm-claim"><input type="checkbox" name="isGM" ${isGM ? "checked" : ""} ${full ? "disabled" : ""}>我是本團主持人（GM，不計入玩家人數）</label><p class="muted">GM 以黃色標示，勾選後請儲存，不計入玩家人數。</p>`;
}
function gmStatusText(players) {
  const gms = players.filter(p => p.isGM === true);
  return gms.length ? "GM：" + gms.map(gm => gm.playerName).join("、") : "尚未有 GM 認領，暫不判定成團。";
}

function bestSlotControlsMarkup(players) {
  const playerOptions = players
    .filter(player => !player.isGM)
    .sort((a, b) => a.playerName.localeCompare(b.playerName, "zh-Hant"));
  return `<div class="best-slot-controls" id="best-slot-controls">
    <label><span>排序方式</span><select id="best-slot-sort">
      <option value="count" ${bestSlotSort === "count" ? "selected" : ""}>可參加人數最多</option>
      <option value="date" ${bestSlotSort === "date" ? "selected" : ""}>日期由近到遠</option>
    </select></label>
    <label><span>指定玩家</span><select id="best-slot-player">
      <option value="">所有玩家</option>
      ${playerOptions.map(player => {
        const key = normalizedPlayerName(player.playerName);
        return `<option value="${escapeHtml(key)}" ${bestSlotPlayerKey === key ? "selected" : ""}>${escapeHtml(player.playerName)}</option>`;
      }).join("")}
    </select></label>
  </div>`;
}

function displayedBestSlots(players) {
  let slots = bestSlots(players);
  if (bestSlotPlayerKey) {
    slots = slots.filter(slot => slot.players.some(player =>
      normalizedPlayerName(player.playerName) === bestSlotPlayerKey
    ));
  }
  return [...slots].sort((a, b) => bestSlotSort === "date"
    ? a.date.localeCompare(b.date)
      || PERIOD_KEYS.indexOf(a.period) - PERIOD_KEYS.indexOf(b.period)
      || b.count - a.count
    : b.count - a.count
      || a.date.localeCompare(b.date)
      || PERIOD_KEYS.indexOf(a.period) - PERIOD_KEYS.indexOf(b.period));
}

function bindBestSlotControls() {
  document.querySelector("#best-slot-sort")?.addEventListener("change", event => {
    bestSlotSort = event.currentTarget.value;
    refreshBestSlotResults();
  });
  document.querySelector("#best-slot-player")?.addEventListener("change", event => {
    bestSlotPlayerKey = event.currentTarget.value;
    refreshBestSlotResults();
  });
}

function refreshBestSlotResults(players = uniqueSubmittedResponses(responses)) {
  const playerKeys = new Set(players.filter(player => !player.isGM)
    .map(player => normalizedPlayerName(player.playerName)));
  if (bestSlotPlayerKey && !playerKeys.has(bestSlotPlayerKey)) bestSlotPlayerKey = "";
  const controls = document.querySelector("#best-slot-controls");
  if (controls) {
    controls.outerHTML = bestSlotControlsMarkup(players);
    bindBestSlotControls();
  }
  const best = document.querySelector("#best-slots");
  if (best) best.innerHTML = bestMarkup(
    displayedBestSlots(players),
    players.filter(player => !player.isGM).length,
    bestSlotPlayerKey ? "這位玩家目前沒有符合成團條件的時段。" : ""
  );
}

function renderSchedule(mineData) {
  const periodRanges = schedule.periods || {};
  const submitted = uniqueSubmittedResponses(responses);
  const best = displayedBestSlots(submitted);
  const playerLink = schedule.shortPlayerUrl || quickUrl(schedule.id);
  const privateLink = managementToken ? (managementShortUrl || manageUrl(schedule.id, managementToken)) : "";
  root.innerHTML = `<main class="quick-shell">${brand()}
    <a class="quick-back" href="./quick.html" aria-label="回到建立快速約團頁面">← 上一頁：建立快速約團</a>
    <section class="schedule-banner"><div><span class="eyebrow">QUICK SCHEDULER</span><h1>${escapeHtml(schedule.title)}</h1><p>建立者／統計者：${escapeHtml(schedule.coordinatorName)}${schedule.gmName ? `・實際 GM：${escapeHtml(schedule.gmName)}` : ""}</p></div>${schedule.contact ? `<div class="contact-card"><span>給玩家的聯絡方式</span><b>${escapeHtml(schedule.contact)}</b></div>` : ""}</section>
    ${schedule.note ? `<p class="quick-note">${escapeHtml(schedule.note)}</p>` : ""}
    <p id="schedule-status" role="status"></p><div class="management-actions"><button class="button secondary" id="export-results" type="button">匯出約團結果</button>${canManageSchedule ? `<button class="button reject" id="close-schedule" type="button">結束約團</button>` : ""}</div>
    <div class="schedule-grid"><form id="response-form" class="quick-card"><h2>填寫我的時間</h2><p>先從月曆點選你要填寫的日期，再選早上、下午、晚上、△ 不確定或 X。△ 表示當天可能有空、時段未定，不計入確定成團人數。儲存後仍可隨時回來修改日期。</p>${periodLegendMarkup(periodRanges)}<label>玩家名稱<input name="playerName" maxlength="30" value="${escapeHtml(mineData?.playerName || localStorage.getItem("gather-party-player") || "")}" required></label>${gmClaimMarkup(responses.find(r => r.id === user?.uid)?.isGM === true)}<div class="date-picker-head"><h3 id="response-month-title">${responseMonthCursor.getFullYear()} 年 ${responseMonthCursor.getMonth() + 1} 月</h3><div class="date-picker-nav"><button class="mini-button" id="response-prev" type="button">‹</button><button class="mini-button" id="response-today" type="button">今</button><button class="mini-button" id="response-next" type="button">›</button></div></div><div class="date-preset-bar" aria-label="快速選擇本月日期"><span>快速選日期</span><button class="date-preset-button" type="button" data-date-preset="weekdays">週一～週五</button><button class="date-preset-button" type="button" data-date-preset="weekends">週末</button><button class="date-preset-button" type="button" data-date-preset="all">全月</button><button class="date-preset-button clear" type="button" data-date-preset="clear">清除本月</button></div><div id="response-calendar">${responseCalendarMarkup()}</div><section class="batch-choice-panel"><div><h3>批次設定時段</h3><p id="batch-choice-count">目前批次 0 天</p><small>套用時段後按「儲存時間」，日期會收進編號批次；接著即可繼續選下一批。</small></div><div class="batch-choice-actions">${PERIOD_KEYS.map(period => `<button class="choice-button batch-choice-button" type="button" data-batch-choice="${period}">${period}</button>`).join("")}<button class="choice-button uncertain batch-choice-button" type="button" data-batch-choice="△" title="當天可能有空，時段尚未確定" aria-label="不確定">△</button><button class="choice-button no batch-choice-button" type="button" data-batch-choice="X">X</button><button class="choice-button clear batch-choice-button" type="button" data-batch-choice="clear">清除時段</button></div></section><details class="choice-details" id="choice-details" ${choices.size <= 3 ? "open" : ""}><summary>逐日調整 <span id="choice-summary-count">${choices.size} 天</span></summary><div class="choice-list" id="response-choice-list">${responseChoiceListMarkup(periodRanges)}</div></details><label>備註<textarea name="note" maxlength="500" placeholder="例如：晚上九點後才有空、這天可能需要再確認">${escapeHtml(mineData?.note || "")}</textarea></label><div class="quick-form-actions"><span class="muted">至少選擇一個日期，且每個日期都要選時段、△ 不確定或 X</span><button class="button" type="submit">儲存時間</button></div></form>
      <aside class="quick-card"><h2>可成團時段</h2><p id="response-count">${submitted.filter(p => !p.isGM).length} 位玩家已填寫・${escapeHtml(gmStatusText(submitted))}・${playerRangeLabel()}</p>${bestSlotControlsMarkup(submitted)}<div class="best-slots" id="best-slots">${bestMarkup(best, submitted.filter(p => !p.isGM).length, bestSlotPlayerKey ? "這位玩家目前沒有符合成團條件的時段。" : "")}</div><label>玩家填表連結<div class="share-box"><input id="player-link" readonly value="${escapeHtml(playerLink)}" aria-label="玩家填表短網址"><button class="button secondary" id="copy-quick" type="button">複製</button></div></label>${canManageSchedule ? `<div class="management-box"><h3>私人管理連結</h3><p>換裝置時用這條隨機短網址取回管理權限，請勿傳給玩家。</p>${privateLink ? `<div class="share-box"><input id="manager-link" readonly value="${escapeHtml(privateLink)}" aria-label="私人管理短網址"><button class="button secondary" id="copy-manager" type="button">複製</button></div>` : '<p class="muted">私人管理連結建立中。</p>'}<div class="management-actions"><button class="button secondary full" id="lock-schedule-dates" type="button">🔒 設定不開放日期</button><button class="button secondary full" id="edit-current-schedule" type="button">編輯約團設定</button><button class="button reject full" id="delete-current-schedule" type="button">刪除這張約團表</button></div></div>` : ""}</aside>
    </div>
    <section class="quick-card overview"><h2>玩家時間一覽</h2><p>每位玩家的選擇與備註會集中顯示在這裡。</p>${periodLegendMarkup(periodRanges)}<div id="overview-content">${overviewMarkup(submitted)}</div></section>
  </main>`;
  document.querySelector("#export-results").onclick = exportScheduleResults;
  document.querySelector("#close-schedule")?.addEventListener("click", closeSchedule);
  bindChoiceControls(periodRanges);
  bindResponseCalendar(periodRanges);
  bindOverviewActions();
  bindBestSlotControls();
  const responseForm = document.querySelector("#response-form");
  responseForm.onsubmit = saveResponse;
  responseForm.addEventListener("input", markResponseDirty);
  applyClosedState();
  document.querySelector("#copy-quick").onclick = async () => {
    try { await navigator.clipboard.writeText(playerLink); toast("已複製玩家填表連結"); } catch { toast("請手動複製網址。"); }
  };
  document.querySelector("#copy-manager")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(privateLink); toast("已複製私人管理連結"); } catch { toast("請手動複製網址。"); }
  });
  document.querySelector("#lock-schedule-dates")?.addEventListener("click", openLockedDatesDialog);
  document.querySelector("#edit-current-schedule")?.addEventListener("click", openEditScheduleDialog);
  document.querySelector("#delete-current-schedule")?.addEventListener("click", event => {
    deleteQuickSchedule(schedule.id, schedule.title, event.currentTarget);
  });
}


function isDateLocked(date) {
  return Object.hasOwn(schedule?.lockedDates || {}, date);
}

function restoreLockedChoices() {
  const saved = responses.find(item => item.id === user.uid)?.choices || {};
  for (const date of Object.keys(schedule?.lockedDates || {})) {
    batchDates.delete(date);
    if (saved[date]) choices.set(date, new Set(saved[date]));
    else { choices.delete(date); batchGroups.delete(date); }
  }
}

function openLockedDatesDialog() {
  if (!canManageSchedule || !routeInfo().token) return;
  const id = schedule.id;
  const dialog = document.createElement("dialog");
  const selected = new Set();
  let cursor = new Date(responseMonthCursor);
  dialog.innerHTML = '<section class="dialog-card"><div class="dialog-head"><h2>不開放日期</h2><button type="button" class="icon-button" data-close aria-label="關閉">×</button></div><p>點選日期後批次鎖定或解除鎖定。鎖定期間保留原填寫紀錄，但不計入成團。</p><div class="date-picker-head"><button type="button" class="mini-button" data-prev>‹</button><h3 data-title></h3><button type="button" class="mini-button" data-next>›</button></div><div data-calendar></div><p data-count role="status"></p><div class="dialog-actions"><button type="button" class="button secondary" data-unlock>解除鎖定</button><button type="button" class="button" data-lock>鎖定日期</button></div></section>';
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  const draw = () => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    dialog.querySelector("[data-title]").textContent = y + " 年 " + (m + 1) + " 月";
    let html = ["一","二","三","四","五","六","日"].map(day => '<div class="quick-weekday">' + day + '</div>').join("");
    for (let i=0; i<(new Date(y,m,1).getDay()+6)%7; i++) html += '<div></div>';
    for (let d=1; d<=new Date(y,m+1,0).getDate(); d++) {
      const date = y + "-" + String(m+1).padStart(2,"0") + "-" + String(d).padStart(2,"0");
      html += '<button type="button" class="quick-day ' + (selected.has(date) ? 'selected' : isDateLocked(date) ? 'locked' : '') + '" data-date="' + date + '" aria-pressed="' + selected.has(date) + '"><span>' + d + '</span>' + (isDateLocked(date) ? '<small>🔒 不開放</small>' : '') + '</button>';
    }
    dialog.querySelector("[data-calendar]").innerHTML = '<div class="quick-calendar">' + html + '</div>';
    dialog.querySelector("[data-count]").textContent = "已選 " + selected.size + " 天";
    dialog.querySelectorAll("[data-date]").forEach(button => button.onclick = () => {
      const date = button.dataset.date;
      selected.has(date) ? selected.delete(date) : selected.add(date);
      draw();
    });
  };
  dialog.querySelector("[data-prev]").onclick = () => { cursor = new Date(cursor.getFullYear(),cursor.getMonth()-1,1); draw(); };
  dialog.querySelector("[data-next]").onclick = () => { cursor = new Date(cursor.getFullYear(),cursor.getMonth()+1,1); draw(); };
  const save = async lock => {
    if (!selected.size) return toast("請先選擇日期。");
    if (!canManageSchedule || routeInfo().id !== id || !routeInfo().token) return dialog.close();
    const dates = [...selected];
    dialog.querySelectorAll("button").forEach(button => button.disabled = true);
    try {
      const lockedDates = await runTransaction(db, async transaction => {
        const ref = doc(db, "quickSchedules", id);
        const snap = await transaction.get(ref);
        if (!snap.exists()) throw new Error("約團表不存在");
        const next = { ...(snap.data().lockedDates || {}) };
        dates.forEach(date => { if (lock) next[date] = true; else delete next[date]; });
        transaction.update(ref, { lockedDates: next });
        return next;
      });
      if (schedule?.id === id) {
        schedule.lockedDates = lockedDates;
        restoreLockedChoices();
        refreshChoiceControls(schedule.periods || {});
        refreshOverview();
      }
      toast(lock ? "已鎖定日期" : "已解除鎖定");
      dialog.close();
    } catch (error) {
      console.error(error);
      toast("日期設定儲存失敗，請確認管理權限。");
      dialog.querySelectorAll("button").forEach(button => button.disabled = false);
    }
  };
  dialog.querySelector("[data-lock]").onclick = () => save(true);
  dialog.querySelector("[data-unlock]").onclick = () => save(false);
  draw();
  dialog.showModal();
}

function openEditScheduleDialog() {
  if (!canManageSchedule) return;
  const dialog = document.createElement("dialog");
  dialog.id = "edit-schedule-dialog";
  const periods = schedule.periods || {};
  dialog.innerHTML = `<form method="dialog" class="dialog-card" id="edit-schedule-form"><div class="dialog-head"><div><span class="eyebrow">MANAGEMENT</span><h2>編輯約團設定</h2></div><button class="icon-button" type="button" data-close aria-label="關閉">×</button></div><label>團務名稱<input name="title" maxlength="80" value="${escapeHtml(schedule.title)}" required></label><div class="form-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" value="${escapeHtml(schedule.coordinatorName)}" required></label><label>預定 GM（選填）<input name="gmName" maxlength="40" value="${escapeHtml(schedule.gmName || "")}" placeholder="實際 GM 仍須由填表者認領"></label></div><label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" value="${escapeHtml(schedule.contact || "")}"></label><label>給玩家的說明<textarea name="note" maxlength="800">${escapeHtml(schedule.note || "")}</textarea></label><div class="form-grid"><label>最低成團人數<input name="minPlayers" type="number" min="1" max="20" value="${Number(schedule.minPlayers || 1)}" required></label><label>最多參加人數（選填）<input name="maxPlayers" type="number" min="1" max="20" value="${schedule.maxPlayers ? Number(schedule.maxPlayers) : ""}" placeholder="不設上限"></label><label>GM 人數上限<input name="maxGMs" type="number" min="1" max="20" value="${maxGMCount()}" required></label></div><small class="muted">同一天、同一時段達到最低人數即可成團；超過參加上限仍保留時段，由團務管理者協調名單。</small><h3>時段範圍</h3><div class="period-settings"><label class="period-setting"><span>早上</span><input name="morning" value="${escapeHtml(periods["早上"] || "09:00～12:00")}" required></label><label class="period-setting"><span>下午</span><input name="afternoon" value="${escapeHtml(periods["下午"] || "13:00～18:00")}" required></label><label class="period-setting"><span>晚上</span><input name="evening" value="${escapeHtml(periods["晚上"] || "20:30～24:00")}" required></label></div><div class="dialog-actions"><button class="button secondary" type="button" data-close>取消</button><button class="button" type="submit">儲存設定</button></div></form>`;
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
    const maxGMs = Math.min(20, Math.max(1, Number(form.maxGMs.value) || 3));
    const claimedGMs = uniqueSubmittedResponses(responses).filter(player => player.isGM).length;
    if (maxPlayers && maxPlayers < minPlayers) {
      toast("最多參加人數不能少於最低成團人數。");
      button.disabled = false;
      return;
    }
    if (maxGMs < claimedGMs) {
      toast(`目前已有 ${claimedGMs} 位 GM，GM 上限不能設得更低。`);
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
      maxGMs,
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
  return `<div class="period-legend" aria-label="時段範圍與填表符號說明">${PERIOD_KEYS.map(period => `<span><b>${period}</b>${escapeHtml(ranges[period] || defaults[period])}</span>`).join("")}<span title="當天可能有空，時段尚未確定"><b>△</b>不確定</span><span title="當天無法參加"><b>X</b>無法</span></div>`;
}

function bestSlotPlayersMarkup(players = []) {
  return `<span class="best-slot-players" aria-label="可以參加的人員">${players.map(player => {
    const hasNote = Boolean(player.note?.trim());
    const identity = `${player.playerName}${player.isGM ? "（GM）" : ""}`;
    const noteLabel = hasNote ? "，有備註，請至玩家時間一覽查看" : "";
    return `<span class="best-slot-player ${player.isGM ? "gm-player" : ""} ${hasNote ? "has-note" : ""}" title="${escapeHtml(identity + noteLabel)}" aria-label="${escapeHtml(identity + noteLabel)}">${escapeHtml(Array.from(player.playerName || "玩家")[0])}${hasNote ? '<sup class="note-alert" aria-hidden="true">!</sup>' : ""}</span>`;
  }).join("")}</span>`;
}

function bestMarkup(items, total, emptyMessage = "") {
  return items.length
    ? items.slice(0, 10).map(item => `<div class="best-slot"><span class="best-slot-time">${escapeHtml(dateLabel(item.date, true))}・${escapeHtml(item.period)}</span><div class="best-slot-availability">${bestSlotPlayersMarkup([...item.availableGMs, ...item.players])}<small>${item.availableGMs.length} 位 GM 有空・${item.count}／${total} 位玩家${Number(schedule.maxPlayers) > 0 && item.count > Number(schedule.maxPlayers) ? `・可成團，最多 ${Number(schedule.maxPlayers)} 人參加` : ""}</small></div></div>`).join("")
    : `<div class="empty small">${escapeHtml(emptyMessage || "目前沒有 GM 有空且玩家達到最低人數的時段。")}</div>`;
}

function refreshOverview() {
  const submitted = uniqueSubmittedResponses(responses);
  const count = document.querySelector("#response-count");
  const best = document.querySelector("#best-slots");
  const overview = document.querySelector("#overview-content");
  if (count) count.textContent = `${submitted.filter(p => !p.isGM).length} 位玩家已填寫・${gmStatusText(submitted)}・${playerRangeLabel()}`;
  if (best) refreshBestSlotResults(submitted);
  if (overview) {
    overview.innerHTML = overviewMarkup(submitted);
    bindOverviewActions();
  }
  const calendar = document.querySelector("#response-calendar");
  if (calendar) {
    calendar.innerHTML = responseCalendarMarkup();
    bindResponseDayButtons(schedule.periods || {});
  }
  applyClosedState();
}

function calendarPlayersMarkup(date) {
  const availablePlayers = uniqueSubmittedResponses(responses).filter(player =>
    PERIOD_KEYS.some(period => player.choices?.[date]?.includes(period))
  );
  if (!availablePlayers.length) return "";
  const visible = availablePlayers.slice(0,3);
  return `<span class="calendar-players" aria-label="有空的人員：${escapeHtml(availablePlayers.map(p=>p.playerName+(p.isGM?"（GM）":"")).join("、"))}">${visible.map(p=>`<span class="calendar-player ${p.isGM?"gm-player":""}" title="${escapeHtml(p.playerName)}${p.isGM?"（GM）":""}">${escapeHtml(Array.from(p.playerName || "玩家")[0])}</span>`).join("")}${availablePlayers.length>3?`<span class="calendar-player more">+${availablePlayers.length-3}</span>`:""}</span>`;
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
    const dayNote = isDateLocked(date) ? "🔒 不開放" : holiday || (date === today ? "今天" : "");
    const title = inBatch ? `目前選取・${dayNote || date}` : dayNote || date;
    cells.push(`<button class="quick-day ${isDateLocked(date) ? "locked" : ""} ${inBatch ? "selected batch-target" : ""} ${chosen && !inBatch ? "committed" : ""} ${holiday ? "holiday" : ""} ${date === today ? "today" : ""}" type="button" data-response-date="${date}" ${isDateLocked(date) ? "disabled" : ""} title="${escapeHtml(title)}" aria-pressed="${chosen}"><span>${day}</span>${calendarPlayersMarkup(date)}${dayNote ? `<small>${escapeHtml(dayNote)}</small>` : ""}</button>`);
  }
  return `<div class="quick-calendar"><div class="quick-weekday">一</div><div class="quick-weekday">二</div><div class="quick-weekday">三</div><div class="quick-weekday">四</div><div class="quick-weekday">五</div><div class="quick-weekday">六</div><div class="quick-weekday">日</div>${cells.join("")}</div>`;
}

function responseChoiceListMarkup(ranges) {
  const dates = [...choices.keys()].sort();
  return dates.length
    ? dates.map(date => isDateLocked(date) ? `<div class="choice-row locked"><b>${escapeHtml(dateLabel(date))}</b><span>🔒 不開放（原紀錄保留）</span></div>` : choiceRow(date, ranges)).join("")
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
    if (!selected || isDateLocked(date)) continue;
    if (value === "clear") {
      selected.clear();
    } else if (value === "X" || value === "△") {
      selected.clear();
      selected.add(value);
    } else {
      selected.delete("X");
      selected.delete("△");
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
      if (date.startsWith(monthPrefix) && !isDateLocked(date)) {
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
    if (isDateLocked(date)) continue;
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
    if (isDateLocked(date)) return;
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
  return `<div class="choice-row"><div class="choice-date"><b>${escapeHtml(dateLabel(date))}</b><span>${escapeHtml(holidayFor(date) || "一般日期")}</span></div>${PERIOD_KEYS.map(period => `<button class="choice-button ${selected.has(period) ? "selected" : ""}" type="button" data-date="${date}" data-choice="${period}" title="${escapeHtml(ranges[period] || "")}" aria-pressed="${selected.has(period)}">${period}</button>`).join("")}<button class="choice-button uncertain ${selected.has("△") ? "selected" : ""}" type="button" data-date="${date}" data-choice="△" title="當天可能有空，時段尚未確定" aria-label="不確定" aria-pressed="${selected.has("△")}">△</button><button class="choice-button no ${selected.has("X") ? "selected" : ""}" type="button" data-date="${date}" data-choice="X" aria-pressed="${selected.has("X")}">X</button></div>`;
}

function bindChoiceButtons() {
  document.querySelectorAll(".choice-button[data-date]").forEach(button => button.onclick = () => {
    if (isDateLocked(button.dataset.date)) return;
    const set = choices.get(button.dataset.date) || new Set();
    const value = button.dataset.choice;
    if (value === "X" || value === "△") {
      set.clear();
      if (!button.classList.contains("selected")) set.add(value);
    } else {
      set.delete("X");
      set.delete("△");
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
  if (schedule?.closed) return toast("此約團已結束，無法修改填表。");
  restoreLockedChoices();
  if (!choices.size) return toast("請先從月曆選擇至少一個日期。");
  if ([...choices.values()].some(values => !values.size)) return toast("每個已選日期都要選擇早上、下午、晚上、△ 不確定或 X。");
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
    await saveOpenResponse({
      playerName: form.playerName.value.trim(),
      isGM: form.isGM?.checked === true,
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
    toast(error.message?.includes("GM") ? error.message : "儲存失敗，請稍後再試。");
    button.disabled = false;
  }
}

function bestSlots(players) {
  const gms = players.filter(p => p.isGM === true);
  if (!gms.length) return [];
  players = players.filter(p => p.isGM !== true);
  const dates = [...new Set(players.flatMap(player => Object.keys(player.choices || {})))].filter(date => !isDateLocked(date)).sort();
  const slots = dates.flatMap(date => PERIOD_KEYS.map(period => {
    const availablePlayers = players.filter(player => player.choices?.[date]?.includes(period));
    return {
      date,
      period,
      count: availablePlayers.length,
      players: availablePlayers,
      availableGMs: gms.filter(gm => gm.choices?.[date]?.includes(period))
    };
  }));
  const minimum = Number(schedule.minPlayers || 1);
  const enough = slots.filter(item => item.availableGMs.length > 0 && item.count >= minimum);
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
  if (values.includes("△")) return "△ 不確定";
  if (!values.includes("X") && PERIOD_KEYS.every(period => values.includes(period))) return "全天";
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
    const label = choiceLabel(values) + (isDateLocked(date) ? "・🔒 不開放" : "");
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


function maybeOpenMergeConfirmDialog() {
  if (schedule?.closed) return;
  if (document.querySelector("#merge-confirm-dialog")) return;
  const player = uniqueSubmittedResponses(responses).find(item =>
    item.needsReconciliation && item.responseIds?.includes(user?.uid)
  );
  if (!player) return;
  const key = `${schedule.id}:${player.responseIds.slice().sort().join(",")}`;
  if (shownMergeConfirmations.has(key)) return;
  openMergeConfirmDialog(player);
  shownMergeConfirmations.add(key);
}

function mergeConfirmChoiceButtons(date, selected, locked = false) {
  const disabled = locked ? " disabled" : "";
  return [
    ...PERIOD_KEYS.map(period => `<button class="choice-button ${selected.has(period) ? "selected" : ""}" type="button" data-merge-date="${date}" data-merge-choice="${period}" aria-pressed="${selected.has(period)}"${disabled}>${period}</button>`),
    `<button class="choice-button uncertain ${selected.has("△") ? "selected" : ""}" type="button" data-merge-date="${date}" data-merge-choice="△" aria-pressed="${selected.has("△")}"${disabled}>△</button>`,
    `<button class="choice-button no ${selected.has("X") ? "selected" : ""}" type="button" data-merge-date="${date}" data-merge-choice="X" aria-pressed="${selected.has("X")}"${disabled}>X</button>`
  ].join("");
}

function openMergeConfirmDialog(player) {
  if (schedule?.closed) return toast("此約團已結束。");
  if (!player?.responseIds?.includes(user?.uid)) return;
  document.querySelector("#merge-confirm-dialog")?.remove();
  const state = new Map(Object.entries(player.choices || {}).map(([date, values]) => [date, new Set(values)]));
  const ownResponse = responses.find(item => item.id === user.uid);
  const ownChoices = ownResponse?.choices || {};
  Object.keys(schedule?.lockedDates || {}).forEach(date => {
    if (ownChoices[date]) state.set(date, new Set(ownChoices[date]));
    else state.delete(date);
  });
  const dialog = document.createElement("dialog");
  dialog.id = "merge-confirm-dialog";
  dialog.innerHTML = `<form method="dialog" class="dialog-card merge-confirm-card"><div class="dialog-head"><div><span class="eyebrow">確認同名填寫</span><h2>${escapeHtml(player.playerName)}的時間</h2></div><button class="icon-button" type="button" data-close aria-label="稍後確認">×</button></div><p>系統找到 ${player.mergedCount} 筆同名紀錄。請逐日確認早上、下午、晚上、△ 不確定或 X 無法，再儲存為正式內容。</p><div class="merge-confirm-list"></div><label>備註<textarea name="note" maxlength="500">${escapeHtml(player.note || "")}</textarea></label><div class="dialog-actions"><button class="button secondary" type="button" data-close>稍後確認</button><button class="button" type="submit">確認並儲存</button></div></form>`;
  document.body.append(dialog);
  const list = dialog.querySelector(".merge-confirm-list");
  const draw = () => {
    list.innerHTML = [...state.keys()].sort().map(date => {
      const selected = state.get(date) || new Set();
      const locked = isDateLocked(date);
      return `<div class="merge-confirm-row"><div><b>${escapeHtml(dateLabel(date))}</b>${locked ? "<small>🔒 不開放，保留原紀錄</small>" : ""}</div><div class="merge-confirm-choices">${mergeConfirmChoiceButtons(date, selected, locked)}</div></div>`;
    }).join("");
    dialog.querySelectorAll("[data-merge-choice]").forEach(button => button.onclick = () => {
      const selected = state.get(button.dataset.mergeDate) || new Set();
      const value = button.dataset.mergeChoice;
      if (value === "X" || value === "△") {
        const wasSelected = selected.has(value);
        selected.clear();
        if (!wasSelected) selected.add(value);
      } else {
        selected.delete("X");
        selected.delete("△");
        selected.has(value) ? selected.delete(value) : selected.add(value);
      }
      state.set(button.dataset.mergeDate, selected);
      draw();
    });
  };
  dialog.querySelectorAll("[data-close]").forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("form").onsubmit = async event => {
    event.preventDefault();
    if ([...state.values()].some(values => !values.size)) return toast("每個日期都要選擇時段、△ 不確定或 X。");
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const choiceObject = Object.fromEntries([...state.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([date, values]) => [date, [
      ...PERIOD_KEYS.filter(period => values.has(period)),
      ...(values.has("△") ? ["△"] : []),
      ...(values.has("X") ? ["X"] : [])
    ]]));
    try {
      await saveOpenResponse({
        playerName: player.playerName,
        note: event.currentTarget.note.value.trim(),
        choices: choiceObject,
        batchGroups: Object.fromEntries(normalizeBatchGroups(choiceObject)),
        reconciledResponseIds: player.responseIds,
        reconciledAt: serverTimestamp(),
        submitted: true,
        updatedAt: serverTimestamp()
      });
      choices = new Map(Object.entries(choiceObject).map(([date, values]) => [date, new Set(values)]));
      batchGroups = normalizeBatchGroups(choiceObject);
      batchDates.clear();
      batchApplied = false;
      refreshChoiceControls(schedule.periods || {});
      toast("同名填寫已確認並整理完成");
      dialog.close();
    } catch (error) {
      console.error(error);
      toast("合併內容儲存失敗，請稍後再試。");
      button.disabled = false;
    }
  };
  draw();
  dialog.showModal();
}


function openTimeEditor(player) {
  if (schedule?.closed || !player?.responseIds?.includes(user?.uid)) return;
  document.querySelector("#time-edit-dialog")?.close();
  const scheduleId = schedule.id, uid = user.uid;
  const own = responses.find(item => item.id === uid);
  if (!own) return;
  const fingerprint = value => JSON.stringify([value.isGM === true, value.choices || {}, value.note || "", value.updatedAt?.toMillis?.() || 0]);
  const original = fingerprint(own);
  const draft = new Map(Object.entries(player.choices || {}).map(([date, values]) => [date, new Set(values)]));
  for (const date of Object.keys(schedule.lockedDates || {})) {
    if (own.choices?.[date]) draft.set(date, new Set(own.choices[date]));
    else draft.delete(date);
  }
  const selected = new Set();
  let cursor = (Object.keys(player.choices || {}).sort()[0] || taiwanTodayKey()).slice(0,7);
  let busy = false;
  const dialog = document.createElement("dialog");
  dialog.id = "time-edit-dialog";
  dialog.innerHTML = `<style>
    #time-edit-dialog{box-sizing:border-box;width:min(760px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:90dvh;margin:auto;padding:clamp(12px,3vw,24px);border:0;border-radius:20px;overflow:auto;color:var(--ink);background:white}
    #time-edit-dialog::backdrop{background:rgb(20 20 40 / .55)}
    #time-edit-dialog .edit-head,#time-edit-dialog .edit-nav,#time-edit-dialog .edit-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    #time-edit-dialog h2{font-size:clamp(1.2rem,4vw,1.7rem);margin:0}
    #time-edit-dialog .edit-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;margin:12px 0}
    #time-edit-dialog .edit-day{min-width:0;min-height:64px;border:1px solid var(--line);border-radius:9px;background:white;color:var(--ink);padding:5px;overflow-wrap:anywhere}
    #time-edit-dialog .edit-day small{display:block;font-size:.65rem}
    #time-edit-dialog .edit-day.saved{border-color:var(--primary);background:var(--primary-soft)}
    #time-edit-dialog .edit-day.target{background:var(--primary);color:white}
    #time-edit-dialog .edit-day:disabled{opacity:.5}
    #time-edit-dialog .edit-periods{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
    #time-edit-dialog .edit-preview{max-height:220px;overflow:auto;padding-left:22px}
    #time-edit-dialog textarea{box-sizing:border-box;width:100%;min-height:80px;font:inherit}
    #time-edit-dialog .edit-error{color:var(--red)}
    #time-edit-dialog .edit-week{text-align:center}
    @media(max-width:480px){#time-edit-dialog{width:calc(100vw - 12px);max-width:calc(100vw - 12px);max-height:96dvh;border-radius:12px}#time-edit-dialog .edit-day{min-height:60px;padding:3px}}
  </style><form><div class="edit-head"><h2>${escapeHtml(player.playerName)}・修改時間</h2><button type="button" class="icon-button" data-cancel aria-label="取消修改">×</button></div>
  <p>先選日期，再套用時段。淡紫底代表已有填寫，深紫底是本次要調整的日期；所有更動按「儲存修改」後才會送出。</p>
  <div class="edit-nav"><button type="button" class="mini-button" data-month-step="-1" aria-label="上個月">‹</button><b data-month></b><button type="button" class="mini-button" data-month-step="1" aria-label="下個月">›</button></div>
  <div class="edit-days"></div><p data-selection aria-live="polite"></p>
  <div class="edit-periods">${[...PERIOD_KEYS,"△","X"].map(p => `<button type="button" class="choice-button" data-period="${p}">${p}</button>`).join("")}<button type="button" class="button secondary" data-remove>移除所選日期</button><button type="button" class="button secondary" data-clear>完成這批選取</button></div>
  <p>同一批可依序勾選多個時段；完成後按「完成這批選取」，再選另一批日期。</p>
  <h3>本次修改後的時間</h3><ul class="edit-preview"></ul>
  ${gmClaimMarkup(own.isGM === true)}<label>備註<textarea name="note" maxlength="500">${escapeHtml(player.note || "")}</textarea></label><p class="edit-error" role="alert"></p>
  <div class="edit-actions"><button type="button" class="button secondary" data-cancel>取消</button><button type="submit" class="button">儲存修改</button></div></form>`;
  document.body.append(dialog);
  const draw = () => {
    const [year,month] = cursor.split("-").map(Number);
    dialog.querySelector("[data-month]").textContent = year + " 年 " + month + " 月";
    let html = ["一","二","三","四","五","六","日"].map(d => '<span class="edit-week">' + d + '</span>').join("");
    html += "<span></span>".repeat((new Date(year,month-1,1).getDay()+6)%7);
    for(let day=1;day<=new Date(year,month,0).getDate();day++){
      const date = cursor + "-" + String(day).padStart(2,"0");
      const locked = isDateLocked(date);
      const label = draft.has(date) ? choiceLabel([...draft.get(date)]) : "未填寫";
      html += `<button type="button" class="edit-day ${draft.has(date) ? "saved" : ""} ${selected.has(date) ? "target" : ""}" data-edit-date="${date}" aria-pressed="${selected.has(date)}" aria-label="${date} ${escapeHtml(label)}${locked ? " 不開放" : ""}" ${locked ? "disabled" : ""}>${day}<small>${locked ? "🔒" : escapeHtml(label)}</small></button>`;
    }
    dialog.querySelector(".edit-days").innerHTML = html;
    dialog.querySelector("[data-selection]").textContent = "目前選取 " + selected.size + " 天";
    dialog.querySelector(".edit-preview").innerHTML = [...draft].sort(([a],[b])=>a.localeCompare(b)).map(([date,values])=>`<li>${escapeHtml(dateLabel(date))}：${escapeHtml(choiceLabel([...values]))}${isDateLocked(date) ? "（不開放，保留原紀錄）" : ""}</li>`).join("") || "<li>尚無日期</li>";
    dialog.querySelectorAll("[data-edit-date]").forEach(b=>b.onclick=()=>{
      selected.has(b.dataset.editDate) ? selected.delete(b.dataset.editDate) : selected.add(b.dataset.editDate);
      draw();
    });
    dialog.querySelectorAll("[data-period]").forEach(b=>{
      const all = selected.size > 0 && [...selected].every(d=>draft.get(d)?.has(b.dataset.period));
      b.disabled = !selected.size;
      b.classList.toggle("selected",all);
      b.setAttribute("aria-pressed",String(all));
    });
    dialog.querySelector("[data-remove]").disabled = !selected.size;
  };
  dialog.querySelectorAll("[data-month-step]").forEach(b=>b.onclick=()=>{
    const [y,m]=cursor.split("-").map(Number), next=new Date(y,m-1+Number(b.dataset.monthStep),1);
    cursor=next.getFullYear()+"-"+String(next.getMonth()+1).padStart(2,"0"); draw();
  });
  dialog.querySelectorAll("[data-period]").forEach(b=>b.onclick=()=>{
    const p=b.dataset.period, remove=[...selected].every(d=>draft.get(d)?.has(p));
    for(const date of selected){
      if(isDateLocked(date)) continue;
      const values = new Set(draft.get(date) || []);
      if(remove) values.delete(p);
      else if(p==="△" || p==="X"){values.clear();values.add(p);}
      else {values.delete("△");values.delete("X");values.add(p);}
      draft.set(date,values);
    }
    draw();
  });
  dialog.querySelector("[data-remove]").onclick=()=>{for(const d of selected) if(!isDateLocked(d)) draft.delete(d);selected.clear();draw();};
  dialog.querySelector("[data-clear]").onclick=()=>{selected.clear();draw();};
  dialog.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=()=>{if(!busy) dialog.close();});
  dialog.addEventListener("cancel",e=>{if(busy)e.preventDefault();});
  dialog.addEventListener("close",()=>dialog.remove());
  dialog.querySelector("form").onsubmit=async e=>{
    e.preventDefault();
    const error=dialog.querySelector(".edit-error");
    if(!draft.size || [...draft.values()].some(v=>!v.size)){error.textContent="請保留至少一天，並為每一天選擇時段、△ 或 X；不需要的日期請移除。";return;}
    busy=true;
    dialog.querySelectorAll("button,textarea").forEach(b=>b.disabled=true);
    const choiceObject=Object.fromEntries([...draft].sort(([a],[b])=>a.localeCompare(b)).map(([d,v])=>[d,[...PERIOD_KEYS,"△","X"].filter(p=>v.has(p))]));
    const data={playerName:player.playerName,isGM:e.currentTarget.isGM.checked,note:e.currentTarget.note.value.trim(),choices:choiceObject,batchGroups:Object.fromEntries(normalizeBatchGroups(choiceObject)),submitted:true,reconciledResponseIds:player.responseIds,reconciledAt:serverTimestamp(),updatedAt:serverTimestamp()};
    try{
      if(data.isGM && uniqueSubmittedResponses(responses).filter(r => r.isGM && !r.responseIds?.includes(uid)).length >= maxGMCount()) throw Error("GM 名額已滿，請聯絡管理者調高上限。");
      await runTransaction(db,async tx=>{
        const parent=await tx.get(doc(db,"quickSchedules",scheduleId));
        const ref=doc(db,"quickSchedules",scheduleId,"responses",uid);
        const current=await tx.get(ref);
        if(user?.uid!==uid || schedule?.id!==scheduleId || !parent.exists() || parent.data().closed) throw Error("約團已結束或頁面已切換，無法儲存。");
        if(!current.exists() || fingerprint(current.data())!==original) throw Error("紀錄已在其他視窗更新，請取消後重新開啟修改時間。");
        for(const d of Object.keys(parent.data().lockedDates || {})){
          if(JSON.stringify(current.data().choices?.[d])!==JSON.stringify(choiceObject[d])) throw Error("部分日期已被鎖定，請取消後重新開啟修改時間。");
        }
        tx.set(ref,data);
      });
      responses=responses.map(r=>r.id===uid?{...r,...data}:r);
      choices=new Map([...draft].map(([d,v])=>[d,new Set(v)]));
      batchGroups=normalizeBatchGroups(choiceObject);
      batchDates.clear();batchApplied=false;
      renderSchedule({...data,id:uid});
      dialog.close();toast("你的時間已更新");
    }catch(err){
      error.textContent=err.message || "儲存失敗，請稍後再試。";
      busy=false;dialog.querySelectorAll("button,textarea").forEach(b=>b.disabled=false);draw();
    }
  };
  draw();dialog.showModal();
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
    const mergeNotice = player.needsReconciliation
      ? `<div class="merge-review-notice"><p>已整理 ${player.mergedCount} 筆同名填寫，請確認日期與時段。</p>${isMine ? `<button class="button secondary review-merged-response" type="button" data-player-key="${escapeHtml(normalizedPlayerName(player.playerName))}">確認合併內容</button>` : ""}</div>`
      : "";
    const hasNote = Boolean(player.note?.trim());
    const noteAlert = hasNote ? `<span class="player-note-alert" title="${escapeHtml(`備註：${player.note.trim()}`)}" aria-label="這位玩家有備註">!</span>` : "";
    return `<article class="player-availability"><header><div class="player-name-line"><h3 class="${player.isGM ? "gm-name" : ""}">${escapeHtml(player.playerName)}${player.isGM ? "（GM）" : ""}</h3>${noteAlert}</div>${isMine && !schedule?.closed ? `<button type="button" class="button secondary edit-my-time">修改時間</button>` : ""}${deleteButton}</header>${mergeNotice}${hasNote ? `<p class="response-note">${escapeHtml(player.note.trim())}</p>` : ""}<div>${groupedChoices.map(group => `<span class="player-date-choice"><b>${escapeHtml(compactDateRangeLabel(group.start, group.end))}</b><i class="choice-mark ${group.isUnavailable ? "no" : ""}">${escapeHtml(group.label)}</i></span>`).join("")}</div></article>`;
  }).join("")}</div>`;
}

function bindOverviewActions() {
  document.querySelectorAll(".edit-my-time").forEach(button => button.onclick = () => {
    const player = uniqueSubmittedResponses(responses).find(p => p.responseIds?.includes(user?.uid));
    if (player) openTimeEditor(player);
  });
  document.querySelectorAll(".review-merged-response").forEach(button => button.addEventListener("click", () => {
    const player = uniqueSubmittedResponses(responses).find(item =>
      item.needsReconciliation
      && item.responseIds?.includes(user?.uid)
      && normalizedPlayerName(item.playerName) === button.dataset.playerKey
    );
    if (player) openMergeConfirmDialog(player);
  }));
  document.querySelectorAll(".delete-my-response").forEach(button => button.addEventListener("click", async event => {
    const target = event.currentTarget;
    const responseIds = (target.dataset.responseIds || "").split(",").filter(Boolean);
    const isMine = responseIds.includes(user?.uid);
    if (!user || !responseIds.length || (!isMine && !canManageSchedule)) return;
    if (schedule?.closed && !canManageSchedule) return toast("此約團已結束。");
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
  document.querySelector("#time-edit-dialog")?.close();
  unsubscribeSchedule?.();
  unsubscribeSchedule = null;
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

function applyClosedState() {
  const closed = schedule?.closed === true;
  const status = document.querySelector("#schedule-status");
  if (status) status.textContent = closed ? "此約團已結束，填表已關閉；結果仍可查看與匯出。" : "";
  if (!closed) return;
  document.querySelector("#time-edit-dialog")?.close();
  document.querySelector("#merge-confirm-dialog")?.close();
  document.querySelectorAll("#response-form input, #response-form textarea, #response-form button, .review-merged-response").forEach(node => { node.disabled = true; });
  if (!canManageSchedule) document.querySelectorAll(".delete-my-response").forEach(node => { node.disabled = true; });
  const button = document.querySelector("#close-schedule");
  if (button) { button.disabled = true; button.textContent = "約團已結束"; }
  if (button && canManageSchedule && routeInfo().token && !document.querySelector("#delete-ended-schedule")) {
    const deleteButton = document.createElement("button");
    deleteButton.id = "delete-ended-schedule";
    deleteButton.type = "button";
    deleteButton.className = "button reject";
    deleteButton.textContent = "刪除約團表";
    deleteButton.addEventListener("click", () => {
      if (!schedule?.closed || !canManageSchedule || !routeInfo().token) return;
      deleteQuickSchedule(schedule.id, schedule.title, deleteButton);
    });
    button.insertAdjacentElement("afterend", deleteButton);
  }
}

async function saveOpenResponse(data) {
  const id = schedule.id;
  if (typeof data.isGM !== "boolean") data.isGM = responses.find(r => r.id === user?.uid)?.isGM === true;
  if (data.isGM && uniqueSubmittedResponses(responses).filter(r => r.isGM && !r.responseIds?.includes(user?.uid)).length >= maxGMCount()) throw Error("GM 名額已滿，請聯絡管理者調高上限。");
  await runTransaction(db, async transaction => {
    const current = await transaction.get(doc(db, "quickSchedules", id));
    if (!current.exists() || current.data().closed === true) throw new Error("約團已結束，無法儲存");
    transaction.set(doc(db, "quickSchedules", id, "responses", user.uid), data);
  });
}

async function closeSchedule(event) {
  if (!canManageSchedule || !routeInfo().token || schedule.closed) return;
  if (!window.confirm("確定結束這張約團表？結束後玩家無法新增、修改或刪除填寫，原有結果會保留並可匯出。")) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await updateDoc(doc(db, "quickSchedules", schedule.id), { closed: true, closedAt: serverTimestamp() });
    schedule.closed = true;
    applyClosedState();
    toast("約團已結束，結果已保留。");
  } catch (error) {
    console.error(error);
    button.disabled = false;
    toast("結束約團失敗，請確認管理權限後重試。");
  }
}

function scheduleResultsText() {
  const players = uniqueSubmittedResponses(responses);
  const lines = [schedule.title || "約團結果",
    "建立者：" + (schedule.coordinatorName || ""),
    "狀態：" + (schedule.closed ? "已結束" : "填表中"),
    playerRangeLabel(), "",
    "時段：" + PERIOD_KEYS.map(p => p + " " + (schedule.periods?.[p] || "")).join("／"),
    "GM 不計入玩家人數；須 GM 有空且玩家達門檻才能成團。△ 不確定與不開放日期不計入成團。", gmStatusText(players), "", "【可成團時段】"];
  const slots = bestSlots(players);
  if (!slots.length) lines.push("目前沒有達到最低成團人數的時段。");
  for (const slot of slots) lines.push(dateLabel(slot.date, true) + "・" + slot.period + "（" + slot.count + " 位玩家＋GM：" + slot.availableGMs.map(gm => gm.playerName).join("、") + "）：" + slot.players.map(p => p.playerName).join("、"));
  lines.push("", "【玩家填寫結果】");
  for (const player of players) {
    lines.push(player.playerName + (player.isGM ? "（GM，不計入玩家人數）" : "") + (player.needsReconciliation ? "（同名合併待確認）" : ""));
    for (const group of groupedPlayerChoices(player.choices, player.batchGroups)) lines.push("  " + compactDateRangeLabel(group.start, group.end) + "：" + group.label);
    if (player.note) lines.push("  備註：" + player.note);
    lines.push("");
  }
  return lines.join("\n");
}

function exportScheduleResults() {
  const blob = new Blob(["\uFEFF", scheduleResultsText()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = (schedule.title || "約團").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0,80) + "-約團結果.txt";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
