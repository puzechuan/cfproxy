/**
 * 用户系统：注册 / 登录 / 会话 / 管理员接口
 *
 * 安全要点：
 * 1. 密码用 PBKDF2-SHA256 + 随机盐派生 32 字节，只存哈希与盐，不存明文。
 * 2. 会话是无状态 HMAC-SHA256 签名 Cookie；每次请求按 uid 回查数据库，
 *    因此「禁用账号 / 调整角色」立即生效，不必等 Cookie 过期。
 * 3. 签名密钥在首次使用时生成并落入 D1 settings 表，模块级缓存；
 *    INSERT OR IGNORE 保证多 isolate 并发时共享同一把密钥。
 * 4. 首次部署时系统处于「未初始化」状态，只有 /init.html 可访问；
 *    初始化接口在「无管理员且未初始化」时可用一次，用于创建第一个管理员账号，
 *    初始化完成后标记写入 settings，之后该接口永久失效，不存在抢注窗口。
 * 5. 管理员可以关闭注册（settings.registration_open = "0"）。该标记只被
 *    /api/register 读取，登录与代理鉴权完全不看它，所以关闭注册不影响老用户。
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
    "SELECT id, username, role, disabled, created_at, last_login FROM users WHERE id = ?"
  )
    .bind(payload.uid)
    .first();
  if (!user || user.disabled) return null;
  return user;
}

/* --------------------- 热路径用户缓存（仅代理放行使用） --------------------- */

/**
 * 分段下载的每个请求都要过一次登录态校验。如果每次都查 D1，
 * 一个 16 线程下载器就会产生 16 次数据库往返，全部叠加在首字节延迟上。
 * 这里在 isolate 内做短 TTL 缓存，只用于「能不能走代理」这一个判断：
 * /api/* 的账号操作仍然调用 getUser 直查数据库，禁用/改角色立刻生效；
 * 管理员改动用户时会清空本 isolate 的缓存，其余 isolate 最多滞后 TTL。
 */
const PROXY_USER_TTL = 30 * 1000;
const PROXY_USER_MAX = 2000;
const proxyUserCache = new Map(); // uid -> { user, exp }

export function invalidateProxyUserCache() {
  proxyUserCache.clear();
}

/** 与 getUser 语义一致，但命中缓存时不查库；只给代理放行判断用 */
export async function getUserForProxy(request, env) {
  const token = parseCookie(request.headers.get("cookie"), COOKIE);
  if (!token) return null;
  const secret = await getSecret(env);
  const payload = await verifySession(token, secret);
  if (!payload || !payload.uid) return null;

  const now = Date.now();
  const hit = proxyUserCache.get(payload.uid);
  if (hit && hit.exp > now) return hit.user;

  const user = await env.DB.prepare(
    "SELECT id, username, role, disabled FROM users WHERE id = ?"
  )
    .bind(payload.uid)
    .first();
  if (!user || user.disabled) {
    proxyUserCache.delete(payload.uid);
    return null;
  }
  if (proxyUserCache.size >= PROXY_USER_MAX) proxyUserCache.clear();
  proxyUserCache.set(payload.uid, { user, exp: now + PROXY_USER_TTL });
  return user;
}

/* ------------------------------ 初始化状态 ------------------------------ */

/**
 * 系统是否已完成初始化（第一个管理员已创建）。
 * 用 settings 里的标记判断，而不是「用户表是否为空」——
 * 否则管理员被误删时初始化入口会重新打开，等于留了个后门。
 */
export async function isInstalled(env) {
  if (!env || !env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'installed'"
    ).first();
    return !!row;
  } catch (e) {
    // 表还没建（未执行迁移）时按未初始化处理，页面会引导去初始化页
    return false;
  }
}

/* ------------------------------ 注册开关 -------------------------------- */

/**
 * 管理员可以在后台关闭「新用户注册」。
 * 开关只影响 /api/register 这一条路径：已注册用户的登录、会话与代理访问
 * 完全不读这个标记，所以关闭注册不会影响任何老用户。
 * 用 settings 存一个 "0"/"1"，缺省即开放——这样默认行为与旧版本一致。
 */
const REGISTRATION_KEY = "registration_open";

export async function isRegistrationOpen(env) {
  if (!env || !env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = ?"
    )
      .bind(REGISTRATION_KEY)
      .first();
    // 没有记录 = 从未关闭过；只有显式写入 "0" 才算关闭
    return !row || row.value !== "0";
  } catch (e) {
    // 表还没建（未执行迁移）时按关闭处理，避免注册接口直接 500
    return false;
  }
}

async function setRegistrationOpen(env, open) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)"
  )
    .bind(REGISTRATION_KEY, open ? "1" : "0")
    .run();
}

/* ------------------------------ 初始化密钥 ------------------------------ */

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * 校验初始化验证密钥。
 * 仓库里只保存摘要（wrangler.jsonc → vars.INIT_KEY_SHA256），这里对页面输入做同样的
 * SHA-256 再做定长比较，明文密钥不落代码库、不入日志。
 * 通过返回 null，否则返回应当直接回给客户端的 Response。
 */
async function checkInitKey(env, rawKey) {
  const expected = String((env && env.INIT_KEY_SHA256) || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return json(
      {
        ok: false,
        error:
          "服务端未配置初始化密钥（INIT_KEY_SHA256），请在 wrangler.jsonc 的 vars 中填写其 SHA-256 摘要后重新部署",
      },
      500
    );
  }
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) return json({ ok: false, error: "请填写验证密钥" }, 400);

  const actual = await sha256Hex(key);
  if (!timingSafeEqual(actual, expected)) {
    return json({ ok: false, error: "验证密钥不正确" }, 403);
  }
  return null;
}

async function handleInit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const username = (body.username || "").trim();
  const password = body.password || "";

  if (await isInstalled(env)) {
    return json({ ok: false, error: "系统已初始化，请直接登录" }, 409);
  }

  // 验证密钥：只有部署者知道明文，仓库里只有它的 SHA-256 摘要
  const keyError = await checkInitKey(env, body.initKey);
  if (keyError) return keyError;

  if (!validUsername(username)) {
    return json(
      { ok: false, error: "用户名需为 3-32 位字母、数字、点、下划线或连字符" },
      400
    );
  }
  if (typeof password !== "string" || password.length < 8) {
    return json({ ok: false, error: "密码至少 8 位" }, 400);
  }

  // 先抢占初始化标记：并发请求里只有一个能成功，避免被重复初始化
  const marker = new Date().toISOString();
  let claim;
  try {
    claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO settings(key, value) VALUES('installed', ?)"
    )
      .bind(marker)
      .run();
  } catch (e) {
    return json(
      { ok: false, error: "数据库未就绪，请先执行 D1 迁移（见 migrations/）" },
      500
    );
  }
  if (!claim.meta || claim.meta.changes !== 1) {
    return json({ ok: false, error: "系统已初始化，请直接登录" }, 409);
  }

  try {
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = b64urlEncode(saltBytes);
    const passHash = await deriveHash(password, saltBytes);
    await env.DB.prepare(
      "INSERT INTO users(username, pass_hash, salt, role, disabled, created_at) VALUES(?, ?, ?, 'admin', 0, ?)"
    )
      .bind(username, passHash, salt, marker)
      .run();
  } catch (e) {
    // 建管理员失败就把标记撤掉，允许重试
    await env.DB.prepare(
      "DELETE FROM settings WHERE key = 'installed' AND value = ?"
    )
      .bind(marker)
      .run()
      .catch(() => {});
    return json({ ok: false, error: "初始化失败，请稍后重试" }, 500);
  }

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

/* ------------------------------ 注册 / 登录 ----------------------------- */

function validUsername(username) {
  return /^[A-Za-z0-9_.-]{3,32}$/.test(username || "");
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

  if (!(await isInstalled(env))) {
    return json({ ok: false, error: "系统尚未初始化，请先完成初始化" }, 403);
  }
  if (!(await isRegistrationOpen(env))) {
    return json(
      { ok: false, error: "管理员已关闭注册，暂不开放新账号注册" },
      403
    );
  }
  if (!validUsername(username)) {
    return json(
      { ok: false, error: "用户名需为 3-32 位字母、数字、点、下划线或连字符" },
      400
    );
  }
  if (typeof password !== "string" || password.length < 8) {
    return json({ ok: false, error: "密码至少 8 位" }, 400);
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
    "INSERT INTO users(username, pass_hash, salt, role, disabled, created_at) VALUES(?, ?, ?, 'user', 0, ?)"
  )
    .bind(username, passHash, salt, now)
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

  if (!(await isInstalled(env))) {
    return json({ ok: false, error: "系统尚未初始化，请先完成初始化" }, 403);
  }

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

/* ------------------------------ 自助改密 -------------------------------- */

/**
 * 用户修改自己的登录密码（页面 /me）。
 * 1. 必须已登录：用户 id 只取自会话，绝不从请求体取，避免改到别人账号。
 * 2. 必须校验当前密码，防止会话被临时借用时直接改密夺号。
 * 3. 新密码走与注册完全相同的规则（≥8 位）和 PBKDF2 派生，盐每次都换新的。
 * 4. 会话是无状态签名 Cookie（不含密码指纹），所以改密不会让其它设备上
 *    已登录的会话立刻失效；页面会提示用户自行退出其它设备。
 */
async function handleChangePassword(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const currentPassword = body.currentPassword || "";
  const newPassword = body.newPassword || "";
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return json({ ok: false, error: "新密码至少 8 位" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT id, pass_hash, salt FROM users WHERE id = ?"
  )
    .bind(user.id)
    .first();
  if (!row) return json({ ok: false, error: "用户不存在" }, 404);

  if (!(await verifyPassword(currentPassword, row.salt, row.pass_hash))) {
    return json({ ok: false, error: "当前密码不正确" }, 403);
  }
  if (currentPassword === newPassword) {
    return json({ ok: false, error: "新密码不能与当前密码相同" }, 400);
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = b64urlEncode(saltBytes);
  const passHash = await deriveHash(newPassword, saltBytes);
  const result = await env.DB.prepare(
    "UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?"
  )
    .bind(passHash, salt, user.id)
    .run();
  if (!result.success || !result.meta || result.meta.changes === 0) {
    return json({ ok: false, error: "保存失败，请稍后重试" }, 500);
  }
  return json({ ok: true });
}

/* --------------------------- 免登录访问密钥 ------------------------------ */

/**
 * 用户在 /me 生成一把 64 位随机密钥后，可以这样访问代理而无需登录 Cookie：
 *   https://<域名>/<64位密钥>/https://github.com/用户/仓库
 * 适合服务器上的 wget / curl / git、下载工具这类没有浏览器、也不方便反复登录的场景。
 *
 * 存储：没有新增表或字段（线上库已经建好，不想为了一个功能要求手工执行迁移），
 * 直接复用通用的 settings 键值表，正反各存一条：
 *   user_secret:<uid>    -> <密钥>   （页面展示用，按 id 直取）
 *   secret_owner:<密钥>  -> <uid>    （鉴权用，主键直查，O(1)）
 * 重新生成时先删掉旧密钥的反查条目，旧链接立刻失效；账号被禁用时立刻不可用。
 * 密钥等同于密码：只在本人会话下返回，日志中不打印。
 */
const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_RE = /^[A-Za-z0-9]{64}$/;
const SECRET_CACHE_TTL = 30 * 1000;
const secretCache = new Map(); // 密钥 -> { user, exp }

/** 62 进制字母表，64 位 ≈ 381 bit 熵；248 = 62*4，丢弃尾部避免取模偏差 */
function randomAccessSecret() {
  let out = "";
  const buf = new Uint8Array(64);
  while (out.length < 64) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 248) continue;
      out += TOKEN_ALPHABET[b % 62];
      if (out.length === 64) break;
    }
  }
  return out;
}

function userSecretKey(uid) {
  return "user_secret:" + uid;
}

function secretOwnerKey(secret) {
  return "secret_owner:" + secret;
}

/** 是否是「64 位密钥」这种形态的路径段（不校验有效性） */
export function isAccessSecret(value) {
  return TOKEN_RE.test(value || "");
}

async function readUserSecret(env, uid) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?"
  )
    .bind(userSecretKey(uid))
    .first();
  return row && TOKEN_RE.test(row.value || "") ? row.value : null;
}

/**
 * 密钥 → 用户。格式不对、未登记、账号已禁用都返回 null。
 * 与 getUserForProxy 同理加 isolate 短缓存：分段下载每个请求都走这里，
 * 不能每段都查两次 D1；密钥重新生成 / 停用时清空缓存立即生效。
 */
export async function getUserBySecret(env, secret) {
  if (!TOKEN_RE.test(secret || "")) return null;
  const now = Date.now();
  const hit = secretCache.get(secret);
  if (hit && hit.exp > now) return hit.user;

  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?"
  )
    .bind(secretOwnerKey(secret))
    .first();
  const uid = row ? Number(row.value) : 0;
  if (!uid) {
    secretCache.delete(secret);
    return null;
  }

  const user = await env.DB.prepare(
    "SELECT id, username, role, disabled FROM users WHERE id = ?"
  )
    .bind(uid)
    .first();
  if (!user || user.disabled) {
    secretCache.delete(secret);
    return null;
  }
  if (secretCache.size >= 2000) secretCache.clear();
  secretCache.set(secret, { user, exp: now + SECRET_CACHE_TTL });
  return user;
}

/** 生成 / 重新生成：旧密钥同时作废，返回新密钥 */
async function handleIssueSecret(env, user) {
  const prev = await readUserSecret(env, user.id);
  const secret = randomAccessSecret();
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)"
    ).bind(userSecretKey(user.id), secret),
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)"
    ).bind(secretOwnerKey(secret), String(user.id)),
    // 记录生成时间，便于页面展示与排查
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)"
    ).bind("secret_created:" + user.id, now),
  ];
  if (prev) {
    statements.push(
      env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(
        secretOwnerKey(prev)
      )
    );
  }
  await env.DB.batch(statements);
  secretCache.clear();
  return json({ ok: true, secret, created_at: now });
}

/** 停用：删掉正反两条记录，旧链接立刻 401 */
async function handleRevokeSecret(env, user) {
  const prev = await readUserSecret(env, user.id);
  const statements = [
    env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(
      userSecretKey(user.id)
    ),
    env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(
      "secret_created:" + user.id
    ),
  ];
  if (prev) {
    statements.push(
      env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(
        secretOwnerKey(prev)
      )
    );
  }
  await env.DB.batch(statements);
  secretCache.clear();
  return json({ ok: true, secret: null });
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
  invalidateProxyUserCache();
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
  invalidateProxyUserCache();
  return json({ ok: true });
}

async function handleAdminGetSettings(env) {
  return json({
    ok: true,
    registrationOpen: await isRegistrationOpen(env),
  });
}

async function handleAdminUpdateSettings(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  if (typeof body.registrationOpen !== "boolean") {
    return json({ ok: false, error: "registrationOpen 需为布尔值" }, 400);
  }
  try {
    await setRegistrationOpen(env, body.registrationOpen);
  } catch (e) {
    return json({ ok: false, error: "保存失败，请稍后重试" }, 500);
  }
  return json({
    ok: true,
    registrationOpen: await isRegistrationOpen(env),
  });
}

/* ------------------------------ 路由入口 -------------------------------- */

/**
 * 处理 /api/* 路由。返回 Response 表示已处理，返回 null 表示与本模块无关。
 */
export async function handleAuthApi(request, env, path) {
  const method = request.method;
  if (path === "/api/init" && method === "POST") {
    return handleInit(request, env);
  }
  if (path === "/api/init-status") {
    return json({
      ok: true,
      installed: await isInstalled(env),
      // 登录页据此决定是否展示「注册」入口
      registrationOpen: await isRegistrationOpen(env),
    });
  }
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
    const secret = await readUserSecret(env, user.id);
    const createdSec = secret
      ? await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
          .bind("secret_created:" + user.id)
          .first()
      : null;
    return json({
      ok: true,
      user: {
        username: user.username,
        role: user.role,
        id: user.id,
        created_at: user.created_at || null,
        last_login: user.last_login || null,
        // 免登录访问密钥：只在本人会话下返回，未生成时为 null
        secret: secret || null,
        secret_created_at: (createdSec && createdSec.value) || null,
      },
    });
  }
  if (path === "/api/me/secret") {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: "请先登录" }, 401);
    if (method === "POST") return handleIssueSecret(env, user);
    if (method === "DELETE") return handleRevokeSecret(env, user);
    return json({ ok: false, error: "未知接口" }, 404);
  }
  if (path === "/api/me/password" && method === "POST") {
    const user = await getUser(request, env);
    if (!user) return json({ ok: false, error: "请先登录" }, 401);
    return handleChangePassword(request, env, user);
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
    if (path === "/api/admin/settings" && method === "GET") {
      return handleAdminGetSettings(env);
    }
    if (path === "/api/admin/settings" && method === "POST") {
      return handleAdminUpdateSettings(request, env);
    }
    return json({ ok: false, error: "未知接口" }, 404);
  }

  return null;
}
