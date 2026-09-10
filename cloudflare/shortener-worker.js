const ALLOWED_ORIGINS = new Set([
  "https://calendar.gather-party.workers.dev",
  "https://casita3167.github.io"
]);

const jsonHeaders = origin => ({
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://calendar.gather-party.workers.dev",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Cache-Control": "no-store"
});

const jsonResponse = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: jsonHeaders(origin)
});

const escapeHtml = value => String(value || "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);

function validTarget(target, type) {
  try {
    const url = new URL(target);
    const isCurrentSite = url.origin === "https://calendar.gather-party.workers.dev" && url.pathname === "/quick.html";
    const isLegacySite = url.origin === "https://casita3167.github.io" && url.pathname === "/Gather-Party/quick.html";
    if (!isCurrentSite && !isLegacySite) return false;
    return type === "manager"
      ? /^#manage=[A-Za-z0-9]+\.[A-Za-z0-9_-]{24,}$/.test(url.hash)
      : /^#quick=[A-Za-z0-9]+$/.test(url.hash);
  } catch {
    return false;
  }
}

function randomCode(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

async function uniqueCode(env, prefix) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomCode();
    if (!(await env.LINKS.get(`${prefix}:${code}`))) return code;
  }
  throw new Error("無法產生不重複的短網址");
}

function playerPreviewPage(requestUrl, entry) {
  const title = (entry.title || "快速約團").trim().slice(0, 80);
  const description = (entry.description || "打開月曆，填寫你可以跑團的日期與時段。").trim().slice(0, 160);
  const safeTarget = escapeHtml(entry.target);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const canonical = escapeHtml(requestUrl);
  const redirectTarget = JSON.stringify(entry.target).replace(/</g, "\\u003c");
  return new Response(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="https://calendar.gather-party.workers.dev/favicon.svg" type="image/svg+xml">
  <meta http-equiv="refresh" content="0;url=${safeTarget}">
</head>
<body>
  <p>正在開啟「${safeTitle}」⋯</p>
  <p><a href="${safeTarget}">若未自動開啟，請點這裡</a></p>
  <script>location.replace(${redirectTarget});</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    }
  });
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: jsonHeaders(origin) });
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/shorten") {
      if (!ALLOWED_ORIGINS.has(origin)) return jsonResponse({ error: "不允許的來源" }, 403, origin);
      try {
        const body = await request.json();
        const type = body.type === "manager" ? "manager" : "player";
        if (!validTarget(body.target, type)) return jsonResponse({ error: "網址格式不正確" }, 400, origin);
        const prefix = type === "manager" ? "m" : "q";
        const code = await uniqueCode(env, prefix);
        await env.LINKS.put(`${prefix}:${code}`, JSON.stringify({
          target: body.target,
          type,
          title: String(body.title || "").trim().slice(0, 80),
          description: String(body.description || "").trim().slice(0, 160)
        }));
        return jsonResponse({ shortUrl: `${requestUrl.origin}/${prefix}/${code}`, code }, 201, origin);
      } catch (error) {
        console.error(error);
        return jsonResponse({ error: "建立短網址失敗" }, 500, origin);
      }
    }

    if (request.method === "GET") {
      const match = requestUrl.pathname.match(/^\/(q|m)\/([A-Za-z0-9_-]{8,40})$/);
      if (match) {
        const [, prefix, code] = match;
        const stored = await env.LINKS.get(`${prefix}:${code}`);
        if (!stored) return new Response("找不到這個約團連結，可能已失效。", { status: 404 });
        let entry;
        try {
          entry = JSON.parse(stored);
        } catch {
          entry = { target: stored, title: "快速約團" };
        }
        if (!validTarget(entry.target, prefix === "m" ? "manager" : "player")) {
          return new Response("約團連結資料不正確。", { status: 400 });
        }
        if (prefix === "m") return Response.redirect(entry.target, 302);
        return playerPreviewPage(request.url, entry);
      }
      if (requestUrl.pathname === "/") {
        return new Response("Gather Party 短網址服務運作中", {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }
};
