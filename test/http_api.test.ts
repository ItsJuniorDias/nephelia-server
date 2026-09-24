import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { cleanName, createApi, parseMatchRequest } from "../src/http_api.ts";
import type { MatchService } from "../src/http_api.ts";
import { silentLogger } from "../src/log.ts";
import type { MatchRequest, MatchResult } from "../src/matchmaker.ts";
import { RateLimiter } from "../src/rate_limit.ts";
import { testConfig } from "./helpers.ts";

class FakeService implements MatchService {
	next: MatchResult = { ok: true, host: "203.0.113.5", port: 24700, url: "", match: "m1", ticket: "t" };
	requests: MatchRequest[] = [];
	ports = new Map<string, number>();
	portOf(id: string): number | null {
		return this.ports.get(id) ?? null;
	}
	async request(request: MatchRequest): Promise<MatchResult> {
		this.requests.push(request);
		return this.next;
	}
	summary(): { players: number; matches: unknown[] } {
		return { players: 3, matches: [{}, {}] };
	}
}

describe("HTTP API", () => {
	const service = new FakeService();
	const server = createApi(service, testConfig(), silentLogger, new RateLimiter(600, 50));
	let base = "";

	before(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	const matchmake = (body: string): Promise<Response> =>
		fetch(`${base}/v1/matchmake`, { method: "POST", headers: { "content-type": "application/json" }, body });

	test("health and status", async () => {
		assert.deepEqual(await (await fetch(`${base}/v1/health`)).json(), { ok: true });
		assert.deepEqual(await (await fetch(`${base}/v1/status`)).json(), { players: 3, matches: 2 });
	});

	test("matchmake answers where to connect", async () => {
		const response = await matchmake(JSON.stringify({ version: 1, name: "  Alex  ", platform: "windows" }));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { host: "203.0.113.5", port: 24700, match: "m1", ticket: "t" });
		assert.deepEqual(service.requests.at(-1), { version: 1, name: "Alex", platform: "windows" });
	});

	test("in WebSocket mode the answer is the wss:// address of the match", async () => {
		service.next = { ok: true, host: "", port: 24700, url: "wss://nephelia.onrender.com/play/m1", match: "m1", ticket: "t" };
		const response = await matchmake(JSON.stringify({ version: 1 }));
		assert.deepEqual(await response.json(), { url: "wss://nephelia.onrender.com/play/m1", match: "m1", ticket: "t" });
	});

	test("a WebSocket to /play/<match> is passed through to that match server", async () => {
		// Servidor da partida de mentira: recebe o pedido original e responde algo reconhecível.
		const received: string[] = [];
		const upstream = createServer((socket) => {
			socket.once("data", (data) => {
				received.push(data.toString("utf8"));
				socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHELLO");
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		service.ports.set("m7", (upstream.address() as AddressInfo).port);
		const answer = await rawUpgrade("/play/m7");
		assert.match(answer, /^HTTP\/1\.1 101/);
		assert.match(answer, /HELLO$/);
		assert.match(received[0] ?? "", /^GET \/play\/m7 HTTP\/1\.1\r\n/);
		assert.match(received[0] ?? "", /Sec-WebSocket-Key: abc/i);
		assert.match(await rawUpgrade("/play/nothing"), /^HTTP\/1\.1 404/);
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});

	// Pedido de WebSocket "na mão" (só o aperto de mão), devolvendo o que voltar.
	const rawUpgrade = (path: string): Promise<string> => new Promise((resolve) => {
		const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
		let text = "";
		socket.on("connect", () => {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
				+ "Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n");
		});
		socket.on("data", (data) => {
			text += data.toString("utf8");
			if (text.endsWith("HELLO") || text.includes("404")) {
				socket.destroy();
				resolve(text);
			}
		});
		socket.on("close", () => resolve(text));
	});

	test("errors become HTTP status codes", async () => {
		service.next = { ok: false, error: "update_required" };
		assert.equal((await matchmake(JSON.stringify({ version: 0 }))).status, 426);
		service.next = { ok: false, error: "no_capacity" };
		assert.equal((await matchmake(JSON.stringify({ version: 1 }))).status, 503);
		assert.equal((await matchmake("{not json")).status, 400);
		assert.equal((await matchmake(JSON.stringify({ version: "1" }))).status, 400);
		assert.equal((await matchmake("x".repeat(5000))).status, 400);
		assert.equal((await fetch(`${base}/v1/matchmake`)).status, 405);
		assert.equal((await fetch(`${base}/v1/nothing`)).status, 404);
	});

	test("too many requests from one address are refused", async () => {
		const limited = createApi(new FakeService(), testConfig(), silentLogger, new RateLimiter(1, 2));
		await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/v1/matchmake`;
		const statuses: number[] = [];
		for (let i = 0; i < 3; i += 1) {
			statuses.push((await fetch(url, { method: "POST", body: JSON.stringify({ version: 1 }) })).status);
		}
		await new Promise<void>((resolve) => limited.close(() => resolve()));
		assert.deepEqual(statuses, [200, 200, 429]);
	});
});

test("request parsing cleans the name and the platform", () => {
	assert.deepEqual(parseMatchRequest(JSON.stringify({ version: 1, name: "A\u0000very long name indeed", platform: "ps5" })),
		{ version: 1, name: "Avery long nam", platform: "other" });
	assert.equal(parseMatchRequest("[]"), null);
	assert.equal(cleanName("   "), "Player");
});
