/**
 * Cloudflare Worker · GitHub 反向代理加速
 *
 * 用法：https://你的域名/https://github.com/用户/仓库
 *       https://你的域名/?url=https://raw.githubusercontent.com/...
 *
 * 设计要点：
 * 1. 普通页面：手动处理重定向并重写 Location，保证链接不跳出代理域名。
 * 2. 下载资源（Release / latest / codeload / 对象存储）：Worker 内部跟随重定向，
 *    浏览器始终只看到干净的原始代理链接，绝不暴露带签名的临时 URL。
 * 3. 下载资源使用稳定 cacheKey（剥离每次都变的签名查询串），
 *    边缘缓存可以真正命中，重复下载由 CF 边缘直接返回。
 * 4. 成功的下载响应允许浏览器缓存，二次下载连 Worker 都不经过。
 * 5. 二进制响应保留 Content-Length / Accept-Ranges / Content-Range，支持断点续传。
 * 6. 全链路结构化日志，可在 Workers Logs（Observability）中查询。
 */

// 静态页面在构建时由 index.html 注入；本地直接运行时为空串，请以部署版本为准
const UI_HTML = "__UI_HTML__";

// 用于线上确认部署版本（/health 中返回）
const BUILD_ID = "2026-11-19.2";

// 允许代理的源站，防止被当作开放代理滥用
const ALLOWED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "avatars.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "githubusercontent.com",
  "user-images.githubusercontent.com",
  "github.io",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "assets.githubusercontent.com",
]);
const HOST_LIST = Array.from(ALLOWED_HOSTS).sort((a, b) => b.length - a.length);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 不应转发给源站的 hop-by-hop / Cloudflare 内部头
const REQ_SKIP = new Set([
  "host", "connection", "keep-alive", "proxy-connection",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "cookie", "accept-encoding",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "cf-worker", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port", "x-forwarded-server",
]);

// 回包中必须移除的 hop-by-hop / 内部头。
// content-length / content-encoding 对二进制透传是有意义的，只在文本改写时删除。
const RESP_SKIP = new Set([
  "set-cookie", "transfer-encoding", "connection", "keep-alive",
  "upgrade", "cf-ray",
]);

const STATIC_EXT =
  /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|map|pdf|zip|tar|gz|bz2|xz|7z|dmg|exe|deb|rpm|whl)$/i;

const CACHEABLE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "avatars.githubusercontent.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "user-images.githubusercontent.com",
  "githubusercontent.com",
  "assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const ASSET_HOSTS = new Set([
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "assets.githubusercontent.com",
]);
// /releases/download/<tag>/<file> 之外，/releases/latest/download/<file> 也会 302 到签名地址
const RELEASE_DOWNLOAD = /\/releases\/(?:latest\/)?download\//i;

/* ---------------------------------- 工具 ---------------------------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=UTF-8" },
      corsHeaders()
    ),
  });
}

function uiResponse() {
  return new Response(UI_HTML, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slashEscape(s) {
  return s.replace(/\//g, "\\/");
}

/** 结构化日志：Workers Logs 会按字段建立索引，便于按事件/状态过滤 */
function logEvent(event, fields) {
  try {
    console.log(Object.assign({ event, ts: new Date().toISOString() }, fields || {}));
  } catch (e) {
    /* 日志失败不影响代理 */
  }
}

/** 签名链接含凭据，日志中只保留路径 */
function safeUrl(target) {
  const u = new URL(target.toString());
  if (u.searchParams.has("sig") || u.searchParams.has("jwt")) {
    u.search = "?<redacted>";
  }
  return u.toString();
}

/* ------------------------------ 目标 URL 解析 ------------------------------ */

function extractTarget(request) {
  const url = new URL(request.url);
  let raw = "";
  const path = url.pathname || "/";

  if (path !== "/") {
    try {
      raw = decodeURIComponent(path.replace(/^\/+/, ""));
    } catch (e) {
      return { error: "路径解码失败" };
    }
  }
  if (!raw && url.searchParams.has("url")) {
    raw = url.searchParams.get("url");
  }
  if (!raw) return null; // 根路径：交给静态页面

  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return { error: "无法解析目标 URL：" + raw };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { error: "仅支持 http/https 协议" };
  }
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return { error: "域名不在白名单中：" + target.hostname };
  }

  // 形如 /https://github.com/x?tab=readme 的查询串应透传给源站
  if (!target.search && url.search && !url.searchParams.has("url")) {
    target.search = url.search;
  }
  return { target };
}

/**
 * 代理地址优先取请求的 Host，而不是 url.origin。
 * 自定义域名经 CNAME/内部路由进入 Worker 时，url.origin 可能是 workers.dev，
 * 会导致生成的 Location 跳回 workers.dev。
 */
function publicBase(request, url) {
  const host = request.headers.get("host");
  if (host && !host.toLowerCase().endsWith(".workers.dev")) {
    return url.protocol + "//" + host;
  }
  return url.origin;
}

/** 重定向使用相对路径，浏览器会按当前访问域名解析，避免跨域跳转 */
function toProxyPath(absolute) {
  try {
    const u = new URL(absolute);
    if (u.protocol !== "https:" && u.protocol !== "http:") return absolute;
    return "/" + u.toString();
  } catch (e) {
    return absolute;
  }
}

/* ------------------------------ 下载资源判定 ------------------------------ */

function isDownloadAsset(target) {
  const host = target.hostname.toLowerCase();
  if (ASSET_HOSTS.has(host)) return true;
  if ((host === "github.com" || host === "www.github.com") &&
      RELEASE_DOWNLOAD.test(target.pathname)) return true;
  return STATIC_EXT.test(target.pathname);
}

/**
 * 稳定缓存键：签名查询串每次请求都不同，必须剥离，否则缓存永远无法命中。
 * github.com 的原始下载地址本身稳定，可以连同查询串一起作为键。
 */
function assetCacheKey(target) {
  const host = target.hostname.toLowerCase();
  // 这些对象的查询串是一次性签名，参与键会让缓存永远 MISS
  if (host === "release-assets.githubusercontent.com" ||
      host === "github-releases.githubusercontent.com" ||
      host === "objects.githubusercontent.com" ||
      host === "assets.githubusercontent.com") {
    return "cfproxy:asset:" + host + target.pathname;
  }
  return "cfproxy:asset:" + host + target.pathname + target.search;
}

/* ------------------------------ 内容链接重写 ------------------------------ */

/** 重写文本中的绝对 URL、JSON 里的转义 URL、协议相对 URL */
function rewriteUrls(text, base) {
  let out = text;

  for (const host of HOST_LIST) {
    for (const scheme of ["https", "http"]) {
      const target = scheme + "://" + host;
      const replacement = base + "/https://" + host;
      // JSON 中常见 "https:\/\/github.com"
      out = out.split(slashEscape(target)).join(slashEscape(replacement));
      // 普通绝对 URL
      out = out.split(target).join(replacement);
    }
  }

  // 协议相对 URL：//github.com/... （负向后顾避免误伤刚插入的 https://）
  const pattern = HOST_LIST.map(escapeRegExp).join("|");
  out = out.replace(
    new RegExp("(?<!:)\\/\\/(" + pattern + ")", "g"),
    function (match, host) {
      return base + "/https://" + host;
    }
  );
  return out;
}

/** HTML 额外处理根相对路径，并注入 base 标签 */
function rewriteHtml(text, base, host) {
  let out = rewriteUrls(text, base);
  const prefix = base + "/https://" + host;

  if (host === "github.com" || host === "www.github.com" || host === "gist.github.com") {
    out = out.replace(
      /(\s(?:href|src|action|poster|data-src|data-href|data-url|data-target)\s*=\s*["'])\/(?!\/)/gi,
      function (match, attr) {
        return attr + prefix + "/";
      }
    );
  }

  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, function (match, attrs) {
      return '<head' + attrs + '><base href="' + prefix + '/">';
    });
  }
  return out;
}

/* -------------------------------- 请求 / 回包 ------------------------------- */

function upstreamHeaders(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!REQ_SKIP.has(key.toLowerCase())) headers.set(key, value);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);
  return headers;
}

function isCacheable(target) {
  if (CACHEABLE_HOSTS.has(target.hostname)) return true;
  if (target.hostname === "github.com" && STATIC_EXT.test(target.pathname)) return true;
  return false;
}

async function buildResponse(upstream, target, base, options = {}) {
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!RESP_SKIP.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");

  // Release 资产内容不可变，允许浏览器缓存一天：二次下载连 Worker 都不经过。
  // 重定向与文本页面仍禁止缓存，避免旧签名链接残留在浏览器缓存里。
  const cacheableAsset =
    options.asset && upstream.status >= 200 && upstream.status < 300;
  headers.set(
    "Cache-Control",
    cacheableAsset ? "public, max-age=86400" : "no-store"
  );

  // 重定向地址必须指回代理，否则浏览器会直连 GitHub
  const location = upstream.headers.get("location");
  if (location) {
    let resolved = location;
    try {
      resolved = new URL(location, target).toString();
    } catch (e) {
      /* 保留原值 */
    }
    headers.set("Location", toProxyPath(resolved));
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const shouldRewrite =
    upstream.status >= 200 &&
    upstream.status < 400 &&
    upstream.body &&
    (contentType.includes("text/html") ||
      contentType.includes("json") ||
      contentType.includes("javascript") ||
      contentType.includes("ecmascript"));

  if (shouldRewrite) {
    // 改写后长度与编码都失效
    headers.delete("content-length");
    headers.delete("content-encoding");
    let text = await upstream.text();
    text = contentType.includes("text/html")
      ? rewriteHtml(text, base, target.hostname)
      : rewriteUrls(text, base);
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // 二进制内容（git 协议、压缩包、图片）流式透传，保留 206 / Content-Range / Content-Length
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

const CACHE_TTL = {
  "200-299": 86400,
  "404": 300,
  "500-599": -1,
};

/**
 * Range 请求只会让边缘缓存记住这一段，不同区间依然回源。
 * 在后台拉取完整对象（按块丢弃，不占用内存），把完整文件写进边缘缓存，
 * 之后任意区间都能命中。失败不影响已返回给客户端的响应。
 */
const inFlightWarms = new Set();

async function warmFullAsset(target, headers, cacheCf, key) {
  // 多线程下载器会并发发来多个 Range MISS。若每个都触发一次完整回源，
  // 重复流量会把带宽吃光，反而比不预热更慢。同一对象只预热一次。
  if (inFlightWarms.has(key)) {
    logEvent("warm_skip", { url: safeUrl(target), reason: "in_flight" });
    return;
  }
  inFlightWarms.add(key);
  try {
    const warmHeaders = new Headers(headers);
    for (const name of [
      "range", "if-range", "if-none-match", "if-match",
      "if-modified-since", "if-unmodified-since", "cache-control", "pragma",
    ]) {
      warmHeaders.delete(name);
    }
    const upstream = await fetch(
      new Request(target.toString(), {
        method: "GET",
        headers: warmHeaders,
        redirect: "follow",
        cf: cacheCf,
      })
    );
    logEvent("warm", {
      url: safeUrl(target),
      status: upstream.status,
      cache: upstream.headers.get("cf-cache-status"),
      length: upstream.headers.get("content-length"),
    });
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  } catch (e) {
    logEvent("warm_error", { url: safeUrl(target), error: String(e) });
  } finally {
    inFlightWarms.delete(key);
  }
}

/* ---------------------------------- 入口 ---------------------------------- */

async function handleRequest(request, env, ctx) {
  const started = Date.now();
  const url = new URL(request.url);
  const base = publicBase(request, url);
  const path = url.pathname || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (path === "/health") {
    return json({
      ok: true,
      service: "cfproxy",
      build: BUILD_ID,
      time: new Date().toISOString(),
    });
  }
  if (path === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }
  if ((path === "/" || path === "/index.html") && !url.searchParams.has("url")) {
    return uiResponse();
  }

  const probe = extractTarget(request);
  if (!probe) return uiResponse();
  if (probe.error) {
    logEvent("bad_target", { error: probe.error });
    return json(
      {
        error: probe.error,
        hint: "正确格式：" + base + "/https://github.com/用户/仓库",
      },
      400
    );
  }

  const target = probe.target;
  const method = request.method;
  const isRead = method === "GET" || method === "HEAD";
  const asset = isRead && isDownloadAsset(target);
  const cacheKey = asset ? assetCacheKey(target) : null;

  logEvent("request", {
    method,
    url: safeUrl(target),
    asset,
    colo: request.cf && request.cf.colo,
    country: request.cf && request.cf.country,
    range: isRead ? request.headers.get("range") : null,
  });

  const headers = upstreamHeaders(request);
  const assetCacheCf = asset
    ? {
        cacheKey,
        cacheEverything: true,
        cacheTtlByStatus: Object.assign({}, CACHE_TTL, { "301,302": 0 }),
      }
    : null;
  let upstream;
  try {
    if (asset) {
      // 服务端跟随重定向：浏览器只访问干净链接，缓存键稳定，少一次完整往返。
      const subRequest = new Request(target.toString(), {
        method,
        headers,
        redirect: "follow",
        cf: assetCacheCf,
      });
      upstream = await fetch(subRequest);
    } else {
      const init = {
        method,
        headers,
        redirect: "manual", // 由自己重写 Location，避免浏览器直连源站
      };
      if (!isRead) {
        init.body = request.body;
        init.duplex = "half";
      }
      if (isRead && isCacheable(target)) {
        init.cf = { cacheEverything: true, cacheTtlByStatus: CACHE_TTL };
      }
      upstream = await fetch(target.toString(), init);
    }
  } catch (e) {
    logEvent("upstream_error", {
      url: safeUrl(target),
      error: String(e),
      ms: Date.now() - started,
    });
    return json({ error: "上游请求失败", detail: String(e) }, 502);
  }

  logEvent("upstream", {
    url: safeUrl(target),
    status: upstream.status,
    cache: upstream.headers.get("cf-cache-status"),
    ms: Date.now() - started,
    asset,
    cacheKey: cacheKey || undefined,
  });

  // Range 未命中时后台预热完整对象，后续任意区间都能走边缘缓存
  if (asset && method === "GET" && request.headers.has("range")) {
    const cacheStatus = upstream.headers.get("cf-cache-status") || "";
    if (!/HIT|STALE|REVALIDATED/i.test(cacheStatus)) {
      ctx.waitUntil(warmFullAsset(target, headers, assetCacheCf, cacheKey));
    }
  }

  const response = await buildResponse(upstream, target, base, { asset });
  logEvent("respond", {
    url: safeUrl(target),
    status: response.status,
    length: response.headers.get("content-length"),
    cache: response.headers.get("cf-cache-status"),
    ms: Date.now() - started,
  });
  return response;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      logEvent("internal_error", { error: String(e) });
      return json({ error: "代理内部错误", detail: String(e) }, 500);
    }
  },
};
