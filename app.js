import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, getFirestore,
  serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { holidayFor } from "./taiwan-holidays.js?v=20260912-1";

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
    .admin-edit-dialog{width:min(760px,calc(100vw - 28px));max-height:90vh;overflow:auto;border:0;padding:0;border-radius:22px;background:transparent}
    .admin-edit-dialog::backdrop{background:rgba(18,16,32,.55);backdrop-filter:blur(3px)}
    .admin-edit-card{display:grid;gap:16px;background:var(--card,#fff);color:inherit;padding:24px;border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.22)}
    .admin-edit-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.admin-edit-head h2{margin:3px 0 0}.admin-edit-head p{margin:5px 0 0;color:var(--muted,#777)}
    .admin-edit-card label{display:grid;gap:7px;font-weight:650}.admin-edit-card input,.admin-edit-card textarea{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--line,#ddd);border-radius:12px;background:var(--card,#fff);color:inherit;font:inherit}.admin-edit-card textarea{min-height:88px;resize:vertical}
    .admin-edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.admin-period-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .admin-gm-section{display:grid;gap:10px;padding:14px;border:1px solid var(--line,#eee);border-radius:14px}.admin-gm-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.admin-gm-option{display:flex!important;grid-template-columns:none!important;align-items:center;gap:9px;padding:10px;border:1px solid var(--line,#ddd);border-radius:10px;font-weight:700!important}.admin-gm-option input{width:18px!important;height:18px;accent-color:#ad7800}.admin-gm-badge{color:#806000}
    .admin-lock-section{display:grid;gap:10px;padding-top:8px;border-top:1px solid var(--line,#eee)}.admin-lock-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.admin-lock-nav{display:flex;gap:6px;align-items:center}.admin-lock-nav button{min-width:38px}
    .admin-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.admin-weekday{text-align:center;font-size:12px;color:var(--muted,#777);padding:4px}
    .admin-day{min-height:62px;padding:7px;border:1px solid var(--line,#ddd);border-radius:11px;background:var(--card,#fff);color:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between}.admin-day:hover{border-color:#7367e8}.admin-day.locked{background:rgba(111,94,224,.13);border-color:#7367e8}.admin-day.holiday:not(.locked){background:rgba(220,74,93,.06)}.admin-day small{font-size:10px;color:var(--muted,#777)}
    .admin-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:6px}
    @media(max-width:760px){.quick-admin-stats{grid-template-columns:1fr}.quick-admin-row{align-items:flex-start;flex-direction:column}.quick-admin-actions{width:100%;justify-content:flex-start}.quick-admin-search{max-width:none;width:100%}.admin-edit-grid,.admin-period-grid,.admin-gm-list{grid-template-columns:1fr}.admin-edit-card{padding:18px}.admin-day{min-height:52px;padding:5px}}
  </style>`;
}


function homeGuideMarkup() {
  return `<style>
    .home-guide{max-width:860px;margin:28px auto 0;padding:clamp(18px,4vw,30px);background:#fff;border:1px solid var(--line,#e2e5eb);border-radius:22px;line-height:1.8;overflow-wrap:anywhere}
    .home-guide h2{margin:0 0 14px;font-size:clamp(1.3rem,3vw,1.7rem)}
    .home-guide-notice{padding:14px 18px;background:var(--primary-soft,#efecff);border-radius:14px;margin-bottom:18px}
    .home-guide-notice p{margin:6px 0}
    .home-guide details{border-top:1px solid var(--line,#e2e5eb);padding:14px 0}
    .home-guide summary{cursor:pointer;font-weight:800;color:var(--primary,#5446d6)}
    .home-guide summary:focus-visible{outline:2px solid var(--primary,#5446d6);outline-offset:4px}
    .home-guide li{margin:7px 0}.home-guide ol,.home-guide ul{padding-left:1.5em}
    .home-guide details p:last-child{margin-bottom:0}
  </style>
  <section class="home-guide" aria-labelledby="home-guide-title">
    <h2 id="home-guide-title">快速約團使用說明</h2>
    <div class="home-guide-notice"><strong>免註冊、匿名填表，以目前裝置的瀏覽器紀錄辨識你</strong>
      <p>不需要自行登入帳號。系統會透過這台裝置、這個瀏覽器保存的匿名身分，找回你建立的約團表與填寫紀錄。</p>
      <p><strong>之後修改，請使用原本的裝置與同一個瀏覽器。</strong>換裝置、換瀏覽器、使用無痕模式或清除網站資料，可能無法直接帶回原本的紀錄。在 LINE／Discord 內開啟與改用外部瀏覽器，也可能被視為不同使用者。</p>
      <p>約團資料儲存在網站上；清除瀏覽器資料不代表已刪除填表內容。</p>
    </div>
    <div class="home-guide-notice"><strong>約團網址是再次開啟這張表的固定入口，請建立者自行留存</strong><p>建立完成後，請複製並保存完整的「玩家填表連結」與「私人管理連結」，也可以加入瀏覽器書籤。請勿刪除網址中的任何部分；首頁網址無法取代個別約團表的連結。</p><p>玩家連結可分享給團員；私人管理連結只供建立者與受信任的管理者使用。請不要只依賴這台裝置的歷史紀錄找回約團表。</p></div>
    <details><summary>我是主持人（GM），如何認領？</summary>
      <p>填寫時間時勾選「我是本團主持人（GM，不計入玩家人數）」，再儲存。已送出者可按自己名字旁的「修改時間」，在彈窗中勾選並儲存；取消勾選並儲存即可回復玩家身分。</p>
      <p>GM 名字以黃色顯示，時間照常填寫，但不計入玩家人數。成團必須是同一天、同一時段 GM 確定有空，且玩家達到最低門檻。例如 4～6 人代表 1 位 GM 加上 4～6 位玩家；超額玩家資料仍保留。</p>
      <p>沒有 GM 認領或 GM 選 △ 時，暫不判定成團。每張表預設最多 3 位 GM；至少一位 GM 在該時段確定有空即可。若需要更多 GM，請由私人管理連結或管理後台提高上限。建立者／統計者不會自動成為 GM。管理後台也能替更新前建立的約團表，從既有填表者中指定 GM。</p>
    </details>
    <details open><summary>第一次填寫：選日期、選時段、儲存</summary>
      <ol><li>開啟建立者提供的「玩家填表連結」，輸入固定使用的玩家名稱。</li>
      <li>在月曆點選一天或多天，也可使用「週一～週五／週末／全月」快速選取。</li>
      <li>在「批次設定時段」選早上、下午、晚上，可複選；三個都選就是全天有空。實際時間以該表顯示為準。</li>
      <li>當天可能有空但尚未確定，選「△」；當天無法參加，選「X」。△ 不計入確定成團人數。</li>
      <li>需要時填寫備註，再按「儲存時間」。到「玩家時間一覽」確認送出的內容。</li></ol>
      <p>不同日期可分批填寫：先選 10～12 號的晚上並儲存，再選 16～25 號的下午並儲存。儲存後紫色底會取消，這是正常的。</p>
    </details>
    <details><summary>送出後，如何修改自己的時間？</summary>
      <ol><li>使用原本裝置與同一個瀏覽器，開啟同一張約團表的「玩家填表連結」。</li>
      <li>在「玩家時間一覽」找到自己的名字，按「修改時間」，開啟已帶入原紀錄的月曆彈窗。</li>
      <li>選取日期，調整早上、下午、晚上、△ 或 X；也可新增日期或按「移除所選日期」。淡紫底代表已有填寫，深紫底代表本次選取。</li>
      <li>一次選多天可批次修改，僅影響本次選取的日期；按「完成這批選取」後再調整另一批。</li>
      <li>確認下方「本次修改後的時間」與備註，再按「儲存修改」。會更新原本紀錄，不會新增另一位玩家；按「取消」則不儲存。</li></ol>
      <p>修改自己的時間不需要私人管理連結。換裝置、換瀏覽器或清除網站資料後，可能看不到自己的「修改時間」按鈕，請參考下方同名紀錄說明。約團已結束或日期被鎖定時，請聯絡建立者。</p>
    </details>
    <details><summary>換裝置，或出現同名紀錄怎麼辦？</summary>
      <p>請使用與原本<strong>完全相同的玩家名稱</strong>填寫並儲存。若出現同名確認視窗，逐日調整早上、下午、晚上、△ 或 X，再按「確認並儲存」。</p>
      <p>如果先關閉視窗，可在「玩家時間一覽」自己的紀錄中按「確認合併內容」。同一團的不同玩家請使用不同名稱，避免資料被誤合併；若仍找不到原紀錄，請聯絡建立者協助。</p>
    </details>
    <details><summary>月曆標示與約團結果怎麼看？</summary>
      <ul><li>紫色底：目前正在選取的日期；紫色日期數字與「今天」：今天，不代表已選取。</li>
      <li>名字圓圈：已填寫該日期的玩家。其他人填過，你仍可選取。</li>
      <li>編號圓圈：已儲存的日期批次。</li>
      <li>紅色假期名稱：國定假日或連假；「🔒 不開放」：建立者鎖定的日期。</li>
      <li>「玩家時間一覽」可查看日期、時段與備註；「可成團時段」顯示達到人數門檻的時段，△ 不計入確定人數。</li></ul>
    </details>
    <details><summary>建立者：分享連結與管理約團</summary>
      <p>從「建立或查看約團表」建立新表，設定團務名稱、聯絡資訊、時段、成團人數與不開放日期。</p>
      <ul><li><strong>玩家填表連結</strong>：分享給玩家，用來填寫與修改自己的時間。</li>
      <li><strong>私人管理連結</strong>：請自行保存，只提供給需要管理權限的人；可編輯設定、鎖定日期及管理填寫紀錄。</li></ul>
      <p>即使曾開過管理連結，再從玩家連結進入仍是普通填表模式。管理者可匯出結果、結束約團，結束後也可刪除約團表；刪除無法復原，請先保存需要的結果。</p>
    </details>
  </section>`;
}

function renderHome() {
  root.innerHTML = `<main class="shell">${nav(false)}
    <section class="portal-head"><span class="eyebrow">GATHER PARTY</span><h1>快速約團</h1><p>建立約團表，讓玩家從月曆填寫可跑日期與時段。</p></section>
    <section class="portal-grid single" aria-label="主要功能">
      <a class="portal-card quick" href="./quick.html"><span class="portal-icon portal-icon-image"><img src="./favicon.svg" alt="" aria-hidden="true"></span><div><h2>建立或查看約團表</h2><p>建立新的快速約團，或回到這台裝置曾經建立的約團表。</p><b>前往快速約團 →</b></div></a>
    </section>
    ${homeGuideMarkup()}
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
    return { id: item.id, ...item.data(), responseCount: responseSnap.size, responses: responseSnap.docs.map(response => ({ id: response.id, ...response.data() })) };
  }));
  return result.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

function scheduleRow(item) {
  const created = item.createdAt?.toDate?.();
  const createdText = created ? new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" }).format(created) : "建立時間不明";
  const lockedCount = Object.keys(item.lockedDates || {}).length;
  return `<article class="quick-admin-row" data-search="${escapeHtml(`${item.title || ""} ${item.coordinatorName || ""} ${item.gmName || ""}`.toLowerCase())}">
    <div class="quick-admin-row-main">
      <div class="badges"><span class="badge system">${Number(item.responseCount || 0)} 人填寫</span><span class="badge open">成團門檻 ${Number(item.minPlayers || 1)} 人</span>${lockedCount ? `<span class="badge hidden">🔒 ${lockedCount} 天不開放</span>` : ""}</div>
      <h3>${escapeHtml(item.title || "未命名約團")}</h3>
      <p>建立者：${escapeHtml(item.coordinatorName || "未填")}・GM：${escapeHtml(item.gmName || "未定")}<br>${createdText}</p>
    </div>
    <div class="quick-admin-actions">
      <a class="button secondary" href="./quick.html#quick=${item.id}" target="_blank" rel="noreferrer">查看約團</a>
      <button class="button manage-quick-admin" data-id="${item.id}" type="button">管理</button>
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
  list.querySelectorAll(".manage-quick-admin").forEach(button => {
    button.onclick = () => openManageSchedule(schedules.find(item => item.id === button.dataset.id));
  });
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
        <div class="panel-title"><div><h2>所有快速約團</h2><p>集中查看與管理目前的約團表，可直接修改設定與不開放日期。</p></div></div>
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

function openManageSchedule(schedule) {
  if (!schedule || !role || !user || user.isAnonymous) return;
  const lockedDates = new Set(Object.keys(schedule.lockedDates || {}));
  const today = new Date();
  let cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  const periods = schedule.periods || {};
  const responseRows = schedule.responses || [];
  const assignedGMIds = new Set(responseRows.filter(response => response.isGM === true).map(response => response.id));
  const dialog = document.createElement("dialog");
  dialog.className = "admin-edit-dialog";
  dialog.innerHTML = `<form class="admin-edit-card" id="admin-edit-form">
    <div class="admin-edit-head"><div><span class="eyebrow">MANAGEMENT</span><h2>管理快速約團</h2><p>修改後會直接套用到玩家看到的約團表。</p></div><button class="icon-button" type="button" data-close aria-label="關閉">×</button></div>
    <label>團務名稱<input name="title" maxlength="80" value="${escapeHtml(schedule.title || "")}" required></label>
    <div class="admin-edit-grid"><label>建立者／統計者<input name="coordinatorName" maxlength="40" value="${escapeHtml(schedule.coordinatorName || "")}" required></label><label>實際 GM<input name="gmName" maxlength="40" value="${escapeHtml(schedule.gmName || "")}" placeholder="尚未確定可留白"></label></div>
    <label>給玩家的聯絡方式（選填）<input name="contact" maxlength="120" value="${escapeHtml(schedule.contact || "")}"></label>
    <label>給玩家的說明<textarea name="note" maxlength="800">${escapeHtml(schedule.note || "")}</textarea></label>
    <div class="admin-edit-grid"><label>最低成團人數<input name="minPlayers" type="number" min="1" max="20" value="${Number(schedule.minPlayers || 1)}" required></label><label>最多參加人數（選填）<input name="maxPlayers" type="number" min="1" max="20" value="${schedule.maxPlayers ? Number(schedule.maxPlayers) : ""}" placeholder="不設上限"></label><label>GM 人數上限<input name="maxGMs" type="number" min="1" max="20" value="${Math.min(20, Math.max(1, Number(schedule.maxGMs || 3)))}" required></label></div>
    <section class="admin-gm-section"><div><h3>指定既有填表者為 GM</h3><p class="muted">可替更新前建立的約團表補上 GM；GM 不計入玩家人數。</p></div><div class="admin-gm-list">${responseRows.length ? responseRows.map(response => `<label class="admin-gm-option"><input type="checkbox" name="assignedGM" value="${escapeHtml(response.id)}" ${assignedGMIds.has(response.id) ? "checked" : ""}><span class="${assignedGMIds.has(response.id) ? "admin-gm-badge" : ""}">${escapeHtml(response.playerName || "未命名玩家")}</span></label>`).join("") : '<span class="muted">尚無玩家填表，之後可再回來指定。</span>'}</div></section>
    <div><h3>時段範圍</h3><div class="admin-period-grid"><label>早上<input name="morning" value="${escapeHtml(periods["早上"] || "09:00～12:00")}" required></label><label>下午<input name="afternoon" value="${escapeHtml(periods["下午"] || "13:00～18:00")}" required></label><label>晚上<input name="evening" value="${escapeHtml(periods["晚上"] || "20:30～24:00")}" required></label></div></div>
    <section class="admin-lock-section"><div class="admin-lock-head"><div><h3>不開放日期</h3><small id="admin-lock-count">已設定 ${lockedDates.size} 天</small></div><div class="admin-lock-nav"><button class="mini-button" type="button" data-prev>‹</button><b data-month></b><button class="mini-button" type="button" data-next>›</button></div></div><p class="muted">點日期即可切換鎖定。玩家原本的填寫會保留，但鎖定期間不會計入成團。</p><div data-calendar></div></section>
    <div class="admin-dialog-actions"><button class="button secondary" type="button" data-close>取消</button><button class="button" type="submit">儲存修改</button></div>
  </form>`;
  document.body.append(dialog);

  const drawCalendar = () => {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    dialog.querySelector("[data-month]").textContent = `${y}/${String(m + 1).padStart(2, "0")}`;
    let html = ["一", "二", "三", "四", "五", "六", "日"].map(day => `<div class="admin-weekday">${day}</div>`).join("");
    const first = (new Date(y, m, 1).getDay() + 6) % 7;
    for (let i = 0; i < first; i++) html += "<div></div>";
    const total = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= total; d++) {
      const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const locked = lockedDates.has(date);
      const holiday = holidayFor(date);
      html += `<button class="admin-day ${locked ? "locked" : ""} ${holiday ? "holiday" : ""}" type="button" data-lock-date="${date}" aria-pressed="${locked}"><span>${d}</span><small>${locked ? "🔒 不開放" : escapeHtml(holiday || "")}</small></button>`;
    }
    dialog.querySelector("[data-calendar]").innerHTML = `<div class="admin-calendar">${html}</div>`;
    dialog.querySelector("#admin-lock-count").textContent = `已設定 ${lockedDates.size} 天`;
    dialog.querySelectorAll("[data-lock-date]").forEach(button => {
      button.onclick = () => {
        lockedDates.has(button.dataset.lockDate) ? lockedDates.delete(button.dataset.lockDate) : lockedDates.add(button.dataset.lockDate);
        drawCalendar();
      };
    });
  };

  dialog.querySelector("[data-prev]").onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); drawCalendar(); };
  dialog.querySelector("[data-next]").onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); drawCalendar(); };
  dialog.querySelectorAll("[data-close]").forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());

  dialog.querySelector("#admin-edit-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const saveButton = form.querySelector('button[type="submit"]');
    const minPlayers = Number(form.minPlayers.value);
    const maxPlayers = Number(form.maxPlayers.value || 0);
    const maxGMs = Math.min(20, Math.max(1, Number(form.maxGMs.value) || 3));
    const selectedGMIds = new Set([...form.querySelectorAll('input[name="assignedGM"]:checked')].map(input => input.value));
    if (maxPlayers && maxPlayers < minPlayers) return toast("最多參加人數不能少於最低成團人數。");
    if (selectedGMIds.size > maxGMs) return toast(`目前選了 ${selectedGMIds.size} 位 GM，超過上限 ${maxGMs} 位。`);
    saveButton.disabled = true;
    try {
      const changes = {
        title: form.title.value.trim(),
        coordinatorName: form.coordinatorName.value.trim(),
        gmName: form.gmName.value.trim(),
        contact: form.contact.value.trim(),
        note: form.note.value.trim(),
        minPlayers,
        maxPlayers: maxPlayers || null,
        maxGMs,
        periods: {
          "早上": form.morning.value.trim(),
          "下午": form.afternoon.value.trim(),
          "晚上": form.evening.value.trim()
        },
        lockedDates: Object.fromEntries([...lockedDates].sort().map(date => [date, true])),
        updatedAt: serverTimestamp()
      };
      const batch = writeBatch(db);
      batch.update(doc(db, "quickSchedules", schedule.id), changes);
      responseRows.forEach(response => {
        const nextIsGM = selectedGMIds.has(response.id);
        if ((response.isGM === true) !== nextIsGM) {
          batch.update(doc(db, "quickSchedules", schedule.id, "responses", response.id), { isGM: nextIsGM, updatedAt: serverTimestamp() });
          response.isGM = nextIsGM;
        }
      });
      await batch.commit();
      const index = schedules.findIndex(item => item.id === schedule.id);
      if (index >= 0) schedules[index] = { ...schedules[index], ...changes };
      dialog.close();
      drawScheduleList(document.querySelector("#quick-admin-search")?.value || "");
      toast("約團設定已更新");
    } catch (error) {
      console.error(error);
      toast("儲存失敗，請確認管理員權限。");
      saveButton.disabled = false;
    }
  };

  drawCalendar();
  dialog.showModal();
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
