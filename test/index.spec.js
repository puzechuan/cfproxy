import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import worker from "../src";

afterEach(() => {
	vi.unstubAllGlobals();
});

// 测试用普通用户会话：所有代理类请求需要带登录态
let sessionCookie = "";
const TEST_USER = "tester";
const TEST_PASS = "password123";
const ADMIN_USER = "rootadmin";
const ADMIN_PASS = "adminpass123";
// 初始化验证密钥：仓库里只有摘要，测试用一把独立的密钥，不能出现线上明文密钥
const TEST_INIT_KEY = "test-init-key-2026";
const TEST_INIT_KEY_SHA256 =
	"40eef652bf91ee7b6e6884faed4b2420ed00d758321dd90f17fe3ac37d6364df";

// 初始化阶段观察到的状态，用于断言「首次部署」的表现
const preInit = {
	installed: null,
	homeStatus: 0,
	homeLocation: "",
	registerStatus: 0,
	initRole: "",
	missingKeyStatus: 0,
	wrongKeyStatus: 0,
	installedAfterReject: false,
	noConfigStatus: 0,
};

async function raw(request) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function jsonRequest(path, payload) {
	return new Request("http://example.com" + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

/** 用一份临时 env 跑请求（未列出的绑定回落到真实 env），用于验证配置项差异 */
async function rawWith(request, customEnv) {
	const ctx = createExecutionContext();
	const merged = new Proxy(customEnv, {
		get(target, prop) {
			if (prop in target) return target[prop];
			return env[prop];
		},
	});
	const response = await worker.fetch(request, merged, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeAll(async () => {
	// 测试环境有独立 D1 实例，先确保表结构存在（幂等）
	await env.DB.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login TEXT)");
	await env.DB.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	// 从干净状态开始，保证初始化流程每次都能被完整验证
	await env.DB.exec("DELETE FROM users");
	await env.DB.exec("DELETE FROM settings");

	// 1) 初始化前：未初始化、首页引导到初始化页、注册不可用
	preInit.installed = (await (await raw(new Request("http://example.com/api/init-status"))).json()).installed;
	const home = await raw(new Request("http://example.com/"));
	preInit.homeStatus = home.status;
	preInit.homeLocation = home.headers.get("location") || "";
	preInit.registerStatus = (
		await raw(jsonRequest("/api/register", { username: TEST_USER, password: TEST_PASS }))
	).status;

	// 2) 验证密钥不通过时不能建管理员（且不能把初始化标记占掉）
	// 测试环境只认测试密钥的摘要，线上明文密钥不会出现在仓库里
	const testEnv = { INIT_KEY_SHA256: TEST_INIT_KEY_SHA256 };
	preInit.missingKeyStatus = (
		await rawWith(
			jsonRequest("/api/init", { username: ADMIN_USER, password: ADMIN_PASS }),
			testEnv
		)
	).status;
	preInit.wrongKeyStatus = (
		await rawWith(
			jsonRequest("/api/init", {
				initKey: "not-the-key",
				username: ADMIN_USER,
				password: ADMIN_PASS,
			}),
			testEnv
		)
	).status;
	preInit.installedAfterReject = (
		await (await raw(new Request("http://example.com/api/init-status"))).json()
	).installed;
	preInit.noConfigStatus = (
		await rawWith(
			jsonRequest("/api/init", {
				initKey: TEST_INIT_KEY,
				username: ADMIN_USER,
				password: ADMIN_PASS,
			}),
			{ INIT_KEY_SHA256: "" }
		)
	).status;

	// 3) 带正确密钥完成初始化：创建第一个管理员
	const initRes = await rawWith(
		jsonRequest("/api/init", {
			initKey: TEST_INIT_KEY,
			username: ADMIN_USER,
			password: ADMIN_PASS,
		}),
		testEnv
	);
	preInit.initRole = (await initRes.json()).user.role;

	// 4) 注册普通用户并登录，供代理类用例使用
	await raw(jsonRequest("/api/register", { username: TEST_USER, password: TEST_PASS }));
	const res = await raw(jsonRequest("/api/login", { username: TEST_USER, password: TEST_PASS }));
	sessionCookie = (res.headers.get("set-cookie") || "").split(";")[0];
});

function withAuth(request) {
	if (sessionCookie) request.headers.set("cookie", sessionCookie);
	return request;
}

async function call(request) {
	withAuth(request);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/**
 * 页面由静态资源提供。测试环境若没有 ASSETS 绑定，Worker 会退化成 302 指向页面文件，
 * 因此这里两种结果都接受，但都会校验指向的文件名。
 */
function expectPageServed(response, file) {
	if (response.status === 302) {
		expect(response.headers.get("location")).toContain("/" + file);
		return;
	}
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
}

describe("系统初始化", () => {
	it("首次部署时处于未初始化状态", () => {
		expect(preInit.installed).toBe(false);
	});

	it("未初始化时任何页面都引导到初始化页", () => {
		expect(preInit.homeStatus).toBe(302);
		expect(preInit.homeLocation).toContain("/init.html");
	});

	it("未初始化时注册被拒绝", () => {
		expect(preInit.registerStatus).toBe(403);
	});

	it("初始化创建的第一个账号是管理员", () => {
		expect(preInit.initRole).toBe("admin");
	});

	it("缺少验证密钥时拒绝初始化", () => {
		expect(preInit.missingKeyStatus).toBe(400);
	});

	it("验证密钥错误时拒绝初始化", () => {
		expect(preInit.wrongKeyStatus).toBe(403);
	});

	it("密钥校验失败不会占用初始化标记", () => {
		expect(preInit.installedAfterReject).toBe(false);
	});

	it("服务端没配置密钥摘要时拒绝初始化", () => {
		expect(preInit.noConfigStatus).toBe(500);
	});

	it("wrangler.jsonc 里配置了合法的验证密钥摘要", () => {
		expect(env.INIT_KEY_SHA256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("初始化后 /init.html 不再可访问", async () => {
		const res = await raw(new Request("http://example.com/init.html"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/\/$/);
	});

	it("重复初始化返回 409，避免被二次抢占", async () => {
		const res = await raw(
			jsonRequest("/api/init", { username: "another", password: "password123" })
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("已初始化");
	});

	it("初始化状态可查询", async () => {
		const res = await raw(new Request("http://example.com/api/init-status"));
		expect((await res.json()).installed).toBe(true);
	});
});

describe("代理入口", () => {
	it("/health 返回健康状态", async () => {
		const response = await call(new Request("http://example.com/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, service: "cfproxy" });
	});

	it("根路径返回静态页面", async () => {
		const response = await call(new Request("http://example.com/"));
		expectPageServed(response, "index.html");
	});

	it("拒绝白名单外域名", async () => {
		const response = await call(new Request("http://example.com/https://evil.example.com/x"));
		expect(response.status).toBe(400);
	});
});

describe("重定向处理", () => {
	it("普通页面：Location 使用相对路径，避免跳到 workers.dev", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(null, {
					status: 302,
					headers: {
						Location: "https://release-assets.githubusercontent.com/file?sp=r&sig=abc",
					},
				})
			)
		);

		const request = new Request(
			"http://example.com/https://github.com/OpenListTeam/OpenList/releases",
			{ headers: { Host: "cfproxy.koomer.site" } }
		);
		const response = await call(request);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"/https://release-assets.githubusercontent.com/file?sp=r&sig=abc"
		);
		expect(response.headers.get("location")).not.toContain("workers.dev");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("下载资源：服务端跟随重定向，浏览器看不到签名链接", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", {
				status: 200,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": "6",
					"Accept-Ranges": "bytes",
				},
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const request = new Request(
			"http://example.com/https://github.com/OpenListTeam/OpenList/releases/download/v4.2.10/openlist-darwin-amd64.tar.gz",
			{ headers: { Host: "cfproxy.koomer.site" } }
		);
		const response = await call(request);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("content-length")).toBe("6");
		expect(response.headers.get("accept-ranges")).toBe("bytes");

		const sub = fetchMock.mock.calls[0][0];
		expect(sub.redirect).toBe("follow");
		expect(sub.cf.cacheKey).toBe(
			"cfproxy:asset:github.com/OpenListTeam/OpenList/releases/download/v4.2.10/openlist-darwin-amd64.tar.gz"
		);
		expect(sub.cf.cacheEverything).toBe(true);
	});
});

describe("下载加速与缓存", () => {
	it("latest/download 也由服务端跟随，浏览器看不到签名链接且可缓存", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", {
				status: 200,
				headers: { "Content-Type": "application/octet-stream", "Content-Length": "6" },
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request(
				"http://example.com/https://github.com/OpenListTeam/OpenList/releases/latest/download/tool.tar.gz",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(fetchMock.mock.calls[0][0].redirect).toBe("follow");
	});

	it("带版本号的 release 下载按不可变内容缓存一年", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("binary", {
					status: 200,
					headers: { "Content-Type": "application/octet-stream" },
				})
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request(
				"http://example.com/https://github.com/foo/bar/releases/download/v1.2.3/tool.tar.gz",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable"
		);
		expect(fetchMock.mock.calls[0][0].cf.cacheTtlByStatus["200-299"]).toBe(31536000);
	});

	it("分段响应不写浏览器缓存，避免半份对象影响续传", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("0123456789", {
						status: 206,
						headers: {
							"Content-Range": "bytes 0-9/100",
							"Content-Length": "10",
						},
					})
			)
		);

		const response = await call(
			new Request(
				"http://example.com/https://github.com/foo/bar/releases/download/v1/tool.tar.gz",
				{ headers: { Host: "cfproxy.koomer.site", Range: "bytes=0-9" } }
			)
		);

		expect(response.status).toBe(206);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-range")).toBe("bytes 0-9/100");
		expect(response.headers.get("server-timing")).toContain("upstream;dur=");
	});


	it("直接访问签名资源链接时使用剥离查询串的稳定缓存键", async () => {
		const fetchMock = vi.fn(async () => new Response("binary", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/github-production-release-asset/123/tool.tar.gz?sig=abc&jwt=def",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(fetchMock.mock.calls[0][0].cf.cacheKey).toBe(
			"cfproxy:asset:release-assets.githubusercontent.com/github-production-release-asset/123/tool.tar.gz"
		);
	});

	it("起始分段未命中只预热一次，非起始分段不触发预热", async () => {
		const fetchMock = vi.fn((req) => {
			const isRange = req.headers.has("range");
			const response = new Response(isRange ? "0123456789" : "full-object", {
				status: isRange ? 206 : 200,
				headers: isRange
					? { "Content-Range": "bytes 0-9/100", "Content-Length": "10" }
					: { "Content-Length": "11", "Accept-Ranges": "bytes" },
			});
			// 预热请求保持 pending 一段时间，模拟真实的长耗时拉取；
			// 否则任务瞬间结束会被立刻移出去重表，看不出并发去重效果
			return isRange
				? Promise.resolve(response)
				: new Promise((resolve) => setTimeout(() => resolve(response), 50));
		});
		vi.stubGlobal("fetch", fetchMock);

		const make = (range) =>
			new Request(
				"http://example.com/https://github.com/foo/bar/releases/download/v1/tool.tar.gz",
				{
					headers: {
						Host: "cfproxy.koomer.site",
						Range: range,
						"If-None-Match": "etag-1",
					},
				}
			);

		// 两个并发的起始分段：预热以 cacheKey 去重，只应多出一次整份拉取
		const ctx1 = createExecutionContext();
		const ctx2 = createExecutionContext();
		await Promise.all([
			worker.fetch(withAuth(make("bytes=0-9")), env, ctx1),
			worker.fetch(withAuth(make("bytes=0-9")), env, ctx2),
		]);
		await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);

		const rangeCalls = fetchMock.mock.calls.filter(([req]) => req.headers.has("range"));
		const warmCalls = fetchMock.mock.calls.filter(([req]) => !req.headers.has("range"));
		expect(rangeCalls).toHaveLength(2);
		expect(warmCalls).toHaveLength(1);
		// 预热请求不能带条件头，否则可能拿到 304 而缓存不到内容
		expect(warmCalls[0][0].headers.has("if-none-match")).toBe(false);

		// 非起始分段（下载器中间某一段）不应该触发预热
		fetchMock.mockClear();
		const ctx3 = createExecutionContext();
		await worker.fetch(withAuth(make("bytes=50-59")), env, ctx3);
		await waitOnExecutionContext(ctx3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0].headers.has("range")).toBe(true);
	});

	it("超过 64MB 的对象不自动预热（waitUntil 窗口内拉不完）", async () => {
		const big = 128 * 1024 * 1024;
		const fetchMock = vi.fn(
			async () =>
				new Response("0123456789", {
					status: 206,
					headers: {
						"Content-Range": `bytes 0-9/${big}`,
						"Content-Length": "10",
					},
				})
		);
		vi.stubGlobal("fetch", fetchMock);

		const ctx = createExecutionContext();
		await worker.fetch(
			withAuth(
				new Request(
					"http://example.com/https://github.com/foo/bar/releases/download/v2/big.tar.gz",
					{ headers: { Host: "cfproxy.koomer.site", Range: "bytes=0-9" } }
				)
			),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		// 只有分段请求本身，没有任何额外回源
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("异常上游与过期签名", () => {
	it("上游返回 status 0 的 error response 时返回 502 而不是 500", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.error()));

		const response = await call(
			new Request(
				"http://example.com/https://raw.githubusercontent.com/a/b/main/file.txt",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(502);
	});

	it("过期签名的 release-assets 链接返回带指引的 410 提示页", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Forbidden", { status: 403 }))
		);

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=expired",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(410);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("下载链接已过期");
		expect(html).toContain("/https://github.com/用户/仓库/releases");
	});

	it("签名链接遇到 status 0 的 error response 也返回过期提示页", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.error()));

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=expired",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(410);
		expect(await response.text()).toContain("下载链接已过期");
	});

	it("签名有效的正常下载不受影响", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("binary", {
					status: 200,
					headers: { "Content-Type": "application/octet-stream" },
				})
			)
		);

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=valid",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
	});
});

describe("GitHub 静态资源代理", () => {
	it("github.githubassets.com 走代理并启用缓存", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("body", {
				status: 200,
				headers: { "Content-Type": "application/javascript", "Content-Length": "4" },
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request(
				"http://example.com/https://github.githubassets.com/assets/app.js",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		const sub = fetchMock.mock.calls[0][0];
		expect(sub.url).toBe("https://github.githubassets.com/assets/app.js");
		expect(sub.cf.cacheEverything).toBe(true);
	});

	it("CSS 里的绝对 URL 也会被重写", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response('body{background:url(https://github.githubassets.com/img/bg.png)}', {
					status: 200,
					headers: { "Content-Type": "text/css; charset=utf-8" },
				})
			)
		);

		const response = await call(
			new Request(
				"https://example.com/https://github.githubassets.com/assets/app.css",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);
		expect(await response.text()).toContain(
			"https://cfproxy.koomer.site/https://github.githubassets.com/img/bg.png"
		);
	});

	it("支持 *.github.io 子域（与首页白名单一致）", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request("http://example.com/https://foo.github.io/index.html", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls[0][0]).toBe("https://foo.github.io/index.html");
	});

	it("响应头暴露边缘缓存命中状态", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("x", {
					status: 200,
					headers: { "CF-Cache-Status": "HIT", Age: "12" },
				})
			)
		);

		const response = await call(
			new Request("http://example.com/https://raw.githubusercontent.com/a/b/main/x", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		expect(response.headers.get("x-cfproxy-cache")).toBe("HIT");
		expect(response.headers.get("age")).toBeNull();
	});
});

describe("显式预热接口", () => {
	const target = "https://github.com/foo/bar/releases/download/v1/tool.tar.gz";

	function stubFetch() {
		const fetchMock = vi.fn(async (req) => {
			if (typeof req !== "string" && req.headers.has("range")) {
				return new Response(null, {
					status: 206,
					headers: { "CF-Cache-Status": "HIT" },
				});
			}
			return new Response("binary", {
				status: 200,
				headers: { "Content-Length": "6" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("/__warm 等完整对象下载完成后返回字节数与缓存状态", async () => {
		const fetchMock = stubFetch();
		const response = await call(
			new Request(
				"http://example.com/__warm?url=" + encodeURIComponent(target),
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.bytes).toBe(6);
		expect(data.cache).toBe("HIT");

		const warm = fetchMock.mock.calls.find(
			([req]) => typeof req !== "string" && !req.headers.has("range")
		);
		expect(warm[0].cf.cacheEverything).toBe(true);
		expect(warm[0].cf.cacheKey).toBe("cfproxy:asset:github.com/foo/bar/releases/download/v1/tool.tar.gz");
	});

	it("并发预热同一对象只回源一次", async () => {
		const fetchMock = stubFetch();
		const make = () =>
			new Request("http://example.com/__warm?url=" + encodeURIComponent(target), {
				headers: { Host: "cfproxy.koomer.site" },
			});
		const ctx1 = createExecutionContext();
		const ctx2 = createExecutionContext();
		const [r1, r2] = await Promise.all([
			worker.fetch(withAuth(make()), env, ctx1),
			worker.fetch(withAuth(make()), env, ctx2),
		]);
		await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);

		expect((await r1.json()).ok).toBe(true);
		expect((await r2.json()).ok).toBe(true);
		// 1 次完整预热 + 2 次 1 字节验证
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("超过 400MB 的对象跳过预热，避免白耗带宽", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("x", {
						status: 200,
						headers: { "Content-Length": String(500 * 1024 * 1024) },
					})
			)
		);

		const response = await call(
			new Request("http://example.com/__warm?url=" + encodeURIComponent(target), {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);

		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.skipped).toBe("too_large");
		expect(data.bytes).toBe(0);
	});

	it("预热结果带吞吐与机房信息，便于判断慢在哪一段", async () => {
		stubFetch();
		const response = await call(
			new Request("http://example.com/__warm?url=" + encodeURIComponent(target), {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		const data = await response.json();
		expect(data.bytes).toBe(6);
		expect(typeof data.speed).toBe("number");
		expect(data).toHaveProperty("colo");
	});

	it("非下载资源拒绝预热", async () => {
		stubFetch();
		const response = await call(
			new Request(
				"http://example.com/__warm?url=" +
					encodeURIComponent("https://github.com/foo/bar"),
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);
		expect(response.status).toBe(400);
		expect((await response.json()).ok).toBe(false);
	});
});

describe("CSP 重写", () => {
	it("HTML 页面的 CSP 放行代理域名，避免样式和脚本被拦截", async () => {
		const csp =
			"default-src 'none'; base-uri 'self'; " +
			"style-src 'unsafe-inline' github.githubassets.com; " +
			"script-src github.githubassets.com 'sha256-abc'; " +
			"font-src github.githubassets.com; img-src 'self' data:";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("<html><head></head><body>hi</body></html>", {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": csp,
						"Content-Security-Policy-Report-Only": "script-src 'none'",
					},
				})
			)
		);

		const response = await call(
			new Request("https://example.com/https://github.com/foo/bar", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		const out = response.headers.get("content-security-policy");
		expect(out).toContain(
			"style-src 'unsafe-inline' github.githubassets.com https://cfproxy.koomer.site"
		);
		expect(out).toContain(
			"font-src github.githubassets.com https://cfproxy.koomer.site"
		);
		expect(out).toContain(
			"script-src github.githubassets.com 'sha256-abc' https://cfproxy.koomer.site"
		);
		expect(out).toContain("base-uri 'self'");
		expect(response.headers.get("content-security-policy-report-only")).toBeNull();
	});
});

describe("回源线路优选", () => {
	const assetUrl = "https://github.com/foo/bar/releases/download/v1/tool.tar.gz";

	async function callWith(request, customEnv) {
		withAuth(request);
		const ctx = createExecutionContext();
		const merged = new Proxy(customEnv, {
			get(target, prop) {
				if (prop in target) return target[prop];
				return env[prop];
			},
		});
		const response = await worker.fetch(request, merged, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	function assetRequest() {
		return new Request("http://example.com/" + assetUrl, {
			headers: { Host: "cfproxy.koomer.site" },
		});
	}

	it("配置镜像后走镜像，但缓存键仍基于原始 GitHub URL", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await callWith(assetRequest(), {
			UPSTREAM_MIRRORS: JSON.stringify(["https://mirror.example"]),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-cfproxy-route")).toBe("mirror.example");
		const sub = fetchMock.mock.calls[0][0];
		expect(sub.url).toBe("https://mirror.example/" + assetUrl);
		expect(sub.cf.cacheKey).toBe(
			"cfproxy:asset:github.com/foo/bar/releases/download/v1/tool.tar.gz"
		);
	});

	it("首选线路 5xx 或网络失败时自动切到下一条", async () => {
		const fetchMock = vi.fn(async (req) => {
			if (req.url.startsWith("https://mirror1.example")) {
				return new Response("bad", { status: 503 });
			}
			if (req.url.startsWith("https://mirror2.example")) {
				throw new Error("network down");
			}
			return new Response("binary", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await callWith(assetRequest(), {
			UPSTREAM_MIRRORS: JSON.stringify([
				"https://mirror1.example",
				"https://mirror2.example",
			]),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-cfproxy-route")).toBe("direct");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("/health 不缓存，便于确认线上版本", async () => {
		const response = await call(new Request("http://example.com/health"));
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

describe("内联脚本哈希", () => {
	it("HTML 改写后重算 CSP 中的 sha256，避免脚本被拦截导致骨架屏", async () => {
		const oldHash = "'sha256-oldHash='";
		const html =
			'<html><head><script>window.x="https://github.com/foo/bar";</script></head><body>x</body></html>';
		const csp =
			"default-src 'none'; script-src github.githubassets.com " +
			oldHash +
			"; style-src 'unsafe-inline' github.githubassets.com";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(html, {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": csp,
					},
				})
			)
		);

		const response = await call(
			new Request("https://example.com/https://github.com/foo/bar", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		const finalHtml = await response.text();
		const scriptBody = finalHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(scriptBody)
		);
		let binary = "";
		for (const byte of new Uint8Array(digest)) {
			binary += String.fromCharCode(byte);
		}
		const expected = "sha256-" + btoa(binary);
		const out = response.headers.get("content-security-policy");

		expect(finalHtml).toContain(
			"https://cfproxy.koomer.site/https://github.com/foo/bar"
		);
		expect(out).not.toContain(oldHash);
		expect(out).toContain(expected);
	});
});

describe("内容链接重写", () => {
	it("使用请求 Host 作为代理地址", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response('<a href="https://github.com/foo/bar">x</a>', {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Length": "45",
					},
				})
			)
		);

		const request = new Request("https://example.com/https://raw.githubusercontent.com/a/b/main/readme.md", {
			headers: { Host: "cfproxy.koomer.site" },
		});
		const response = await call(request);
		const html = await response.text();

		expect(html).toContain("https://cfproxy.koomer.site/https://github.com/foo/bar");
		expect(html).not.toContain("http://example.com/https://github.com");
		// 文本被改写后原 Content-Length 已失效，必须移除
		expect(response.headers.get("content-length")).toBeNull();
	});
});

describe("用户系统 · 访问控制", () => {
	it("未登录访问代理被拒绝（401 且带 needLogin）", async () => {
		const response = await worker.fetch(
			new Request("http://example.com/https://github.com/foo/bar"),
			env,
			createExecutionContext()
		);
		expect(response.status).toBe(401);
		const data = await response.json();
		expect(data.needLogin).toBe(true);
	});

	it("未登录访问预热接口同样被拒绝", async () => {
		const response = await worker.fetch(
			new Request("http://example.com/__warm?url=" + encodeURIComponent("https://github.com/foo/bar")),
			env,
			createExecutionContext()
		);
		expect(response.status).toBe(401);
	});

	it("健康接口无需登录，首页未登录则跳转登录页", async () => {
		const health = await call(new Request("http://example.com/health"));
		expect(health.status).toBe(200);
		const home = await worker.fetch(new Request("http://example.com/"), env, createExecutionContext());
		expect(home.status).toBe(302);
		expect(home.headers.get("location")).toContain("/login.html");
	});

	it("登录页公开可访问", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/login.html"),
			env,
			createExecutionContext()
		);
		expectPageServed(res, "login.html");
	});

	it("已登录访问登录页会被送回首页", async () => {
		const res = await call(new Request("http://example.com/login.html"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/\/$/);
	});

	it("未登录访问用户管理页跳转登录页并记住原地址", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/admin.html"),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(302);
		const location = res.headers.get("location");
		expect(location).toContain("/login.html");
		expect(location).toContain("%2Fadmin.html");
	});

	it("普通用户访问用户管理页被送回首页", async () => {
		const res = await call(new Request("http://example.com/admin.html"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toMatch(/\/$/);
	});

	it("未登录访问优选 IP 页跳转登录页并记住原地址", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/ip.html"),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(302);
		const location = res.headers.get("location");
		expect(location).toContain("/login.html");
		expect(location).toContain("%2Fip.html");
	});

	it("登录后可打开优选 IP 页", async () => {
		const res = await call(new Request("http://example.com/ip.html"));
		expectPageServed(res, "ip.html");
	});

	it("登录后可访问代理（会话 Cookie 生效）", async () => {
		// 不真的打外网，避免网络抖动导致偶发失败
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }))
		);
		const response = await call(new Request("http://example.com/https://raw.githubusercontent.com/a/b/main/x"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello");
	});

	it("已登录用户 /api/me 返回身份", async () => {
		const req = withAuth(new Request("http://example.com/api/me"));
		const res = await worker.fetch(req, env, createExecutionContext());
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.user.username).toBe(TEST_USER);
		expect(data.user.role).toBe("user");
	});

	it("错误密码登录失败，不泄露用户是否存在", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: TEST_USER, password: "wrong-password" }),
			}),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(401);
		expect((await res.json()).error).toContain("用户名或密码错误");
	});

	it("注册：密码过短被拒绝", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/api/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "shortpw", password: "123" }),
			}),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(400);
	});

	it("注册：重复用户名被拒绝", async () => {
		const res = await worker.fetch(
			new Request("http://example.com/api/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: TEST_USER, password: "password123" }),
			}),
			env,
			createExecutionContext()
		);
		expect(res.status).toBe(409);
	});
});

describe("用户系统 · 管理员", () => {
	async function api(req) {
		return worker.fetch(req, env, createExecutionContext());
	}

	/** 用初始化时创建的管理员登录，返回可直接带的 Cookie */
	async function adminSessionCookie() {
		const res = await api(
			new Request("http://example.com/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
			})
		);
		return (res.headers.get("set-cookie") || "").split(";")[0];
	}

	it("普通用户访问管理接口被拒绝（403）", async () => {
		const res = await api(withAuth(new Request("http://example.com/api/admin/users")));
		expect(res.status).toBe(403);
	});

	it("未登录访问管理接口被拒绝（401）", async () => {
		const res = await api(new Request("http://example.com/api/admin/users"));
		expect(res.status).toBe(401);
	});

	it("管理员可列出用户、禁用账号，禁用立即生效", async () => {
		const ae = env;
		const adminCookie = await adminSessionCookie();
		const authed = (path, init) => {
			const req = new Request("http://example.com" + path, init);
			req.headers.set("cookie", adminCookie);
			return req;
		};

		const list = await api(authed("/api/admin/users"), ae);
		expect(list.status).toBe(200);
		const users = (await list.json()).users;
		expect(Array.isArray(users)).toBe(true);
		const tester = users.find((u) => u.username === TEST_USER);
		expect(tester).toBeDefined();

		// 禁用 tester
		const toggle = await api(
			authed("/api/admin/toggle", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: tester.id, disabled: true }),
			}),
			ae
		);
		expect(toggle.status).toBe(200);

		// tester 的旧 Cookie 立即失效
		const blocked = await api(new Request("http://example.com/api/me", {
			headers: { cookie: sessionCookie },
		}), ae);
		expect(blocked.status).toBe(401);

		// 代理热路径用的是 isolate 缓存版本，禁用后同样要立刻拦住，
		// 不能被缓存里的旧记录放行
		const blockedProxy = await api(
			withAuth(new Request("http://example.com/https://github.com/foo/bar/releases/download/v1/x.zip")),
			ae
		);
		expect(blockedProxy.status).toBe(401);

		// 恢复，避免影响其他测试
		const restore = await api(
			authed("/api/admin/toggle", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: tester.id, disabled: false }),
			}),
			ae
		);
		expect(restore.status).toBe(200);
	});

	it("管理员可打开用户管理页", async () => {
		const ae = env;
		const adminCookie = await adminSessionCookie();
		const req = new Request("http://example.com/admin.html");
		req.headers.set("cookie", adminCookie);

		const res = await api(req, ae);
		expectPageServed(res, "admin.html");
	});

	it("管理员可重置用户密码，新密码可登录", async () => {
		const ae = env;
		const adminCookie = await adminSessionCookie();
		const list = await api(
			(() => { const r = new Request("http://example.com/api/admin/users"); r.headers.set("cookie", adminCookie); return r; })(),
			ae
		);
		const tester = (await list.json()).users.find((u) => u.username === TEST_USER);

		const reset = await api(
			(() => {
				const r = new Request("http://example.com/api/admin/reset", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: tester.id, password: "newpassword456" }),
				});
				r.headers.set("cookie", adminCookie);
				return r;
			})(),
			ae
		);
		expect(reset.status).toBe(200);

		const relogin = await api(
			new Request("http://example.com/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: TEST_USER, password: "newpassword456" }),
			}),
			ae
		);
		expect(relogin.status).toBe(200);
		// 更新会话 Cookie 供后续测试使用
		sessionCookie = (relogin.headers.get("set-cookie") || "").split(";")[0];
	});
});
