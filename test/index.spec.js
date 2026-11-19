import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src";

afterEach(() => {
	vi.unstubAllGlobals();
});

async function call(request) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("代理入口", () => {
	it("/health 返回健康状态", async () => {
		const response = await call(new Request("http://example.com/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, service: "cfproxy" });
	});

	it("根路径返回静态页面", async () => {
		const response = await call(new Request("http://example.com/"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
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

	it("并发 Range 未命中只预热一次完整对象，且预热不带条件请求头", async () => {
		const fetchMock = vi.fn((req) => {
			const isRange = req.headers.has("range");
			const response = new Response(isRange ? "0123456789" : "full-object", {
				status: isRange ? 206 : 200,
				headers: isRange
					? { "Content-Range": "bytes 0-9/100", "Content-Length": "10" }
					: { "Content-Length": "11", "Accept-Ranges": "bytes" },
			});
			// 让预热保持 pending，确保并发请求能命中"正在预热"状态
			return isRange
				? Promise.resolve(response)
				: new Promise((resolve) => setTimeout(() => resolve(response), 40));
		});
		vi.stubGlobal("fetch", fetchMock);

		const make = () =>
			new Request(
				"http://example.com/https://github.com/foo/bar/releases/download/v1/tool.tar.gz",
				{
					headers: {
						Host: "cfproxy.koomer.site",
						Range: "bytes=0-9",
						"If-None-Match": "etag-1",
					},
				}
			);

		const ctx1 = createExecutionContext();
		const ctx2 = createExecutionContext();
		await Promise.all([
			worker.fetch(make(), env, ctx1),
			worker.fetch(make(), env, ctx2),
		]);
		await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);

		// 两次 Range 请求 + 一次完整预热，而不是两次完整预热
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const warm = fetchMock.mock.calls.find(([req]) => !req.headers.has("range"));
		expect(warm).toBeDefined();
		expect(warm[0].headers.has("if-none-match")).toBe(false);
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
