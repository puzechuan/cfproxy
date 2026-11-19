/**
 * Cloudflare Worker · GitHub 反向代理加速
 *
 * 源码文件：src/worker.js（本文件）
 * 部署文件：worker.js（由 npm run build 生成，自包含，可直接粘贴到 Workers 控制台）
 *
 * 用法：https://你的域名/https://github.com/用户/仓库
 *       https://你的域名/?url=https://raw.githubusercontent.com/...
 */

// 静态页面在构建时由 index.html 注入；本地直接运行时为空串，请以 worker.js 为准
const UI_HTML = "__UI_HTML__";

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

// 回包中需要移除的头：内容改写后长度/编码已失效
const RESP_SKIP = new Set([
  "set-cookie", "content-encoding", "content-length",
  "transfer-encoding", "connection", "keep-alive", "upgrade", "cf-ray",
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
]);

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

async function buildResponse(upstream, target, base) {
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!RESP_SKIP.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");

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

  // 3xx 里常带签名下载链接（GitHub Release 等），缓存会导致链接过期或跳错域名
  if (upstream.status >= 300 && upstream.status < 400) {
    headers.set("Cache-Control", "no-store");
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

  // 二进制内容（git 协议、压缩包、图片）直接流式透传，保留 206 / Content-Range
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/* ---------------------------------- 入口 ---------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = publicBase(request, url);
    const path = url.pathname || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (path === "/health") {
      return json({ ok: true, service: "cfproxy", time: new Date().toISOString() });
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
      return json(
        {
          error: probe.error,
          hint: "正确格式：" + base + "/https://github.com/用户/仓库",
        },
        400
      );
    }

    const target = probe.target;
    const init = {
      method: request.method,
      headers: upstreamHeaders(request),
      redirect: "manual", // 由自己重写 Location，避免浏览器直连源站
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    if ((request.method === "GET" || request.method === "HEAD") && isCacheable(target)) {
      init.cf = {
        cacheEverything: true,
        cacheTtlByStatus: {
          "200-299": 86400,
          "301,302": 0,
          "404": 300,
          "500-599": 0,
        },
      };
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      return json({ error: "上游请求失败", detail: String(e) }, 502);
    }
    return buildResponse(upstream, target, base);
  },
};
