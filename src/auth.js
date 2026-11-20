/**
 * 用户系统：注册 / 登录 / 会话 / 管理员接口
 *
 * 安全要点：
 * 1. 密码用 PBKDF2-SHA256 + 随机盐派生 32 字节，只存哈希与盐，不存明文。
 * 2. 会话是无状态 HMAC-SHA256 签名 Cookie；每次请求按 uid 回查数据库，
 *    因此「禁用账号 / 调整角色」立即生效，不必等 Cookie 过期。
 * 3. 签名密钥在首次使用时生成并落入 D1 settings 表，模块级缓存；
 *    INSERT OR IGNORE 保证多 isolate 并发时共享同一把密钥。
 * 4. 服务端配置的管理员用户名必须用邀请码注册，别人无法抢注。
 */

const COOKIE = "cfproxy_session";
const SESSION_TTL = 7 * 24 * 3600; // 7 天
const ITERATIONS = 100000;

/* ------------------------------- 编码工具 ------------------------------- */

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      extraHeaders
    ),
  });
}

/* ------------------------------ 签名密钥 -------------------------------- */

let cachedSecret = null;

async function getSecret(env) {
  if (cachedSecret) return cachedSecret;
  const existing = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'session_secret'"
  ).first();
  if (existing) {
    cachedSecret = existing.value;
    return cachedSecret;
  }
  const secret = randomHex(32);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES('session_secret', ?)"
  )
    .bind(secret)
    .run();
  // 并发写入时以库中已存在的值为准，保证所有 isolate 一致
  const committed = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'session_secret'"
  ).first();
  cachedSecret = committed ? committed.value : secret;
  return cachedSecret;
}

/* ------------------------------ 密码派生 -------------------------------- */

async function deriveHash(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return b64urlEncode(new Uint8Array(bits));
}

async function verifyPassword(password, saltB64, hashB64) {
  try {
    const computed = await deriveHash(password, b64urlDecode(saltB64));
    return timingSafeEqual(computed, hashB64);
  } catch (e) {
    return false;
  }
}

/* ------------------------------ 会话令牌 -------------------------------- */

async function hmacKey(secretHex) {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(user, secretHex) {
  const payload = {
    uid: user.id,
    u: user.username,
    r: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
  };
  const body = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const sig = b64urlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secretHex),
        new TextEncoder().encode(body)
      )
    )
  );
  return body + "." + sig;
}

async function verifySession(token, secretHex) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const sig = b64urlDecode(parts[1]);
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secretHex),
      sig,
      new TextEncoder().encode(parts[0])
    );
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(parts[0]))
    );
    if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === "https:" ? "Secure; " : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

/* ---------------------------- 当前用户解析 ------------------------------ */

/** 返回当前登录用户（已回查数据库、确认未禁用），否则 null */
export async function getUser(request, env) {
  const token = parseCookie(request.headers.get("cookie"), COOKIE);
  if (!token) return null;
  const secret = await getSecret(env);
  const payload = await verifySession(token, secret);
  if (!payload || !payload.uid) return null;
  const user = await env.DB.prepare(
    "SELECT id, username, role, disabled FROM users WHERE id = ?"
  )
    .bind(payload.uid)
    .first();
  if (!user || user.disabled) return null;
  return user;
}

/* ------------------------------ 注册 / 登录 ----------------------------- */

function validUsername(username) {
  return /^[A-Za-z0-9_.-]{3,32}$/.test(username || "");
}

function isAdminName(env, username) {
  const list = (env.ADMIN_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(username.toLowerCase());
}

async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const username = (body.username || "").trim();
  const password = body.password || "";

  if (!validUsername(username)) {
    return json(
      { ok: false, error: "用户名需为 3-32 位字母、数字、点、下划线或连字符" },
      400
    );
  }
  if (typeof password !== "string" || password.length < 8) {
    return json({ ok: false, error: "密码至少 8 位" }, 400);
  }

  const admin = isAdminName(env, username);
  if (admin) {
    // 管理员用户名需邀请码，防止被他人抢注
    const code = env.ADMIN_CODE;
    if (!code || body.inviteCode !== code) {
      return json(
        { ok: false, error: "该用户名为管理员保留名，需要有效的管理员邀请码" },
        403
      );
    }
  }

  const exists = await env.DB.prepare(
    "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first();
  if (exists) return json({ ok: false, error: "用户名已存在" }, 409);

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = b64urlEncode(saltBytes);
  const passHash = await deriveHash(password, saltBytes);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO users(username, pass_hash, salt, role, disabled, created_at) VALUES(?, ?, ?, ?, 0, ?)"
  )
    .bind(username, passHash, salt, admin ? "admin" : "user", now)
    .run();

  const user = await env.DB.prepare(
    "SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first();
  const secret = await getSecret(env);
  const token = await signSession(user, secret);
  return json(
    { ok: true, user: { username: user.username, role: user.role } },
    200,
    { "Set-Cookie": sessionCookie(token, request) }
  );
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const username = (body.username || "").trim();

  const user = await env.DB.prepare(
    "SELECT id, username, pass_hash, salt, role, disabled FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first();

  // 用户不存在与密码错误返回相同信息，避免用户枚举
  const ok = user && (await verifyPassword(body.password || "", user.salt, user.pass_hash));
  if (!user || !ok) {
    return json({ ok: false, error: "用户名或密码错误" }, 401);
  }
  if (user.disabled) {
    return json({ ok: false, error: "账号已被禁用，请联系管理员" }, 403);
  }

  await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?")
    .bind(new Date().toISOString(), user.id)
    .run();

  const secret = await getSecret(env);
  const token = await signSession(user, secret);
  return json(
    { ok: true, user: { username: user.username, role: user.role } },
    200,
    { "Set-Cookie": sessionCookie(token, request) }
  );
}

function handleLogout() {
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
  });
}

/* ------------------------------ 管理接口 -------------------------------- */

async function handleAdminList(env) {
  const result = await env.DB.prepare(
    "SELECT id, username, role, disabled, created_at, last_login FROM users ORDER BY id"
  ).all();
  const users = (result.results || []).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    created_at: u.created_at,
    last_login: u.last_login,
  }));
  return json({ ok: true, users });
}

async function handleAdminToggle(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const id = Number(body.id);
  const disabled = body.disabled ? 1 : 0;
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: "无效的用户编号" }, 400);
  }
  const result = await env.DB.prepare(
    "UPDATE users SET disabled = ? WHERE id = ?"
  )
    .bind(disabled, id)
    .run();
  if (!result.success || !result.meta || result.meta.changes === 0) {
    return json({ ok: false, error: "用户不存在" }, 404);
  }
  return json({ ok: true });
}

async function handleAdminReset(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const id = Number(body.id);
  const password = body.password || "";
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: "无效的用户编号" }, 400);
  }
  if (typeof password !== "string" || password.length < 8) {
    return json({ ok: false, error: "新密码至少 8 位" }, 400);
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = b64urlEncode(saltBytes);
  const passHash = await deriveHash(password, saltBytes);
  const result = await env.DB.prepare(
    "UPDATE users SET pass_hash = ?, salt = ?, disabled = 0 WHERE id = ?"
  )
    .bind(passHash, salt, id)
    .run();
  if (!result.success || !result.meta || result.meta.changes === 0) {
    return json({ ok: false, error: "用户不存在" }, 404);
  }
  return json({ ok: true });
}

/* ------------------------------ 路由入口 -------------------------------- */

/**
 * 处理 /api/* 路由。返回 Response 表示已处理，返回 null 表示与本模块无关。
 */
export async function handleAuthApi(request, env, path) {
  const method = request.method;
  if (path === "/api/register" && method === "POST") {
    return handleRegister(request, env);
  }
  if (path === "/api/login" && method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/api/logout" && method === "POST") {
    return handleLogout();
  }
  if (path === "/api/me") {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, user: null }, 401);
    return json({
      ok: true,
      user: { username: user.username, role: user.role, id: user.id },
    });
  }

  if (path.startsWith("/api/admin/")) {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: "请先登录" }, 401);
    if (user.role !== "admin") {
      return json({ ok: false, error: "需要管理员权限" }, 403);
    }
    if (path === "/api/admin/users" && method === "GET") {
      return handleAdminList(env);
    }
    if (path === "/api/admin/toggle" && method === "POST") {
      return handleAdminToggle(request, env);
    }
    if (path === "/api/admin/reset" && method === "POST") {
      return handleAdminReset(request, env);
    }
    return json({ ok: false, error: "未知接口" }, 404);
  }

  return null;
}
