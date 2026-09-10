import { githubConfig } from "./github-config.js";

const root = document.querySelector("#app");
const toastNode = document.querySelector("#toast");
const API = `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}`;
const REPO_URL = `https://github.com/${githubConfig.owner}/${githubConfig.repo}`;
const DAYPARTS = {
  "全天": "整天皆可",
  "早上": "08:00～12:00",
  "下午": "14:00～18:00",
  "晚上": "20:00～24:00",
  "時間由GM決定": "由 GM 決定實際時間"
};

let monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let adventures = [];
let issues = [];
let lastUpdated = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove("show"), 2200);
}

async function githubFetch(path) {
  const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    headers: { Accept: "application/vnd.github+json" }
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 403 && remaining === "0") throw new Error("GitHub API 的訪客讀取額度暫時用完了，請稍後再試。");
    if (response.status === 404) throw new Error("找不到 GitHub 資料，請確認倉庫與資料夾設定。");
    throw new Error(`GitHub 讀取失敗（${response.status}）`);
  }
  return response.json();
}

function decodeBase64(value) {
  const bytes = Uint8Array.from(atob(value.replace(/\n/g, "")), char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseScalar(value = "") {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  if (clean === "true") return true;
  if (clean === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(clean)) return Number(clean);
  return clean;
}

function parseFrontMatter(markdown, path) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)$/);
  if (!match) return null;
  const data = {};
  let parent = null;
  match[1].split(/\r?\n/).forEach(line => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const nested = line.match(/^\s{2,}([\w-]+):\s*(.*)$/);
    if (nested && parent) {
      data[parent][nested[1]] = parseScalar(nested[2]);
      return;
    }
    const field = line.match(/^([\w-]+):\s*(.*)$/);
    if (!field) return;
    parent = field[2] ? null : field[1];
    data[field[1]] = field[2] ? parseScalar(field[2]) : {};
  });
  if (!data.title || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ""))) return null;
  return { ...data, body: match[2].trim(), path };
}

async function loadAdventures() {
  let files;
  try {
    files = await githubFetch(`/contents/${githubConfig.adventuresDirectory}?ref=${encodeURIComponent(githubConfig.branch)}`);
  } catch (error) {
    if (String(error.message).includes("找不到")) return [];
    throw error;
  }
  const markdownFiles = files.filter(file => file.type === "file" && file.name.toLowerCase().endsWith(".md"));
  const records = await Promise.all(markdownFiles.map(async file => {
    const detail = await githubFetch(`/contents/${file.path}?ref=${encodeURIComponent(githubConfig.branch)}`);
    return parseFrontMatter(decodeBase64(detail.content), file.path);
  }));
  return records.filter(Boolean).sort((a, b) => `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`));
}

function parseIssueSlots(body = "") {
  const slots = [];
  const lines = body.split(/\r?\n/);
  lines.forEach(line => {
    if (!line.includes("|")) return;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length < 2 || cells.every(cell => /^:?-+:?$/.test(cell))) return;
    const dateCell = cells[0].replace(/[`*_]/g, "").trim();
    const periodCell = cells[1].replace(/[`*_]/g, "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateCell) || !DAYPARTS[periodCell]) return;
    slots.push({ key: `${dateCell}|${periodCell}`, date: dateCell, period: periodCell });
  });
  return [...new Map(slots.map(slot => [slot.key, slot])).values()];
}

function normalizeVote(value = "") {
  const clean = value.toUpperCase().replace(/[✅⭕]/g, "O").replace(/[❌✕]/g, "X").trim();
  if (/^(O|OK|可|可以)$/.test(clean)) return "O";
  if (/^(▲|△|候補|可能)$/.test(clean)) return "▲";
  if (/^(X|NO|不行|不可)$/.test(clean)) return "X";
  return null;
}

function parseCommentVotes(body = "", slots = []) {
  const result = new Map();
  body.split(/\r?\n/).forEach(line => {
    if (!line.includes("|")) return;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length < 2 || cells.every(cell => /^:?-+:?$/.test(cell))) return;
    const date = cells[0].replace(/[`*_]/g, "").trim();
    const period = cells[1]?.replace(/[`*_]/g, "").trim();
    const byKey = slots.find(slot => slot.key === `${date}|${period}`);
    const vote = normalizeVote(cells.at(-1));
    if (byKey && vote) result.set(byKey.key, vote);
  });
  return result;
}

async function loadIssues() {
  const query = new URLSearchParams({ state: "open", per_page: "50", sort: "updated", direction: "desc" });
  const raw = await githubFetch(`/issues?${query}`);
  const issueOnly = raw.filter(item => !item.pull_request && (
    item.labels.some(label => label.name === githubConfig.schedulingLabel) || item.title.startsWith("[揪團]")
  )).slice(0, 20);
  return Promise.all(issueOnly.map(async issue => {
    const slots = parseIssueSlots(issue.body || "");
    let comments = [];
    if (issue.comments) comments = await githubFetch(`/issues/${issue.number}/comments?per_page=100`);
    const voterMap = new Map();
    comments.forEach(comment => {
      const votes = parseCommentVotes(comment.body || "", slots);
      if (!votes.size) return;
      const previous = voterMap.get(comment.user.login);
      voterMap.set(comment.user.login, {
        login: comment.user.login,
        avatar: comment.user.avatar_url,
        url: comment.html_url,
        votes: new Map([...(previous?.votes || []), ...votes])
      });
    });
    const voters = [...voterMap.values()];
    const intersections = slots.map(slot => {
      const votes = voters.map(voter => ({ login: voter.login, vote: voter.votes.get(slot.key) || "未填" }));
      const perfect = voters.length > 0 && votes.every(item => item.vote === "O");
      const possible = voters.length > 0 && votes.every(item => item.vote === "O" || item.vote === "▲");
      return { ...slot, votes, perfect, possible };
    });
    return { ...issue, slots, voters, intersections };
  }));
}

function statusInfo(status = "待協調") {
  const value = String(status).trim();
  if (["已成團", "成團", "confirmed"].includes(value)) return { key: "confirmed", label: "已成團" };
  if (["有人請假", "請假", "cancelled"].includes(value)) return { key: "leave", label: "有人請假" };
  return { key: "pending", label: value || "待協調" };
}

function renderHeader() {
  return `<header class="brandbar"><a class="brand" href="#"><span class="brandmark" aria-hidden="true">⚄</span><span>Gather Party<small>用 GitHub 把團員湊在一起</small></span></a><nav><a href="#recruiting">時間協調</a><a href="#calendar-section">正式場次</a><button class="button secondary compact" id="refresh" type="button">重新整理</button></nav></header>`;
}

function renderIssueCard(issue) {
  const perfect = issue.intersections.filter(slot => slot.perfect);
  const possible = issue.intersections.filter(slot => !slot.perfect && slot.possible);
  const highlights = perfect.length ? perfect : possible;
  const stateClass = perfect.length ? "perfect" : possible.length ? "possible" : "waiting";
  const headline = perfect.length ? "找到全員都有空的時間" : possible.length ? "找到可協調的候選時間" : "等待更多玩家填寫";
  return `<article class="issue-card ${stateClass}">
    <div class="issue-top"><div><span class="issue-number">ISSUE #${issue.number}</span><h3>${escapeHtml(issue.title)}</h3></div><span class="state-badge">${headline}</span></div>
    <p class="issue-meta">${issue.voters.length} 人已回覆・${issue.slots.length} 個候選時段</p>
    ${highlights.length ? `<div class="highlight-list">${highlights.map(slot => `<div class="highlight-slot"><span>${slot.perfect ? "✓ 完美交集" : "▲ 候選"}</span><b>${escapeHtml(slot.date)}・${escapeHtml(slot.period)}</b><small>${escapeHtml(DAYPARTS[slot.period])}</small></div>`).join("")}</div>` : `<div class="empty-state small">目前還沒有共同時段；玩家可到 Issue 留言填寫。</div>`}
    ${issue.voters.length ? `<div class="voters" aria-label="已回覆玩家">${issue.voters.map(voter => `<img src="${escapeHtml(voter.avatar)}" alt="${escapeHtml(voter.login)}" title="${escapeHtml(voter.login)}">`).join("")}</div>` : ""}
    <a class="button" href="${escapeHtml(issue.html_url)}" target="_blank" rel="noreferrer">前往填寫時間 <span aria-hidden="true">↗</span></a>
  </article>`;
}

function monthCells() {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="calendar-day outside" aria-hidden="true"></div>');
  for (let day = 1; day <= days; day++) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const records = adventures.filter(item => item.date === date);
    cells.push(`<section class="calendar-day"><span class="day-number">${day}</span><div class="day-events">${records.map(item => {
      const status = statusInfo(item.status);
      return `<button class="event-chip ${status.key}" type="button" data-path="${escapeHtml(item.path)}"><span>${escapeHtml(item.time || "時間未定")}</span>${escapeHtml(item.title)}</button>`;
    }).join("")}</div></section>`);
  }
  while (cells.length % 7) cells.push('<div class="calendar-day outside" aria-hidden="true"></div>');
  return cells.join("");
}

function renderAdventureList() {
  if (!adventures.length) return '<div class="empty-state">目前還沒有正式場次。GM 可在 <code>adventures/</code> 新增 Markdown 檔案。</div>';
  return adventures.map(item => {
    const status = statusInfo(item.status);
    const links = item.links || {};
    return `<article class="adventure-row" data-record="${escapeHtml(item.path)}"><time datetime="${escapeHtml(item.date)}"><b>${escapeHtml(item.date.slice(8))}</b><span>${escapeHtml(item.date.slice(0, 7))}</span></time><div class="adventure-main"><div><span class="status ${status.key}">${escapeHtml(status.label)}</span><span class="system">${escapeHtml(item.system || "TRPG")}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.time || "時間未定")}${item.gm ? `・GM ${escapeHtml(item.gm)}` : ""}</p></div><div class="adventure-links">${links.character ? `<a href="${escapeHtml(links.character)}" target="_blank" rel="noreferrer">角色卡</a>` : ""}${links.discord ? `<a href="${escapeHtml(links.discord)}" target="_blank" rel="noreferrer">Discord</a>` : ""}${links.ccfolia ? `<a href="${escapeHtml(links.ccfolia)}" target="_blank" rel="noreferrer">ccfolia</a>` : ""}${links.fvtt ? `<a href="${escapeHtml(links.fvtt)}" target="_blank" rel="noreferrer">FVTT</a>` : ""}<a href="${REPO_URL}/blob/${githubConfig.branch}/${escapeHtml(item.path)}" target="_blank" rel="noreferrer">詳細資料</a></div></article>`;
  }).join("");
}

function render() {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth() + 1;
  const issueUrl = `${REPO_URL}/issues/new?template=group-scheduling.md`;
  root.innerHTML = `<main class="shell">${renderHeader()}
    <section class="hero"><div><span class="eyebrow">TRPG SCHEDULING HUB</span><h1>團務不再沉進<br><span>聊天室的訊息海。</span></h1><p>開一張 Issue 協調大家的時間；確定後，用一份 Markdown 留下這場冒險需要的一切。</p><div class="hero-actions"><a class="button" href="${issueUrl}" target="_blank" rel="noreferrer">＋ 發起揪團 Issue</a><a class="button secondary" href="${REPO_URL}/new/${githubConfig.branch}/${githubConfig.adventuresDirectory}" target="_blank" rel="noreferrer">新增正式場次</a></div></div><div class="hero-note"><span>快速圖例</span><dl><div><dt>全天</dt><dd>整天皆可</dd></div><div><dt>早上</dt><dd>08:00～12:00</dd></div><div><dt>下午</dt><dd>14:00～18:00</dd></div><div><dt>晚上</dt><dd>20:00～24:00</dd></div><div><dt>GM 決定</dt><dd>由 GM 安排</dd></div></dl></div></section>
    <section id="recruiting" class="section"><div class="section-head"><div><span class="eyebrow">OPEN ISSUES</span><h2>招募與時間協調</h2></div><p>全員填 O 會顯示綠色完美交集；O 與 ▲ 混合則列為候選。</p></div><div class="issue-grid">${issues.length ? issues.map(renderIssueCard).join("") : '<div class="empty-state">目前沒有標記「揪團」的公開 Issue。</div>'}</div></section>
    <section id="calendar-section" class="section"><div class="section-head calendar-heading"><div><span class="eyebrow">ADVENTURE CALENDAR</span><h2>正式場次日曆</h2></div><div class="calendar-nav"><button class="button secondary compact" id="prev-month" type="button" aria-label="上個月">‹</button><button class="button secondary compact" id="today" type="button">今天</button><button class="button secondary compact" id="next-month" type="button" aria-label="下個月">›</button></div></div><div class="calendar-card"><h3>${year} 年 ${month} 月</h3><div class="calendar-scroll"><div class="calendar"><div class="weekday">一</div><div class="weekday">二</div><div class="weekday">三</div><div class="weekday">四</div><div class="weekday">五</div><div class="weekday weekend">六</div><div class="weekday weekend">日</div>${monthCells()}</div></div></div><div class="adventure-list">${renderAdventureList()}</div></section>
    <footer>資料來自 <a href="${REPO_URL}" target="_blank" rel="noreferrer">${escapeHtml(githubConfig.owner)}/${escapeHtml(githubConfig.repo)}</a>${lastUpdated ? `・更新於 ${lastUpdated.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}` : ""}</footer>
  </main>`;
  document.querySelector("#refresh").addEventListener("click", () => load(true));
  document.querySelector("#prev-month").addEventListener("click", () => { monthCursor = new Date(year, month - 2, 1); render(); });
  document.querySelector("#next-month").addEventListener("click", () => { monthCursor = new Date(year, month, 1); render(); });
  document.querySelector("#today").addEventListener("click", () => { monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); render(); });
  document.querySelectorAll(".event-chip").forEach(button => button.addEventListener("click", () => document.querySelector(`[data-record="${CSS.escape(button.dataset.path)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })));
}

function renderError(error) {
  root.innerHTML = `<main class="error-screen"><span class="brandmark">⚄</span><h1>暫時讀不到團務資料</h1><p>${escapeHtml(error.message)}</p><button class="button" id="retry" type="button">再試一次</button><a href="${REPO_URL}" target="_blank" rel="noreferrer">直接前往 GitHub</a></main>`;
  document.querySelector("#retry").addEventListener("click", () => load(true));
}

async function load(manual = false) {
  if (manual) toast("正在重新整理 GitHub 資料⋯");
  try {
    [adventures, issues] = await Promise.all([loadAdventures(), loadIssues()]);
    lastUpdated = new Date();
    render();
    if (manual) toast("已取得最新資料");
  } catch (error) {
    console.error(error);
    renderError(error);
  }
}

load();
