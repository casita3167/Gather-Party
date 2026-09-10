import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, getFirestore,
  onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const PERIODS = [
  ["全天", "整天皆可"],
  ["早上", "08:00～12:00"],
  ["下午", "14:00～18:00"],
  ["晚上", "20:00～24:00"],
  ["時間由GM決定", "由 GM 決定實際時間"]
];
const JOIN_STATUS = { pending: "待處理", approved: "核准", rejected: "婉拒" };

let auth;
let db;
let user = null;
let role = null;
let adminEvents = [];
let unsubscribeAdmin = null;
let adminEventsLoaded = false;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 2200);
}

function showError(error, fallback = "操作失敗，請稍後再試。") {
  console.error(error);
  toast(error?.code === "permission-denied" ? "你沒有執行這項操作的權限。" : fallback);
}

function route() {
  const poll = location.hash.match(/^#poll=([A-Za-z0-9_-]+)$/);
  if (poll) return { page: "poll", id: poll[1] };
  if (location.hash === "#admin") return { page: "admin" };
  return { page: "home" };
}

function nav(active = "home") {
  const isMember = user && !user.isAnonymous;
  return `<header class="topbar">
    <a class="brand" href="#"><span class="brandmark" aria-hidden="true">⚄</span><span>Gather Party<small>TRPG 團務管理</small></span></a>
    <nav><a href="./quick.html">快速約團</a><a class="${active === "admin" ? "active" : ""}" href="#admin">${isMember ? "管理後台" : "管理登入"}</a></nav>
  </header>`;
}

function formatDate(value) {
  if (!value) return "日期未定";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  const day = ["日", "一", "二", "三", "四", "五", "六"][new Date(y, m - 1, d).getDay()];
  return `${y} 年 ${m} 月 ${d} 日（週${day}）`;
}

function spots(event) {
  const approved = Number(event.approvedCount || 0);
  const capacity = Number(event.capacity || 0);
  return { approved, capacity, remaining: Math.max(0, capacity - approved) };
}

function renderHome() {
  const isMember = Boolean(user && !user.isAnonymous);
  root.innerHTML = `<main class="shell">${nav("home")}
    <section class="portal-head"><span class="eyebrow">GATHER PARTY</span><h1>選擇要使用的功能</h1><p>建立約團調查，或登入後台管理資料。</p></section>
    <section class="portal-grid" aria-label="主要功能">
      <a class="portal-card quick" href="./quick.html"><span class="portal-icon" aria-hidden="true">⚄</span><div><h2>快速約團</h2><p>建立連結，讓玩家從月曆填寫可跑日期與時段。</p><b>前往快速約團 →</b></div></a>
      <a class="portal-card admin" href="#admin"><span class="portal-icon" aria-hidden="true">⌘</span><div><h2>管理後台</h2><p>管理團務資料、申請、時間調查與所有快速約團表。</p><b>${isMember ? "進入管理後台" : "登入管理後台"} →</b></div></a>
    </section>
  </main>`;
}

async function getRole(account) {
  if (!account || account.isAnonymous) return null;
  const [admin, gm] = await Promise.all([
    getDoc(doc(db, "admins", account.uid)),
    getDoc(doc(db, "gms", account.uid))
  ]);
  if (admin.exists()) return { key: "admin", label: admin.data().displayName || "管理員" };
  if (gm.exists()) return { key: "gm", label: gm.data().displayName || "GM" };
  return null;
}

function renderLogin(message = "") {
  root.innerHTML = `<main class="shell narrow">${nav("admin")}<section class="login-card"><span class="brandmark">⚄</span><h1>團務管理登入</h1><p>你可以只是建立者或統計者，不必是這場團的實際 GM。</p><form id="login-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>密碼<input name="password" type="password" autocomplete="current-password" required></label><p class="form-message">${escapeHtml(message)}</p><button class="button full" type="submit">登入管理後台</button></form><a href="#">← 回首頁</a></section></main>`;
  document.querySelector("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const credential = await signInWithEmailAndPassword(auth, e.currentTarget.email.value.trim(), e.currentTarget.password.value);
      role = await getRole(credential.user);
      if (!role) {
        await signOut(auth);
        return renderLogin("此帳號尚未被設定為 GM 或管理員。");
      }
      renderAdmin();
    } catch (error) {
      console.error(error);
      renderLogin("登入失敗，請確認 Email 與密碼。");
    }
  });
}

async function subscribeAdminEvents() {
  unsubscribeAdmin?.();
  adminEventsLoaded = false;
  const source = role.key === "admin"
    ? collection(db, "managedEvents")
    : query(collection(db, "managedEvents"), where("ownerUid", "==", user.uid));
  unsubscribeAdmin = onSnapshot(source, snap => {
    adminEvents = snap.docs.map(item => ({ id: item.id, ...item.data() })).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    adminEventsLoaded = true;
    if (route().page === "admin") renderAdmin();
  }, error => showError(error, "無法載入管理資料。"));
}

function renderAdmin() {
  if (!user || user.isAnonymous) return renderLogin();
  if (!role) return renderLogin("此帳號沒有管理權限。");
  root.innerHTML = `<main class="shell">${nav("admin")}
    <section class="admin-head"><div><span class="eyebrow">MANAGEMENT</span><h1>團務管理</h1><p>${escapeHtml(role.label)}・${escapeHtml(user.email || "")}</p></div><div><button class="button secondary" id="logout">登出</button><button class="button" id="new-event">＋ 開團</button></div></section>
    <div class="admin-grid"><aside class="admin-nav"><button class="active" data-view="managedEvents">團務列表</button><button data-view="requests">加團申請</button><button data-view="polls">時間調查</button>${role.key === "admin" ? '<button data-view="quickSchedules">快速約團</button>' : ""}</aside><section id="admin-content" class="admin-content"></section></div>
    <dialog id="event-dialog"></dialog><dialog id="poll-dialog"></dialog>
  </main>`;
  document.querySelector("#logout").onclick = async () => {
    unsubscribeAdmin?.();
    unsubscribeAdmin = null;
    adminEventsLoaded = false;
    await signOut(auth);
  };
  document.querySelector("#new-event").onclick = () => openEventDialog();
  document.querySelectorAll(".admin-nav button").forEach(button => button.onclick = () => {
    document.querySelectorAll(".admin-nav button").forEach(item => item.classList.toggle("active", item === button));
    renderAdminView(button.dataset.view);
  });
  renderAdminView("managedEvents");
  if (adminEventsLoaded) {
    const pendingDate = sessionStorage.getItem("gather-party-create-date");
    if (pendingDate) {
      sessionStorage.removeItem("gather-party-create-date");
      requestAnimationFrame(() => openEventDialog(null, pendingDate));
    }
  }
}

function renderAdminView(view) {
  const panel = document.querySelector("#admin-content");
  if (!panel) return;
  if (view === "managedEvents") {
    panel.innerHTML = `<div class="panel-title"><div><h2>我的團務</h2><p>公開、隱藏與日期未定的團務都在這裡管理。</p></div></div><div class="manage-list">${adminEvents.length ? adminEvents.map(event => `<article class="manage-row"><div><div class="badges">${event.hidden ? '<span class="badge hidden">本團隱藏</span>' : '<span class="badge open">公開</span>'}${event.registrationClosed ? '<span class="badge closed">關閉報名</span>' : ""}</div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(formatDate(event.date))}・${escapeHtml(event.time || "時間未定")}・${escapeHtml(event.gm || "")}</p></div><div class="row-actions"><button class="button secondary edit-event" data-id="${event.id}">編輯</button><button class="button secondary requests-event" data-id="${event.id}">申請</button>${!event.date ? `<button class="button secondary poll-event" data-id="${event.id}">時間調查</button>` : ""}<button class="icon-button delete-event" data-id="${event.id}" aria-label="刪除團務">×</button></div></article>`).join("") : '<div class="empty">還沒有團務，按右上角「開團」建立第一場。</div>'}</div>`;
    panel.querySelectorAll(".edit-event").forEach(button => button.onclick = () => openEventDialog(adminEvents.find(event => event.id === button.dataset.id)));
    panel.querySelectorAll(".delete-event").forEach(button => button.onclick = () => deleteEvent(button.dataset.id));
    panel.querySelectorAll(".requests-event").forEach(button => button.onclick = () => renderRequests(button.dataset.id));
    panel.querySelectorAll(".poll-event").forEach(button => button.onclick = () => openPollDialog(adminEvents.find(event => event.id === button.dataset.id)));
  } else if (view === "requests") {
    panel.innerHTML = `<div class="panel-title"><div><h2>加團申請</h2><p>請先選擇要查看的團務。</p></div><select id="request-event"><option value="">選擇團務</option>${adminEvents.map(event => `<option value="${event.id}">${escapeHtml(event.title)}</option>`).join("")}</select></div><div id="request-list" class="empty">選擇團務後會顯示申請資料。</div>`;
    document.querySelector("#request-event").onchange = e => e.target.value && renderRequests(e.target.value);
  } else if (view === "quickSchedules" && role.key === "admin") {
    renderQuickScheduleAdmin();
  } else {
    renderPollManager();
  }
}

async function renderQuickScheduleAdmin() {
  const panel = document.querySelector("#admin-content");
  panel.innerHTML = '<div class="loading-inline"><div class="spinner"></div>正在讀取快速約團⋯</div>';
  try {
    const snap = await getDocs(collection(db, "quickSchedules"));
    const schedules = await Promise.all(snap.docs.map(async item => {
      const responseSnap = await getDocs(collection(db, "quickSchedules", item.id, "responses"));
      return { id: item.id, ...item.data(), responseCount: responseSnap.size };
    }));
    schedules.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    panel.innerHTML = `<div class="panel-title"><div><h2>所有快速約團</h2><p>管理員可以查看與刪除任何人建立的快速約團表。</p></div><span class="count-pill">${schedules.length} 張</span></div><div class="manage-list">${schedules.length ? schedules.map(item => `<article class="manage-row"><div><div class="badges"><span class="badge system">${item.responseCount} 人填寫</span><span class="badge open">門檻 ${Number(item.minPlayers || 1)} 人</span></div><h3>${escapeHtml(item.title)}</h3><p>建立者：${escapeHtml(item.coordinatorName || "未填")}・GM：${escapeHtml(item.gmName || "未定")}・${item.dates?.length || 0} 個候選日</p></div><div class="row-actions"><a class="button secondary" href="./quick.html#quick=${item.id}" target="_blank" rel="noreferrer">查看填表</a><button class="button reject delete-quick-admin" data-id="${item.id}">刪除</button></div></article>`).join("") : '<div class="empty">目前沒有快速約團表。</div>'}</div>`;
    panel.querySelectorAll(".delete-quick-admin").forEach(button => {
      button.onclick = () => deleteQuickScheduleAdmin(schedules.find(item => item.id === button.dataset.id));
    });
  } catch (error) {
    showError(error, "無法讀取快速約團表。");
    panel.innerHTML = '<div class="empty">無法讀取快速約團表，請確認新版 Firestore Rules 已發布。</div>';
  }
}

async function deleteQuickScheduleAdmin(schedule) {
  if (!schedule || !confirm(`確定刪除「${schedule.title}」？玩家填寫資料與私人管理權限也會一併刪除。`)) return;
  try {
    const [responses, tokens, managers] = await Promise.all([
      getDocs(collection(db, "quickSchedules", schedule.id, "responses")),
      getDocs(collection(db, "quickSchedules", schedule.id, "managementTokens")),
      getDocs(collection(db, "quickSchedules", schedule.id, "managers"))
    ]);
    if (responses.size + tokens.size + managers.size > 450) return toast("關聯資料過多，請分批清理後再刪除。");
    const batch = writeBatch(db);
    responses.docs.forEach(item => batch.delete(item.ref));
    tokens.docs.forEach(item => batch.delete(item.ref));
    managers.docs.forEach(item => batch.delete(item.ref));
    batch.delete(doc(db, "quickSchedules", schedule.id));
    await batch.commit();
    toast("快速約團表已刪除");
    renderQuickScheduleAdmin();
  } catch (error) {
    showError(error, "快速約團表刪除失敗。");
  }
}

function openEventDialog(event = null, presetDate = "") {
  const dialog = document.querySelector("#event-dialog");
  const editing = Boolean(event);
  dialog.innerHTML = `<form method="dialog" class="dialog-card" id="event-form"><div class="dialog-head"><div><span class="eyebrow">EVENT</span><h2>${editing ? "編輯團務" : "建立團務"}</h2></div><button class="icon-button" value="cancel" aria-label="關閉">×</button></div>
    <div class="form-grid"><label>團名<input name="title" maxlength="80" value="${escapeHtml(event?.title || "")}" required></label><label>實際 GM／主持人<input name="gm" maxlength="40" value="${escapeHtml(event?.gm || "")}" required></label><label>建立者／統計者<input name="coordinator" maxlength="40" value="${escapeHtml(event?.coordinator || role.label)}" required></label><label>給玩家的聯絡方式（選填）<input name="publicContact" maxlength="120" value="${escapeHtml(event?.publicContact || "")}" placeholder="Discord、LINE 或其他聯絡方式"></label><label>系統<input name="system" maxlength="40" value="${escapeHtml(event?.system || "")}" placeholder="例如：CoC 7th" required></label><label>劇本<input name="scenario" maxlength="100" value="${escapeHtml(event?.scenario || "")}" required></label><label>人數<input name="capacity" type="number" min="1" max="30" value="${Number(event?.capacity || 4)}" required></label><label>地點<input name="location" maxlength="100" value="${escapeHtml(event?.location || "")}" required></label></div>
    <label class="checkline"><input id="date-tbd" name="dateTbd" type="checkbox" ${event && !event.date ? "checked" : ""}>日期未定，之後使用時間調查</label>
    <div class="form-grid"><label>日期<input id="event-date" name="date" type="date" value="${escapeHtml(event?.date || presetDate)}" ${event && !event.date ? "disabled" : ""}></label><label>時間<input name="time" maxlength="40" value="${escapeHtml(event?.time || "")}" placeholder="例如：20:00～24:00"></label></div>
    <label>相關連結<input name="externalLink" type="url" value="${escapeHtml(event?.externalLink || "")}" placeholder="Discord、FVTT、ccfolia 或角色卡連結"></label>
    <label>說明<textarea name="description" maxlength="1500">${escapeHtml(event?.description || "")}</textarea></label>
    <div class="switches"><label><input name="hidden" type="checkbox" ${event?.hidden ? "checked" : ""}><span><b>本團隱藏</b><small>不顯示於公開月曆與列表</small></span></label><label><input name="registrationClosed" type="checkbox" ${event?.registrationClosed ? "checked" : ""}><span><b>關閉報名</b><small>仍可公開顯示，但不接受新申請</small></span></label></div>
    <div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button" id="save-event" type="submit" value="default">儲存團務</button></div></form>`;
  dialog.showModal();
  const form = document.querySelector("#event-form");
  form.querySelectorAll('[value="cancel"]').forEach(button => button.onclick = e => {
    e.preventDefault();
    dialog.close();
  });
  document.querySelector("#date-tbd").onchange = e => { document.querySelector("#event-date").disabled = e.target.checked; if (e.target.checked) document.querySelector("#event-date").value = ""; };
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!form.dateTbd.checked && !form.date.value) return toast("請選擇日期，或勾選「日期未定」。");
    const button = document.querySelector("#save-event");
    button.disabled = true;
    const data = {
      title: form.elements.title.value.trim(), gm: form.gm.value.trim(),
      coordinator: form.coordinator.value.trim(), publicContact: form.publicContact.value.trim(),
      system: form.system.value.trim(),
      scenario: form.scenario.value.trim(), capacity: Number(form.capacity.value), location: form.location.value.trim(),
      date: form.dateTbd.checked ? "" : form.date.value, time: form.time.value.trim(),
      externalLink: form.externalLink.value.trim(), description: form.description.value.trim(),
      hidden: form.hidden.checked, registrationClosed: form.registrationClosed.checked,
      updatedAt: serverTimestamp()
    };
    try {
      if (editing) await updateDoc(doc(db, "managedEvents", event.id), data);
      else await addDoc(collection(db, "managedEvents"), { ...data, approvedCount: 0, ownerUid: user.uid, createdAt: serverTimestamp() });
      dialog.close();
      toast(editing ? "團務已更新" : "團務已建立");
    } catch (error) { showError(error, "團務儲存失敗。"); button.disabled = false; }
  });
}

async function deleteEvent(id) {
  const event = adminEvents.find(item => item.id === id);
  if (!event || !confirm(`確定刪除「${event.title}」？申請與時間調查也會一併刪除。`)) return;
  try {
    const [requests, polls, players] = await Promise.all([
      getDocs(collection(db, "managedEvents", id, "joinRequests")),
      getDocs(collection(db, "managedEvents", id, "polls")),
      getDocs(role.key === "admin"
        ? query(collection(db, "pollPlayers"), where("eventId", "==", id))
        : query(collection(db, "pollPlayers"), where("ownerUid", "==", user.uid)))
    ]);
    const relatedPlayers = players.docs.filter(item => item.data().eventId === id);
    if (requests.size + polls.size + relatedPlayers.length > 450) {
      return toast("關聯資料過多，請先逐份清除時間調查再刪除團務。");
    }
    const batch = writeBatch(db);
    requests.docs.forEach(item => batch.delete(item.ref));
    polls.docs.forEach(item => batch.delete(item.ref));
    relatedPlayers.forEach(item => batch.delete(item.ref));
    batch.delete(doc(db, "managedEvents", id));
    await batch.commit();
    toast("團務與關聯資料已刪除");
  } catch (error) { showError(error, "團務刪除失敗。"); }
}

async function renderRequests(eventId) {
  const panel = document.querySelector("#admin-content");
  const event = adminEvents.find(item => item.id === eventId);
  panel.innerHTML = '<div class="loading-inline"><div class="spinner"></div>正在讀取申請⋯</div>';
  try {
    const snap = await getDocs(collection(db, "managedEvents", eventId, "joinRequests"));
    const requests = snap.docs.map(item => ({ id: item.id, ...item.data() }));
    panel.innerHTML = `<div class="panel-title"><div><button class="back-button" id="back-admin">← 返回</button><h2>${escapeHtml(event.title)}：加團申請</h2><p>核准後會自動計入已核准人數。</p></div><span class="count-pill">${requests.length} 筆</span></div><div class="request-list">${requests.length ? requests.map(item => `<article class="request-card"><div class="request-head"><div><span class="status ${item.status}">${JOIN_STATUS[item.status] || "待處理"}</span><h3>${escapeHtml(item.playerName)}</h3></div><span>${escapeHtml(item.contact)}</span></div>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}<div class="row-actions"><button class="button secondary set-request" data-id="${item.id}" data-status="pending">待處理</button><button class="button approve set-request" data-id="${item.id}" data-status="approved">核准</button><button class="button reject set-request" data-id="${item.id}" data-status="rejected">婉拒</button><button class="icon-button delete-request" data-id="${item.id}">×</button></div></article>`).join("") : '<div class="empty">目前沒有加團申請。</div>'}</div>`;
    document.querySelector("#back-admin").onclick = () => renderAdminView("managedEvents");
    panel.querySelectorAll(".set-request").forEach(button => button.onclick = () => updateRequest(event, requests.find(item => item.id === button.dataset.id), button.dataset.status));
    panel.querySelectorAll(".delete-request").forEach(button => button.onclick = () => deleteRequest(event, requests.find(item => item.id === button.dataset.id)));
  } catch (error) { showError(error, "無法讀取申請。"); }
}

async function updateRequest(event, request, status) {
  if (!request || request.status === status) return;
  const delta = (status === "approved" ? 1 : 0) - (request.status === "approved" ? 1 : 0);
  if (delta > 0 && spots(event).remaining <= 0) return toast("名額已滿，無法再核准。");
  const batch = writeBatch(db);
  batch.update(doc(db, "managedEvents", event.id, "joinRequests", request.id), { status, updatedAt: serverTimestamp() });
  batch.update(doc(db, "managedEvents", event.id), { approvedCount: Math.max(0, Number(event.approvedCount || 0) + delta), updatedAt: serverTimestamp() });
  try { await batch.commit(); toast(`申請已設為「${JOIN_STATUS[status]}」`); renderRequests(event.id); } catch (error) { showError(error, "申請狀態更新失敗。"); }
}

async function deleteRequest(event, request) {
  if (!confirm("確定刪除這筆申請？")) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "managedEvents", event.id, "joinRequests", request.id));
    if (request.status === "approved") {
      batch.update(doc(db, "managedEvents", event.id), {
        approvedCount: Math.max(0, Number(event.approvedCount || 0) - 1),
        updatedAt: serverTimestamp()
      });
    }
    await batch.commit();
    toast("申請已刪除");
    renderRequests(event.id);
  } catch (error) { showError(error); }
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function dateRange(start, end) {
  const dates = [];
  if (!start || !end || start > end) return dates;
  const cursor = new Date(`${start}T00:00:00Z`);
  const finish = new Date(`${end}T00:00:00Z`);
  while (cursor <= finish && dates.length < 31) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function openPollDialog(event) {
  const dialog = document.querySelector("#poll-dialog");
  dialog.innerHTML = `<form method="dialog" class="dialog-card" id="poll-form"><div class="dialog-head"><div><span class="eyebrow">AVAILABILITY</span><h2>建立時間調查</h2><p>${escapeHtml(event.title)}</p></div><button class="icon-button" value="cancel">×</button></div>
    <label>日期方式<select name="mode"><option value="range">日期範圍</option><option value="specific">指定日期</option></select></label>
    <div id="range-fields" class="form-grid"><label>開始日期<input name="start" type="date"></label><label>結束日期<input name="end" type="date"></label></div>
    <label id="specific-field" hidden>指定日期<textarea name="specific" placeholder="每行一個日期，例如：&#10;2026-10-15&#10;2026-10-18"></textarea></label>
    <label>玩家名稱<textarea name="players" required placeholder="每行一位玩家，例如：&#10;小明&#10;小蒼&#10;雷恩"></textarea></label>
    <p class="hint">每位玩家會取得不同的私人連結。預設可填全天、早上、下午、晚上及由 GM 決定。</p>
    <div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button" id="create-poll" type="submit" value="default">建立並產生連結</button></div></form>`;
  dialog.showModal();
  const form = document.querySelector("#poll-form");
  form.querySelectorAll('[value="cancel"]').forEach(button => button.onclick = e => {
    e.preventDefault();
    dialog.close();
  });
  form.mode.onchange = () => {
    const specific = form.mode.value === "specific";
    document.querySelector("#range-fields").hidden = specific;
    document.querySelector("#specific-field").hidden = !specific;
  };
  form.addEventListener("submit", async e => {
    e.preventDefault();
    let dates = form.mode.value === "range"
      ? dateRange(form.start.value, form.end.value)
      : [...new Set(form.specific.value.split(/\r?\n|,/).map(v => v.trim()).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)))].sort();
    const players = [...new Set(form.players.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
    if (!dates.length) return toast("請填寫有效的日期。");
    if (dates.length > 31) return toast("一次調查最多可以設定 31 個日期。");
    if (!players.length) return toast("請至少輸入一位玩家。");
    if (players.length > 100) return toast("一次調查最多可以加入 100 位玩家。");
    const button = document.querySelector("#create-poll");
    button.disabled = true;
    try {
      const pollRef = await addDoc(collection(db, "managedEvents", event.id, "polls"), {
        ownerUid: user.uid, dates, periods: PERIODS.map(item => item[0]), active: true, createdAt: serverTimestamp()
      });
      const batch = writeBatch(db);
      players.forEach(name => {
        const token = randomToken();
        batch.set(doc(db, "pollPlayers", token), {
          pollId: pollRef.id, eventId: event.id, eventTitle: event.title, ownerUid: user.uid, playerName: name,
          dates, periods: PERIODS.map(item => item[0]), slots: [], submitted: false, updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
      dialog.close();
      toast("時間調查已建立");
      renderPollDetail(event.id, pollRef.id);
    } catch (error) { showError(error, "時間調查建立失敗。"); button.disabled = false; }
  });
}

async function renderPollManager() {
  const panel = document.querySelector("#admin-content");
  panel.innerHTML = `<div class="panel-title"><div><h2>時間調查</h2><p>只有日期未定的團務能建立調查。</p></div><select id="poll-event"><option value="">選擇團務</option>${adminEvents.filter(event => !event.date).map(event => `<option value="${event.id}">${escapeHtml(event.title)}</option>`).join("")}</select></div><div id="poll-list" class="empty">選擇團務後會顯示時間調查。</div>`;
  document.querySelector("#poll-event").onchange = e => e.target.value && listPolls(e.target.value);
}

async function listPolls(eventId) {
  const area = document.querySelector("#poll-list");
  const event = adminEvents.find(item => item.id === eventId);
  area.className = "";
  area.innerHTML = '<div class="loading-inline"><div class="spinner"></div>正在讀取調查⋯</div>';
  try {
    const snap = await getDocs(collection(db, "managedEvents", eventId, "polls"));
    const polls = snap.docs.map(item => ({ id: item.id, ...item.data() }));
    area.innerHTML = `<div class="poll-toolbar"><span>${polls.length} 份調查</span><button class="button" id="new-poll">＋ 建立調查</button></div><div class="manage-list">${polls.length ? polls.map(poll => `<article class="manage-row"><div><h3>${poll.dates.length} 個候選日期</h3><p>${escapeHtml(poll.dates[0])} ～ ${escapeHtml(poll.dates.at(-1))}</p></div><div class="row-actions"><button class="button secondary open-poll" data-id="${poll.id}">查看結果</button><button class="button reject clear-poll" data-id="${poll.id}">清除</button></div></article>`).join("") : '<div class="empty">尚未建立調查。</div>'}</div>`;
    document.querySelector("#new-poll").onclick = () => openPollDialog(event);
    area.querySelectorAll(".open-poll").forEach(button => button.onclick = () => renderPollDetail(eventId, button.dataset.id));
    area.querySelectorAll(".clear-poll").forEach(button => button.onclick = () => clearPoll(eventId, button.dataset.id));
  } catch (error) { showError(error, "無法讀取調查。"); }
}

async function pollPlayers(pollId) {
  const source = role.key === "admin"
    ? query(collection(db, "pollPlayers"), where("pollId", "==", pollId))
    : query(collection(db, "pollPlayers"), where("ownerUid", "==", user.uid));
  const snap = await getDocs(source);
  return snap.docs.map(item => ({ token: item.id, ...item.data() })).filter(item => item.pollId === pollId);
}

function pollResults(players) {
  const keys = new Set(players.flatMap(player => player.dates.flatMap(date => player.periods.map(period => `${date}|${period}`))));
  return [...keys].map(key => {
    const available = players.filter(player => player.slots.includes(key));
    return { key, available, total: players.length };
  }).sort((a, b) => b.available.length - a.available.length || a.key.localeCompare(b.key));
}

async function renderPollDetail(eventId, pollId) {
  const panel = document.querySelector("#admin-content");
  const event = adminEvents.find(item => item.id === eventId);
  panel.innerHTML = '<div class="loading-inline"><div class="spinner"></div>正在計算共同時段⋯</div>';
  try {
    const players = await pollPlayers(pollId);
    const results = pollResults(players);
    const common = results.filter(item => players.length && item.available.length === players.length);
    const majority = results.filter(item => item.available.length >= Math.ceil(players.length / 2) && item.available.length < players.length).slice(0, 12);
    const base = location.href.split("#")[0];
    root.querySelector("#admin-content").innerHTML = `<div class="panel-title"><div><button class="back-button" id="back-polls">← 返回</button><h2>${escapeHtml(event.title)}：時間調查</h2><p>${players.filter(p => p.submitted).length}／${players.length} 人已填寫</p></div><button class="button secondary" id="copy-links">複製所有私人連結</button></div>
      <div class="result-grid"><section><h3>全員共同時段</h3>${common.length ? common.map(resultRow).join("") : '<div class="empty small">目前沒有全員共同時段。</div>'}</section><section><h3>多數可跑時段</h3>${majority.length ? majority.map(resultRow).join("") : '<div class="empty small">目前沒有多數時段。</div>'}</section></div>
      <section class="player-links"><h3>玩家填寫狀態與私人連結</h3>${players.map(player => `<div class="player-link"><span class="status ${player.submitted ? "approved" : "pending"}">${player.submitted ? "已填寫" : "未填寫"}</span><b>${escapeHtml(player.playerName)}</b><input readonly value="${escapeHtml(base + "#poll=" + player.token)}"><button class="button secondary copy-player" data-token="${player.token}">複製</button></div>`).join("")}</section>`;
    document.querySelector("#back-polls").onclick = () => { renderAdminView("polls"); setTimeout(() => listPolls(eventId)); };
    document.querySelector("#copy-links").onclick = () => copyText(players.map(p => `${p.playerName}：${base}#poll=${p.token}`).join("\n"));
    document.querySelectorAll(".copy-player").forEach(button => button.onclick = () => copyText(`${base}#poll=${button.dataset.token}`));
  } catch (error) { showError(error, "無法載入調查結果。"); }
}

function resultRow(item) {
  const [date, period] = item.key.split("|");
  return `<div class="result-row"><div><b>${escapeHtml(formatDate(date))}</b><span>${escapeHtml(period)}</span></div><strong>${item.available.length}／${item.total}</strong><small>${escapeHtml(item.available.map(p => p.playerName).join("、"))}</small></div>`;
}

async function clearPoll(eventId, pollId) {
  if (!confirm("清除後，所有玩家的私人連結都會立即失效。確定繼續？")) return;
  try {
    const players = await pollPlayers(pollId);
    const batch = writeBatch(db);
    players.forEach(player => batch.delete(doc(db, "pollPlayers", player.token)));
    batch.delete(doc(db, "managedEvents", eventId, "polls", pollId));
    await batch.commit();
    toast("調查資料已清除，舊連結已失效");
    listPolls(eventId);
  } catch (error) { showError(error, "調查清除失敗。"); }
}

async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast("已複製"); } catch { toast("無法自動複製，請手動選取。"); }
}

async function renderPlayerPoll(token) {
  root.innerHTML = '<main class="loading-screen"><div class="spinner"></div><p>正在開啟你的私人時間表⋯</p></main>';
  try {
    const ref = doc(db, "pollPlayers", token);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("這個調查連結不存在或已失效。");
    const player = snap.data();
    let event = { title: player.eventTitle || "團務時間調查" };
    try {
      const eventSnap = await getDoc(doc(db, "managedEvents", player.eventId));
      if (eventSnap.exists()) event = eventSnap.data();
    } catch {
      // 隱藏團務不向訪客公開；私人連結仍可使用其中保存的團名。
    }
    const selected = new Set(player.slots || []);
    root.innerHTML = `<main class="shell narrow"><header class="poll-brand"><span class="brandmark">⚄</span><div><small>私人時間調查</small><b>${escapeHtml(event.title)}</b></div></header><section class="poll-intro"><span>填寫者</span><h1>${escapeHtml(player.playerName)}</h1><p>點選你可以跑團的時段；可複選。這個連結只屬於你，請不要轉傳。</p></section><form id="player-poll"><div class="availability-table"><div class="availability-head"><span>日期</span>${player.periods.map(period => `<span title="${escapeHtml(PERIODS.find(item => item[0] === period)?.[1] || "")}">${escapeHtml(period)}</span>`).join("")}</div>${player.dates.map(date => `<div class="availability-row"><b>${escapeHtml(formatDate(date))}</b>${player.periods.map(period => { const key = `${date}|${period}`; return `<label class="slot-check"><input type="checkbox" value="${escapeHtml(key)}" ${selected.has(key) ? "checked" : ""}><span>✓</span></label>`; }).join("")}</div>`).join("")}</div><button class="button full" type="submit">儲存我的時間</button></form></main>`;
    document.querySelector("#player-poll").onsubmit = async e => {
      e.preventDefault();
      const slots = [...e.currentTarget.querySelectorAll('input:checked')].map(input => input.value);
      const button = e.currentTarget.querySelector("button");
      button.disabled = true;
      try {
        await updateDoc(ref, { slots, submitted: true, updatedAt: serverTimestamp() });
        button.textContent = "已儲存！仍可繼續修改";
        toast("你的時間已儲存");
      } catch (error) { showError(error, "時間儲存失敗。"); button.disabled = false; }
    };
  } catch (error) {
    root.innerHTML = `<main class="error-screen"><span class="brandmark">⚄</span><h1>無法開啟時間調查</h1><p>${escapeHtml(error.message)}</p></main>`;
  }
}

async function handleRoute() {
  const current = route();
  if (current.page === "poll") return renderPlayerPoll(current.id);
  if (current.page === "admin") {
    if (!user || user.isAnonymous) return renderLogin();
    role = await getRole(user);
    if (!role) return renderLogin("此帳號尚未被設定為 GM 或管理員。");
    if (!unsubscribeAdmin) subscribeAdminEvents();
    return renderAdmin();
  }
  renderHome();
}

async function start() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, async account => {
    user = account;
    if (!user) return signInAnonymously(auth);
    await handleRoute();
  });
  window.addEventListener("hashchange", handleRoute);
}

start().catch(error => {
  console.error(error);
  root.innerHTML = '<main class="error-screen"><h1>網站初始化失敗</h1><p>請確認 Firebase 設定與網路連線。</p></main>';
});
