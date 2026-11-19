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
	it("Location 使用相对路径，避免跳到 workers.dev", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(null, {
					status: 302,
					headers: {
						Location:
							"https://release-assets.githubusercontent.com/file?sp=r&sig=abc",
					},
				})
			)
		);

		const request = new Request(
			"http://example.com/https://github.com/OpenListTeam/OpenList/releases/download/v4.2.10/openlist.tar.gz",
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
});

describe("内容链接重写", () => {
	it("使用请求 Host 作为代理地址", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response('<a href="https://github.com/foo/bar">x</a>', {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				})
			)
		);

		const request = new Request("https://example.com/https://raw.githubusercontent.com/a/b/main/readme", {
			headers: { Host: "cfproxy.koomer.site" },
		});
		const response = await call(request);
		const html = await response.text();

		expect(html).toContain("https://cfproxy.koomer.site/https://github.com/foo/bar");
		expect(html).not.toContain("http://example.com/https://github.com");
	});
});
