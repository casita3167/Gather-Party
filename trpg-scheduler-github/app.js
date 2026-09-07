import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  addDoc, collection, doc, getDoc, getFirestore, onSnapshot, serverTimestamp, setDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const DAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
let auth;
let db;
let user;
let currentEvent = null;
let availability = [];
let draftSlots = [];
let unsubscribe = null;
let editorInitialized = false;

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
  root.innerHTML = `
    <main class="card setup-card">
      <div class="brandmark" aria-hidden="true">⚄</div>
      <h1>還差 Firebase 設定</h1>
      <p>網頁檔案已經可以使用，但還需要連上你的 Firebase 專案，才能讓不同玩家共同填寫。</p>
      <ol>
        <li>依照 <code>README.md</code> 建立 Firebase 專案。</li>
        <li>把網頁設定貼進 <code>firebase-config.js</code>。</li>
        <li>重新上傳 GitHub 後再開啟這個頁面。</li>
      </ol>
      <p><a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">前往 Firebase Console</a></p>
    </main>`;
}

function brandBar(withShare = false) {
  return `<header class="brandbar">
    <a class="brand" href="#"><span class="brandmark" aria-hidden="true">⚄</span><span>約團時間表<small>不用註冊，貼連結就能一起填</small></span></a>
    ${withShare ? '<button class="button secondary" id="copy-link" type="button">複製分享連結</button>' : ""}
  </header>`;
}

function newSlot(kind) {
  return kind === "weekly"
    ? { weekday: 5, startTime: "19:00", endTime: "23:00" }
    : { start: "", end: "" };
}

function renderHome() {
  currentEvent = null;
  availability = [];
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  root.innerHTML = `<main class="shell">
    ${brandBar()}
    <div class="home-grid">
      <section class="intro">
        <span class="eyebrow">◷ 幾分鐘內決定開團時間</span>
        <h1>把大家有空的時間，<span>收在同一張表。</span></h1>
        <p>建立團務後分享連結，玩家只要填暱稱與可行時段。系統會自動找出重疊最多的時間。</p>
        <div class="feature-row">
          <div class="mini-card"><b>單次約團</b><span>適合短團、單次聚會與臨時團</span></div>
          <div class="mini-card"><b>每週固定</b><span>適合長團與固定週期的團務</span></div>
        </div>
      </section>
      <form class="card create-card" id="create-form">
        <h2 class="card-title">建立新的約團表</h2>
        <p class="card-sub">建立後就會取得可分享的專屬連結</p>
        <div class="field"><label for="event-title">團務名稱</label><input id="event-title" name="title" maxlength="60" required placeholder="例如：寂靜之音・第三章"></div>
        <div class="field"><span class="field-label">安排方式</span>
          <div class="segment">
            <input id="kind-single" type="radio" name="kind" value="single" checked><label for="kind-single">單次約團</label>
            <input id="kind-weekly" type="radio" name="kind" value="weekly"><label for="kind-weekly">每週固定</label>
          </div>
          <p class="helper" id="kind-help">玩家填寫實際日期與時間。</p>
        </div>
        <div class="field"><label for="event-note">補充說明 <span>（選填）</span></label><textarea id="event-note" name="note" maxlength="300" placeholder="例如：預計跑 4～5 小時，希望最晚 20:00 開始"></textarea></div>
        <p class="message error" id="create-error"></p>
        <button class="button full" type="submit">建立約團表</button>
      </form>
    </div>
  </main>`;

  const form = document.querySelector("#create-form");
  form.addEventListener("change", event => {
    if (event.target.name === "kind") document.querySelector("#kind-help").textContent = event.target.value === "single" ? "玩家填寫實際日期與時間。" : "玩家填寫每週固定有空的星期與時間。";
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
  if (!title) return showMessage(error, "請先輸入團務名稱");
  button.disabled = true;
  button.textContent = "建立中⋯";
  error.classList.remove("show");
  try {
    const ref = await addDoc(collection(db, "events"), { title, note, kind, ownerUid: user.uid, createdAt: serverTimestamp() });
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
    const eventRef = doc(db, "events", eventId);
    const snapshot = await getDoc(eventRef);
    if (!snapshot.exists()) return notFound("找不到這張約團表，可能已被刪除或連結不完整。");
    currentEvent = { id: snapshot.id, ...snapshot.data() };
    if (!["single", "weekly"].includes(currentEvent.kind)) return notFound("這張約團表的格式無法辨識。");
    draftSlots = [newSlot(currentEvent.kind)];
    renderEventShell();
    unsubscribe = onSnapshot(collection(db, "events", eventId, "availability"), result => {
      availability = result.docs.map(item => ({ id: item.id, ...item.data() }));
      const mine = availability.find(item => item.id === user.uid);
      if (!editorInitialized) {
        if (mine?.slots?.length) {
          draftSlots = mine.slots.map(slot => ({ ...slot }));
          document.querySelector("#player-name").value = mine.name;
        }
        editorInitialized = true;
        renderEditor();
      }
      renderSummary();
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
  root.innerHTML = `<main class="shell">
    ${brandBar(true)}
    <section class="event-head"><div class="event-head-row"><div><span class="pill">${currentEvent.kind === "single" ? "單次約團" : "每週固定"}</span><h1>${escapeHtml(currentEvent.title)}</h1>${currentEvent.note ? `<p>${escapeHtml(currentEvent.note)}</p>` : ""}</div><div class="count-box"><b id="people-count">0</b><span>人已填寫</span></div></div></section>
    <div class="event-grid">
      <div>
        <section class="panel"><div class="panel-heading"><div><h2>推薦時段</h2><p>依可出席人數排序</p></div></div><div id="suggestions"></div></section>
        <section class="panel"><div class="panel-heading"><div><h2>大家填的時間</h2></div></div><div id="people"></div></section>
      </div>
      <form class="panel sticky" id="availability-form">
        <div class="panel-heading"><div><h2>填寫我的時間</h2><p>你可以回來修改自己填過的資料</p></div></div>
        <div class="field"><label for="player-name">你的暱稱</label><input id="player-name" maxlength="24" required placeholder="例如：點心" value="${escapeHtml(localStorage.getItem("trpg-scheduler-name") || "")}"></div>
        <div class="slot-editor" id="slot-editor"></div>
        <button class="button dashed" id="add-slot" type="button">＋ 再加一個時段</button>
        <p class="message" id="save-message"></p><p class="message error" id="load-error"></p>
        <button class="button full" type="submit">儲存我的時間</button>
      </form>
    </div>
    <p class="footer-note">約團資料僅能透過完整分享連結開啟，請留意不要公開張貼包含私人行程的內容。</p>
  </main>`;
  document.querySelector("#copy-link").addEventListener("click", copyLink);
  document.querySelector("#availability-form").addEventListener("submit", saveAvailability);
  document.querySelector("#add-slot").addEventListener("click", () => {
    if (draftSlots.length >= 30) return toast("最多可以加入 30 個時段");
    syncDraftInputs();
    draftSlots.push(newSlot(currentEvent.kind));
    renderEditor();
  });
  renderEditor();
  renderSummary();
}

function renderEditor() {
  const editor = document.querySelector("#slot-editor");
  if (!editor) return;
  editor.innerHTML = draftSlots.map((slot, index) => `<div class="slot-row" data-index="${index}">
    <div class="slot-row-head"><span>可行時段 ${index + 1}</span>${draftSlots.length > 1 ? `<button class="icon-button remove-slot" type="button" aria-label="刪除時段 ${index + 1}" data-index="${index}">×</button>` : ""}</div>
    ${currentEvent.kind === "single" ? `<div class="slot-fields"><label>開始<input type="datetime-local" data-key="start" value="${escapeHtml(slot.start || "")}" required></label><label>結束<input type="datetime-local" data-key="end" value="${escapeHtml(slot.end || "")}" required></label></div>` : `<div class="slot-fields weekly"><label>星期<select data-key="weekday">${DAYS.map((day, dayIndex) => `<option value="${dayIndex}" ${Number(slot.weekday) === dayIndex ? "selected" : ""}>${day}</option>`).join("")}</select></label><label>開始<input type="time" data-key="startTime" value="${escapeHtml(slot.startTime || "19:00")}" required></label><label>結束<input type="time" data-key="endTime" value="${escapeHtml(slot.endTime || "23:00")}" required></label></div>`}
  </div>`).join("");
  editor.querySelectorAll("input, select").forEach(input => input.addEventListener("change", syncDraftInputs));
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
  const name = document.querySelector("#player-name").value.trim();
  const message = document.querySelector("#save-message");
  const button = event.currentTarget.querySelector("button[type=submit]");
  if (!name) return showMessage(message, "請輸入你的暱稱");
  const invalid = currentEvent.kind === "single"
    ? draftSlots.some(slot => !slot.start || !slot.end || slot.end <= slot.start)
    : draftSlots.some(slot => !slot.startTime || !slot.endTime || slot.endTime <= slot.startTime);
  if (invalid) return showMessage(message, "請確認每個時段的開始與結束時間");
  button.disabled = true;
  button.textContent = "儲存中⋯";
  message.classList.remove("show");
  try {
    await setDoc(doc(db, "events", currentEvent.id, "availability", user.uid), { name, slots: draftSlots, updatedAt: serverTimestamp() });
    localStorage.setItem("trpg-scheduler-name", name);
    showMessage(message, "已儲存！這台裝置之後仍可回來修改。", "success");
  } catch (err) {
    console.error(err);
    showMessage(message, "儲存失敗，請確認 Firebase 設定與資料庫規則。");
  } finally {
    button.disabled = false;
    button.textContent = "儲存我的時間";
  }
}

function renderSummary() {
  const count = document.querySelector("#people-count");
  const suggestionsNode = document.querySelector("#suggestions");
  const peopleNode = document.querySelector("#people");
  if (!count || !suggestionsNode || !peopleNode) return;
  count.textContent = availability.length;
  const suggestions = calculateSuggestions();
  suggestionsNode.innerHTML = suggestions.length ? `<div class="suggestions">${suggestions.map((item, index) => `<div class="suggestion ${index === 0 ? "best" : ""}"><span class="number">${item.people.length}</span><div class="suggestion-main"><b>${escapeHtml(formatSuggestion(item))}</b><span>${escapeHtml(item.people.join("、"))}</span></div>${index === 0 ? '<span class="best-tag">最多人</span>' : ""}</div>`).join("")}</div>` : '<div class="empty">還沒有人填寫時段</div>';
  peopleNode.innerHTML = availability.length ? `<div class="people-list">${availability.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")).map(person => `<div class="person"><div class="person-head"><span class="person-name">♙ ${escapeHtml(person.name)}${person.id === user.uid ? ' <span class="best-tag">我</span>' : ""}</span></div><div class="slot-tags">${(person.slots || []).map(slot => `<span class="slot-tag">${escapeHtml(formatSlot(slot))}</span>`).join("")}</div></div>`).join("")}</div>` : '<div class="empty">分享連結給玩家，等大家填完就會顯示在這裡。</div>';
}

function calculateSuggestions() {
  const groups = new Map();
  availability.forEach(person => (person.slots || []).forEach(slot => {
    const groupKey = currentEvent.kind === "weekly" ? String(slot.weekday) : "date";
    const start = currentEvent.kind === "weekly" ? slot.startTime : slot.start;
    const end = currentEvent.kind === "weekly" ? slot.endTime : slot.end;
    if (!start || !end || end <= start) return;
    const group = groups.get(groupKey) || [];
    group.push({ start, end, person: person.name });
    groups.set(groupKey, group);
  }));
  const output = [];
  groups.forEach((ranges, groupKey) => {
    const boundaries = [...new Set(ranges.flatMap(range => [range.start, range.end]))].sort();
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const people = [...new Set(ranges.filter(range => range.start <= start && range.end >= end).map(range => range.person))].sort();
      if (!people.length) continue;
      const previous = output.at(-1);
      if (previous && previous.groupKey === groupKey && previous.end === start && previous.people.join("|") === people.join("|")) previous.end = end;
      else output.push({ groupKey, start, end, weekday: currentEvent.kind === "weekly" ? Number(groupKey) : null, people });
    }
  });
  return output.sort((a, b) => b.people.length - a.people.length || a.start.localeCompare(b.start)).slice(0, 8);
}

function formatSuggestion(item) {
  if (currentEvent.kind === "weekly") return `${DAYS[item.weekday]} ${item.start}－${item.end}`;
  return `${formatDateTime(item.start)}－${item.end.slice(11, 16)}`;
}

function formatSlot(slot) {
  return currentEvent.kind === "weekly" ? `${DAYS[slot.weekday]} ${slot.startTime}－${slot.endTime}` : `${formatDateTime(slot.start)}－${slot.end.slice(11, 16)}`;
}

function formatDateTime(value) {
  if (!value || value.length < 16) return value || "";
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(year, month - 1, day).getDay()];
  return `${month}/${day}（${weekday}）${time}`;
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
