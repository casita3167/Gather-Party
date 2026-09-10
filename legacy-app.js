import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { addDoc, collection, deleteDoc, doc, getDoc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const DAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
let auth;
let db;
let user;
let currentEvent = null;
let availability = [];
let draftSlots = [];
let unsubscribe = null;
let editorInitialized = false;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 1800);
}

function isConfigured() {
  return firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("PASTE_") && firebaseConfig.projectId && !firebaseConfig.projectId.includes("PASTE_");
}

function setupScreen() {
  root.innerHTML = `<main class="card setup-card"><div class="brandmark" aria-hidden="true">⚄</div><h1>還差 Firebase 設定</h1><p>網頁檔案已經可以使用，但還需要連上你的 Firebase 專案，才能讓不同玩家共同填寫。</p><ol><li>依照 <code>README.md</code> 建立 Firebase 專案。</li><li>把網頁設定貼進 <code>firebase-config.js</code>。</li><li>重新上傳 GitHub 後再開啟這個頁面。</li></ol><p><a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">前往 Firebase Console</a></p></main>`;
}

function brandBar(withShare = false) {
  return `<header class="brandbar"><a class="brand" href="./#"><span class="brandmark" aria-hidden="true">⚄</span><span>約團時間表<small>點此回到 Gather Party 首頁</small></span></a>${withShare ? '<button class="button secondary" id="copy-link" type="button">複製分享連結</button>' : ""}</header>`;
}

function newSlot(kind) {
  return kind === "weekly" ? { weekday: 5, time: "19:00" } : { date: "", time: "19:00" };
}

function normalizeSlot(slot, kind) {
  if (kind === "weekly") return { weekday: Number(slot.weekday ?? 5), time: slot.time || slot.startTime || "19:00" };
  return { date: slot.date || slot.start?.slice(0, 10) || "", time: slot.time || slot.start?.slice(11, 16) || "19:00" };
}

function normalizeTimeValue(value, final = false) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 4);
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  if (final && digits.length === 3) return `0${digits[0]}:${digits.slice(1)}`;
  if (final && digits.length > 0 && digits.length <= 2 && Number(digits) <= 23) return `${digits.padStart(2, "0")}:00`;
  return digits;
}

function handleTimeTyping(event) {
  event.currentTarget.value = normalizeTimeValue(event.currentTarget.value);
  syncDraftInputs();
}

function finishTimeTyping(event) {
  event.currentTarget.value = normalizeTimeValue(event.currentTarget.value, true);
  syncDraftInputs();
}

function renderHome() {
  currentEvent = null;
  availability = [];
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  root.innerHTML = `<main class="shell">${brandBar()}<div class="home-grid">
    <section class="intro"><span class="eyebrow">◷ 幾分鐘內決定開團時間</span><h1>把大家有空的時間，<span>收在同一張表。</span></h1><p>建立團務後分享連結，玩家只要填暱稱與可行時間。月曆會將相同時間的玩家排在一起。</p><div class="feature-row"><div class="mini-card"><b>單次約團</b><span>適合短團、單次聚會與臨時團</span></div><div class="mini-card"><b>每週固定</b><span>適合長團與固定週期的團務</span></div></div></section>
    <form class="card create-card" id="create-form"><h2 class="card-title">建立新的約團表</h2><p class="card-sub">建立後就會取得可分享的專屬連結</p>
      <div class="field"><label for="event-title">團務名稱</label><input id="event-title" name="title" maxlength="60" required placeholder="例如：團務 一"></div>
      <div class="field"><span class="field-label">安排方式</span><div class="segment"><input id="kind-single" type="radio" name="kind" value="single" checked><label for="kind-single">單次約團</label><input id="kind-weekly" type="radio" name="kind" value="weekly"><label for="kind-weekly">每週固定</label></div><p class="helper" id="kind-help">玩家填寫日期與一個可行時間。</p></div>
      <div class="field"><label for="min-players">成團人數</label><input id="min-players" name="minPlayers" type="number" min="2" max="20" value="4" required><p class="helper">同一時間達到這個人數，就會列入「可以跑團的時間」。</p></div>
      <div class="field"><label for="event-note">補充說明 <span>（選填）</span></label><textarea id="event-note" name="note" maxlength="300" placeholder="例如：每次預計進行 4～5 小時"></textarea></div>
      <p class="message error" id="create-error"></p><button class="button full" type="submit">建立約團表</button>
    </form></div></main>`;
  const form = document.querySelector("#create-form");
  form.addEventListener("change", event => {
    if (event.target.name === "kind") document.querySelector("#kind-help").textContent = event.target.value === "single" ? "玩家填寫日期與一個可行時間。" : "玩家填寫每週固定有空的星期與時間。";
  });
  form.addEventListener("submit", createEvent);
}

async function createEvent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const error = document.querySelector("#create-error");
  const title = form.elements.title.value.trim();
  const note = form.elements.note.value.trim();
  const kind = form.elements.kind.value;
  const minPlayers = Number(form.elements.minPlayers.value);
  if (!title) return showMessage(error, "請先輸入團務名稱");
  if (!Number.isInteger(minPlayers) || minPlayers < 2 || minPlayers > 20) return showMessage(error, "成團人數請填 2～20 人");
  button.disabled = true;
  button.textContent = "建立中⋯";
  error.classList.remove("show");
  try {
    const ref = await addDoc(collection(db, "events"), { title, note, kind, minPlayers, ownerUid: user.uid, createdAt: serverTimestamp() });
    location.hash = `event=${ref.id}`;
  } catch (err) {
    console.error(err);
    showMessage(error, "建立失敗，請確認 Firebase 設定與資料庫規則。");
    button.disabled = false;
    button.textContent = "建立約團表";
  }
}

function showMessage(node, message, type = "error") {
  node.textContent = message;
  node.className = `message ${type} show`;
}

function eventIdFromHash() {
  const match = location.hash.match(/^#event=([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

async function openEvent(eventId) {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  currentEvent = null;
  availability = [];
  editorInitialized = false;
  root.innerHTML = '<main class="loading-screen"><div class="spinner"></div><p>正在讀取約團表⋯</p></main>';
  try {
    const snapshot = await getDoc(doc(db, "events", eventId));
    if (!snapshot.exists()) return notFound("找不到這張約團表，可能已被刪除或連結不完整。");
    currentEvent = { id: snapshot.id, ...snapshot.data() };
    if (!["single", "weekly"].includes(currentEvent.kind)) return notFound("這張約團表的格式無法辨識。");
    currentEvent.minPlayers = Number.isInteger(currentEvent.minPlayers) && currentEvent.minPlayers >= 2 && currentEvent.minPlayers <= 20 ? currentEvent.minPlayers : 4;
    draftSlots = [newSlot(currentEvent.kind)];
    calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderEventShell();
    unsubscribe = onSnapshot(collection(db, "events", eventId, "availability"), result => {
      availability = result.docs.map(item => ({ id: item.id, ...item.data() }));
      const mine = availability.find(item => item.id === user.uid);
      if (!editorInitialized) {
        if (mine?.slots?.length) {
          draftSlots = mine.slots.map(slot => normalizeSlot(slot, currentEvent.kind));
          document.querySelector("#player-name").value = mine.name;
          if (currentEvent.kind === "single" && draftSlots[0].date) {
            const [year, month] = draftSlots[0].date.split("-").map(Number);
            calendarCursor = new Date(year, month - 1, 1);
          }
        }
        editorInitialized = true;
        renderEditor();
      }
      renderCalendar();
    }, err => {
      console.error(err);
      const node = document.querySelector("#load-error");
      if (node) showMessage(node, "無法同步資料，請確認 Firestore 規則是否已發布。");
    });
  } catch (err) {
    console.error(err);
    notFound("暫時無法讀取約團表，請稍後再試。");
  }
}

function notFound(message) {
  root.innerHTML = `<main class="card setup-card"><div class="brandmark" aria-hidden="true">⚄</div><h1>${escapeHtml(message)}</h1><p>你可以回到首頁建立一張新的約團表。</p><a class="button" href="#">回到首頁</a></main>`;
}

function renderEventShell() {
  root.innerHTML = `<main class="shell">${brandBar(true)}
    <section class="event-head"><div class="event-head-row"><div><span class="pill">${currentEvent.kind === "single" ? "單次約團" : "每週固定"}</span><span class="pill">滿 ${currentEvent.minPlayers} 人成團</span><h1>${escapeHtml(currentEvent.title)}</h1>${currentEvent.note ? `<p>${escapeHtml(currentEvent.note)}</p>` : ""}</div><div class="count-box"><b id="people-count">0</b><span>人已填寫</span></div></div></section>
    <div class="event-grid calendar-layout"><section class="panel calendar-panel"><div class="calendar-toolbar"><div><h2>團務月曆</h2><p>早／中／晚標籤移上去可查看實際時間；自己的時間可按 × 刪除</p></div><div class="calendar-nav"><button class="button secondary compact" id="previous-month" type="button" aria-label="上一個月">‹</button><button class="button secondary compact today-button" id="today-month" type="button">今天</button><button class="button secondary compact" id="next-month" type="button" aria-label="下一個月">›</button></div></div><h3 class="month-title" id="month-title"></h3><div class="calendar-scroll"><div class="calendar" id="calendar"></div></div><section class="ready-summary" id="ready-summary"></section></section>
      <form class="panel sticky" id="availability-form"><div class="panel-heading"><div><h2>填寫我的時間</h2><p>每筆資料填寫一個可行時間</p></div></div><div class="field"><label for="player-name">你的暱稱</label><input id="player-name" maxlength="24" required placeholder="例如：小明" value="${escapeHtml(localStorage.getItem("trpg-scheduler-name") || "")}"></div><div class="slot-editor" id="slot-editor"></div><button class="button dashed" id="add-slot" type="button">＋ 再加一個時間</button><p class="message" id="save-message"></p><p class="message error" id="load-error"></p><button class="button full" type="submit">儲存我的時間</button></form>
    </div><p class="footer-note">知道完整分享連結的人可以看到團務名稱、暱稱與時間，請避免填寫私密內容。</p></main>`;
  document.querySelector("#copy-link").addEventListener("click", copyLink);
  document.querySelector("#availability-form").addEventListener("submit", saveAvailability);
  document.querySelector("#add-slot").addEventListener("click", () => {
    if (draftSlots.length >= 30) return toast("最多可以加入 30 個時間");
    syncDraftInputs();
    draftSlots.push(newSlot(currentEvent.kind));
    renderEditor();
  });
  document.querySelector("#previous-month").addEventListener("click", () => changeMonth(-1));
  document.querySelector("#next-month").addEventListener("click", () => changeMonth(1));
  document.querySelector("#today-month").addEventListener("click", () => {
    calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderCalendar();
  });
  renderEditor();
  renderCalendar();
}

function renderEditor() {
  const editor = document.querySelector("#slot-editor");
  if (!editor) return;
  editor.innerHTML = draftSlots.length ? draftSlots.map((slot, index) => `<div class="slot-row" data-index="${index}"><div class="slot-row-head"><span>可行時間 ${index + 1}</span><button class="icon-button remove-slot" type="button" aria-label="刪除時間 ${index + 1}" data-index="${index}">×</button></div>
    ${currentEvent.kind === "single" ? `<div class="slot-fields"><label>日期<input type="date" data-key="date" value="${escapeHtml(slot.date || "")}" required></label><label>時間<input type="text" inputmode="numeric" maxlength="5" placeholder="2000" data-key="time" value="${escapeHtml(slot.time || "")}" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|[0-9]{1,4}" required></label></div>` : `<div class="slot-fields"><label>星期<select data-key="weekday">${DAYS.map((day, dayIndex) => `<option value="${dayIndex}" ${Number(slot.weekday) === dayIndex ? "selected" : ""}>${day}</option>`).join("")}</select></label><label>時間<input type="text" inputmode="numeric" maxlength="5" placeholder="2000" data-key="time" value="${escapeHtml(slot.time || "")}" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|[0-9]{1,4}" required></label></div>`}
    <p class="time-hint">可直接輸入 4 位數字，例如 2000 會變成 20:00</p></div>`).join("") : `<p class="empty-editor">目前沒有時間。按下儲存即可刪除你的全部時間資料。</p>`;
  const submitButton = document.querySelector('#availability-form button[type="submit"]');
  if (submitButton) submitButton.textContent = draftSlots.length ? "儲存我的時間" : "刪除所有時間";
  editor.querySelectorAll("input, select").forEach(input => input.addEventListener("change", syncDraftInputs));
  editor.querySelectorAll('[data-key="time"]').forEach(input => {
    input.addEventListener("input", handleTimeTyping);
    input.addEventListener("blur", finishTimeTyping);
  });
  editor.querySelectorAll(".remove-slot").forEach(button => button.addEventListener("click", () => {
    syncDraftInputs();
    draftSlots.splice(Number(button.dataset.index), 1);
    renderEditor();
  }));
}

function syncDraftInputs() {
  document.querySelectorAll(".slot-row").forEach(row => {
    const index = Number(row.dataset.index);
    row.querySelectorAll("input, select").forEach(input => {
      draftSlots[index][input.dataset.key] = input.dataset.key === "weekday" ? Number(input.value) : input.value;
    });
  });
}

async function saveAvailability(event) {
  event.preventDefault();
  syncDraftInputs();
  draftSlots = draftSlots.map(slot => ({ ...slot, time: normalizeTimeValue(slot.time, true) }));
  const name = document.querySelector("#player-name").value.trim();
  const message = document.querySelector("#save-message");
  const button = event.currentTarget.querySelector("button[type=submit]");
  if (!name) return showMessage(message, "請輸入你的暱稱");
  const invalid = draftSlots.some(slot => (currentEvent.kind === "single" && !slot.date) || !TIME_PATTERN.test(slot.time || ""));
  if (invalid) return showMessage(message, "請確認日期，並以 HH:mm 格式輸入時間，例如 19:30。");
  button.disabled = true;
  button.textContent = "儲存中⋯";
  message.classList.remove("show");
  try {
    const availabilityRef = doc(db, "events", currentEvent.id, "availability", user.uid);
    if (draftSlots.length === 0) {
      await deleteDoc(availabilityRef);
      availability = availability.filter(item => item.id !== user.uid);
      showMessage(message, "已刪除你的所有時間。", "success");
      renderCalendar();
      return;
    }
    await setDoc(availabilityRef, { name, slots: draftSlots, updatedAt: serverTimestamp() });
    localStorage.setItem("trpg-scheduler-name", name);
    if (currentEvent.kind === "single" && draftSlots[0].date) {
      const [year, month] = draftSlots[0].date.split("-").map(Number);
      calendarCursor = new Date(year, month - 1, 1);
    }
    showMessage(message, "已儲存！這台裝置之後仍可回來修改。", "success");
    renderCalendar();
  } catch (err) {
    console.error(err);
    showMessage(message, "儲存失敗，請確認 Firebase 設定與資料庫規則。");
  } finally {
    button.disabled = false;
    button.textContent = draftSlots.length ? "儲存我的時間" : "刪除所有時間";
  }
}

function changeMonth(amount) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + amount, 1);
  renderCalendar();
}

function renderCalendar() {
  const calendar = document.querySelector("#calendar");
  const title = document.querySelector("#month-title");
  const count = document.querySelector("#people-count");
  if (!calendar || !title || !count) return;
  count.textContent = availability.length;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  title.textContent = `${year} 年 ${month + 1} 月`;
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const totalDays = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  const cells = [];
  for (let blank = 0; blank < firstWeekday; blank++) cells.push('<div class="calendar-day outside" aria-hidden="true"></div>');
  for (let day = 1; day <= totalDays; day++) {
    const key = dateKey(year, month, day);
    const weekday = (new Date(year, month, day).getDay() + 6) % 7;
    const groups = entriesForDate(key, weekday);
    cells.push(`<section class="calendar-day ${key === todayKey ? "is-today" : ""}"><div class="day-number">${day}</div><div class="day-entries">${groups.map(group => calendarEntry(group, key, weekday)).join("")}</div></section>`);
  }
  const remainder = (7 - (cells.length % 7)) % 7;
  for (let blank = 0; blank < remainder; blank++) cells.push('<div class="calendar-day outside" aria-hidden="true"></div>');
  calendar.innerHTML = `<div class="weekday">一</div><div class="weekday">二</div><div class="weekday">三</div><div class="weekday">四</div><div class="weekday">五</div><div class="weekday weekend">六</div><div class="weekday weekend">日</div>${cells.join("")}`;
  calendar.querySelectorAll(".calendar-delete").forEach(button => button.addEventListener("click", deleteSavedSlot));
  renderReadySummary();
}

function entriesForDate(key, weekday) {
  const grouped = new Map();
  availability.forEach(person => (person.slots || []).forEach(raw => {
    const slot = normalizeSlot(raw, currentEvent.kind);
    const matches = currentEvent.kind === "weekly" ? slot.weekday === weekday : slot.date === key;
    if (!matches || !TIME_PATTERN.test(slot.time || "")) return;
    const people = grouped.get(slot.time) || [];
    if (!people.some(entry => entry.id === person.id)) people.push({ id: person.id, name: person.name });
    grouped.set(slot.time, people);
  }));
  return [...grouped.entries()].sort(([timeA], [timeB]) => timeA.localeCompare(timeB)).map(([time, people]) => ({ time, people }));
}

function calendarEntry(group, key, weekday) {
  const period = periodFor(group.time);
  const people = group.people.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")).map(person => {
    const hue = colorHue(person.id || person.name);
    const initial = [...String(person.name || "?")][0];
    const remove = person.id === user.uid ? `<button class="calendar-delete" type="button" data-date="${key}" data-weekday="${weekday}" data-time="${escapeHtml(group.time)}" aria-label="刪除 ${escapeHtml(person.name)} 的 ${escapeHtml(group.time)} 時間" title="刪除這個時間">×</button>` : "";
    return `<span class="calendar-person"><span class="user-token" style="--token-hue:${hue}" aria-hidden="true">${escapeHtml(initial)}</span><span class="calendar-name">${escapeHtml(person.name)}</span>${remove}</span>`;
  }).join("");
  return `<div class="calendar-entry"><div class="calendar-people">${people}</div><span class="period-tag period-${period.key}" data-time="${escapeHtml(group.time)}" tabindex="0" aria-label="${period.full}，${escapeHtml(group.time)}">${period.short}</span></div>`;
}

async function deleteSavedSlot(event) {
  const button = event.currentTarget;
  const mine = availability.find(item => item.id === user.uid);
  if (!mine?.slots?.length) return;
  const targetTime = button.dataset.time;
  const targetDate = button.dataset.date;
  const targetWeekday = Number(button.dataset.weekday);
  const remaining = mine.slots.map(slot => normalizeSlot(slot, currentEvent.kind)).filter(slot => {
    if (slot.time !== targetTime) return true;
    return currentEvent.kind === "weekly" ? slot.weekday !== targetWeekday : slot.date !== targetDate;
  });
  if (remaining.length === mine.slots.length) return;
  const label = currentEvent.kind === "weekly" ? `${DAYS[targetWeekday]} ${targetTime}` : `${formatDateLabel(targetDate)} ${targetTime}`;
  if (!window.confirm(`確定要刪除 ${label} 嗎？`)) return;
  button.disabled = true;
  try {
    const availabilityRef = doc(db, "events", currentEvent.id, "availability", user.uid);
    if (remaining.length) {
      await setDoc(availabilityRef, { name: mine.name, slots: remaining, updatedAt: serverTimestamp() });
      availability = availability.map(item => item.id === user.uid ? { ...item, slots: remaining } : item);
    } else {
      await deleteDoc(availabilityRef);
      availability = availability.filter(item => item.id !== user.uid);
    }
    draftSlots = remaining;
    renderEditor();
    renderCalendar();
    showMessage(document.querySelector("#save-message"), `已刪除 ${label}。`, "success");
  } catch (err) {
    console.error(err);
    button.disabled = false;
    showMessage(document.querySelector("#save-message"), "刪除失敗，請確認 Firebase 規則已更新。");
  }
}

function groupedSchedule() {
  const grouped = new Map();
  availability.forEach(person => (person.slots || []).forEach(raw => {
    const slot = normalizeSlot(raw, currentEvent.kind);
    if (!TIME_PATTERN.test(slot.time || "")) return;
    const scheduleKey = currentEvent.kind === "weekly" ? `${slot.weekday}|${slot.time}` : `${slot.date}|${slot.time}`;
    const item = grouped.get(scheduleKey) || { ...slot, people: [] };
    if (!item.people.some(entry => entry.id === person.id)) item.people.push({ id: person.id, name: person.name });
    grouped.set(scheduleKey, item);
  }));
  return [...grouped.values()].sort((a, b) => {
    const keyA = currentEvent.kind === "weekly" ? `${a.weekday}-${a.time}` : `${a.date}-${a.time}`;
    const keyB = currentEvent.kind === "weekly" ? `${b.weekday}-${b.time}` : `${b.date}-${b.time}`;
    return keyA.localeCompare(keyB);
  });
}

function readySchedule() {
  return groupedSchedule().filter(item => item.people.length >= currentEvent.minPlayers);
}

function formatDateLabel(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return value;
  const weekday = (new Date(year, month - 1, day).getDay() + 6) % 7;
  return `${year} 年 ${month} 月 ${day} 日（${DAYS[weekday]}）`;
}

function readyScheduleText(items = readySchedule()) {
  return items.map(item => {
    const when = currentEvent.kind === "weekly" ? `每${DAYS[item.weekday]}` : formatDateLabel(item.date);
    const names = item.people.map(person => person.name).sort((a, b) => a.localeCompare(b, "zh-Hant")).join("、");
    return `${when} ${item.time} 可以跑團（${item.people.length} 人：${names}）`;
  }).join("\n");
}

function renderReadySummary() {
  const summary = document.querySelector("#ready-summary");
  if (!summary) return;
  const items = readySchedule();
  summary.innerHTML = `<div class="ready-summary-head"><div><h3>可以跑團的時間</h3><p>同一時間滿 ${currentEvent.minPlayers} 人會自動列在這裡。</p></div>${items.length ? '<button class="button secondary" id="copy-ready" type="button">複製文字</button>' : ""}</div>${items.length ? `<div class="ready-list">${items.map(item => {
    const when = currentEvent.kind === "weekly" ? `每${DAYS[item.weekday]}` : formatDateLabel(item.date);
    const names = item.people.map(person => person.name).sort((a, b) => a.localeCompare(b, "zh-Hant")).join("、");
    return `<div class="ready-item"><b>${escapeHtml(when)}　${escapeHtml(item.time)}</b><span>${item.people.length} 人：${escapeHtml(names)}</span></div>`;
  }).join("")}</div>` : `<p class="ready-empty">目前還沒有滿 ${currentEvent.minPlayers} 人的共同時間。</p>`}`;
  document.querySelector("#copy-ready")?.addEventListener("click", async () => {
    const text = readyScheduleText(items);
    try {
      await navigator.clipboard.writeText(text);
      toast("可跑團時間已複製");
    } catch {
      window.prompt("請複製以下文字", text);
    }
  });
}

function periodFor(time) {
  const hour = Number(time.slice(0, 2));
  if (hour < 12) return { key: "morning", short: "早", full: "早上" };
  if (hour < 18) return { key: "afternoon", short: "中", full: "中午" };
  return { key: "evening", short: "晚", full: "晚上" };
}

function colorHue(value) {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}

function dateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("分享連結已複製");
  } catch {
    window.prompt("請複製以下連結", location.href);
  }
}

async function route() {
  if (!user) return;
  const eventId = eventIdFromHash();
  if (eventId) await openEvent(eventId);
  else renderHome();
}

async function start() {
  if (!isConfigured()) return setupScreen();
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    onAuthStateChanged(auth, async current => {
      if (!current) return signInAnonymously(auth);
      user = current;
      await route();
    });
  } catch (err) {
    console.error(err);
    setupScreen();
  }
}

window.addEventListener("hashchange", route);
start();
