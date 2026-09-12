import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, getFirestore, writeBatch
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");

let auth;
let db;
let user = null;
let role = null;
let schedules = [];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 2200);
}

function route() {
  return location.hash === "#admin" ? "admin" : "home";
}

function nav(admin = false) {
  return `<header class="topbar">
    <a class="brand" href="#"><span class="brandmark brandmark-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><span>Gather Party<small>${admin ? "快速約團管理" : "TRPG 快速約團"}</small></span></a>
    <nav><a href="./quick.html">快速約團</a>${admin ? '<a class="active" href="#admin">管理後台</a>' : ""}</nav>
  </header>`;
}

function adminStyles() {
  return `<style>
    .quick-admin-wrap{display:grid;gap:18px}
    .quick-admin-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .quick-admin-stat{padding:18px 20px;border:1px solid var(--line,#e7e3f4);border-radius:18px;background:var(--card,#fff)}
    .quick-admin-stat small{display:block;color:var(--muted,#777);margin-bottom:5px}.quick-admin-stat strong{font-size:28px;line-height:1}
    .quick-admin-toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    .quick-admin-search{min-width:240px;max-width:420px;flex:1;padding:11px 14px;border:1px solid var(--line,#ddd);border-radius:12px;background:var(--card,#fff);color:inherit;font:inherit}
    .quick-admin-list{display:grid;gap:12px}
    .quick-admin-row{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:18px 20px;border:1px solid var(--line,#e7e3f4);border-radius:18px;background:var(--card,#fff)}
    .quick-admin-row-main{min-width:0}.quick-admin-row h3{margin:8px 0 6px}.quick-admin-row p{margin:0;color:var(--muted,#777);line-height:1.7}
    .quick-admin-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}
    .quick-admin-empty{padding:42px 20px;text-align:center;border:1px dashed var(--line,#ddd);border-radius:18px;color:var(--muted,#777)}
    @media(max-width:760px){.quick-admin-stats{grid-template-columns:1fr}.quick-admin-row{align-items:flex-start;flex-direction:column}.quick-admin-actions{width:100%;justify-content:flex-start}.quick-admin-search{max-width:none;width:100%}}
  </style>`;
}

function renderHome() {
  root.innerHTML = `<main class="shell">${nav(false)}
    <section class="portal-head"><span class="eyebrow">GATHER PARTY</span><h1>快速約團</h1><p>建立約團表，讓玩家從月曆填寫可跑日期與時段。</p></section>
    <section class="portal-grid single" aria-label="主要功能">
      <a class="portal-card quick" href="./quick.html"><span class="portal-icon portal-icon-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><div><h2>建立或查看約團表</h2><p>建立新的快速約團，或回到這台裝置曾經建立的約團表。</p><b>前往快速約團 →</b></div></a>
    </section>
    <a class="site-admin-lock" href="#admin" aria-label="管理後台"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></svg></a>
  </main>`;
}

async function getRole(account) {
  if (!account || account.isAnonymous) return null;
  const admin = await getDoc(doc(db, "admins", account.uid));
  return admin.exists() ? { key: "admin", label: admin.data().displayName || "管理員" } : null;
}

function renderLogin(message = "") {
  root.innerHTML = `<main class="shell narrow">${nav(true)}<section class="login-card"><span class="brandmark brandmark-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><h1>管理後台登入</h1><p>使用管理員帳號與密碼登入。</p><form id="login-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>密碼<input name="password" type="password" autocomplete="current-password" required></label><p class="form-message">${escapeHtml(message)}</p><button class="button full" type="submit">登入管理後台</button></form><a href="#">← 回首頁</a></section></main>`;
  document.querySelector("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const credential = await signInWithEmailAndPassword(auth, event.currentTarget.email.value.trim(), event.currentTarget.password.value);
      role = await getRole(credential.user);
      if (!role) {
        await signOut(auth);
        return renderLogin("此帳號沒有管理權限。");
      }
      user = credential.user;
      await renderAdmin();
    } catch (error) {
      console.error(error);
      renderLogin("登入失敗，請確認 Email 與密碼。");
    }
  });
}

async function loadSchedules() {
  const snap = await getDocs(collection(db, "quickSchedules"));
  const result = await Promise.all(snap.docs.map(async item => {
    const responseSnap = await getDocs(collection(db, "quickSchedules", item.id, "responses"));
    return { id: item.id, ...item.data(), responseCount: responseSnap.size };
  }));
  return result.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

function scheduleRow(item) {
  const created = item.createdAt?.toDate?.();
  const createdText = created ? new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }).format(created) : "建立時間不明";
  return `<article class="quick-admin-row" data-search="${escapeHtml(`${item.title || ""} ${item.coordinatorName || ""} ${item.gmName || ""}`.toLowerCase())}">
    <div class="quick-admin-row-main">
      <div class="badges"><span class="badge system">${Number(item.responseCount || 0)} 人填寫</span><span class="badge open">成團門檻 ${Number(item.minPlayers || 1)} 人</span></div>
      <h3>${escapeHtml(item.title || "未命名約團")}</h3>
      <p>建立者：${escapeHtml(item.coordinatorName || "未填")}・GM：${escapeHtml(item.gmName || "未定")}<br>${Number(item.dates?.length || 0)} 個候選日・${createdText}</p>
    </div>
    <div class="quick-admin-actions">
      <a class="button secondary" href="./quick.html#quick=${item.id}" target="_blank" rel="noreferrer">查看約團</a>
      <button class="button reject delete-quick-admin" data-id="${item.id}" type="button">刪除</button>
    </div>
  </article>`;
}

function drawScheduleList(filter = "") {
  const list = document.querySelector("#quick-admin-list");
  if (!list) return;
  const keyword = filter.trim().toLowerCase();
  const visible = schedules.filter(item => !keyword || `${item.title || ""} ${item.coordinatorName || ""} ${item.gmName || ""}`.toLowerCase().includes(keyword));
  list.innerHTML = visible.length ? visible.map(scheduleRow).join("") : '<div class="quick-admin-empty">找不到符合條件的快速約團。</div>';
  list.querySelectorAll(".delete-quick-admin").forEach(button => {
    button.onclick = () => deleteQuickScheduleAdmin(schedules.find(item => item.id === button.dataset.id));
  });
}

async function renderAdmin() {
  if (!user || user.isAnonymous) return renderLogin();
  role = await getRole(user);
  if (!role) return renderLogin("此帳號沒有管理權限。");

  root.innerHTML = `<main class="shell">${nav(true)}${adminStyles()}
    <section class="admin-head"><div><span class="eyebrow">QUICK SCHEDULER</span><h1>快速約團管理</h1><p>${escapeHtml(role.label)}・${escapeHtml(user.email || "")}</p></div><div><button class="button secondary" id="logout" type="button">登出</button></div></section>
    <section class="quick-admin-wrap">
      <div id="quick-admin-stats" class="quick-admin-stats"><div class="quick-admin-stat"><small>快速約團表</small><strong>—</strong></div><div class="quick-admin-stat"><small>玩家填寫總數</small><strong>—</strong></div><div class="quick-admin-stat"><small>已有玩家填寫</small><strong>—</strong></div></div>
      <section class="admin-content">
        <div class="panel-title"><div><h2>所有快速約團</h2><p>集中查看目前的約團表；需要時可以開啟或刪除。</p></div></div>
        <div class="quick-admin-toolbar"><input id="quick-admin-search" class="quick-admin-search" type="search" placeholder="搜尋團名、建立者或 GM"><button class="button secondary" id="refresh-schedules" type="button">重新整理</button></div>
        <div id="quick-admin-list" class="quick-admin-list"><div class="loading-inline"><div class="spinner"></div>正在讀取快速約團⋯</div></div>
      </section>
    </section>
  </main>`;

  document.querySelector("#logout").onclick = async () => {
    role = null;
    schedules = [];
    await signOut(auth);
  };
  document.querySelector("#quick-admin-search").oninput = event => drawScheduleList(event.target.value);
  document.querySelector("#refresh-schedules").onclick = () => refreshSchedules();
  await refreshSchedules();
}

async function refreshSchedules() {
  const list = document.querySelector("#quick-admin-list");
  const button = document.querySelector("#refresh-schedules");
  if (button) button.disabled = true;
  if (list) list.innerHTML = '<div class="loading-inline"><div class="spinner"></div>正在讀取快速約團⋯</div>';
  try {
    schedules = await loadSchedules();
    const totalResponses = schedules.reduce((sum, item) => sum + Number(item.responseCount || 0), 0);
    const active = schedules.filter(item => Number(item.responseCount || 0) > 0).length;
    const stats = document.querySelector("#quick-admin-stats");
    if (stats) stats.innerHTML = `<div class="quick-admin-stat"><small>快速約團表</small><strong>${schedules.length}</strong></div><div class="quick-admin-stat"><small>玩家填寫總數</small><strong>${totalResponses}</strong></div><div class="quick-admin-stat"><small>已有玩家填寫</small><strong>${active}</strong></div>`;
    drawScheduleList(document.querySelector("#quick-admin-search")?.value || "");
  } catch (error) {
    console.error(error);
    if (list) list.innerHTML = '<div class="quick-admin-empty">無法讀取快速約團表，請確認管理員權限或稍後重試。</div>';
    toast("無法讀取快速約團表。");
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteQuickScheduleAdmin(schedule) {
  if (!schedule || !role || !user || user.isAnonymous) return;
  if (!confirm(`確定刪除「${schedule.title || "未命名約團"}」？\n\n玩家填寫資料與私人管理權限會一起刪除，而且無法復原。`)) return;
  try {
    const [responses, tokens, managers] = await Promise.all([
      getDocs(collection(db, "quickSchedules", schedule.id, "responses")),
      getDocs(collection(db, "quickSchedules", schedule.id, "managementTokens")),
      getDocs(collection(db, "quickSchedules", schedule.id, "managers"))
    ]);
    if (responses.size + tokens.size + managers.size > 450) return toast("關聯資料過多，暫時無法一次刪除。");
    const batch = writeBatch(db);
    responses.docs.forEach(item => batch.delete(item.ref));
    tokens.docs.forEach(item => batch.delete(item.ref));
    managers.docs.forEach(item => batch.delete(item.ref));
    batch.delete(doc(db, "quickSchedules", schedule.id));
    await batch.commit();
    toast("快速約團表已刪除");
    await refreshSchedules();
  } catch (error) {
    console.error(error);
    toast("快速約團表刪除失敗。");
  }
}

async function handleRoute() {
  if (route() === "admin") {
    if (!user || user.isAnonymous) return renderLogin();
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
  root.innerHTML = '<main class="error-screen"><h1>網站初始化失敗</h1><p>請確認網路連線，並重新整理頁面。</p></main>';
});