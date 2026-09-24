// API HTTP (JSON) que o jogo usa. Só o módulo `node:http`, sem framework.
//
//   GET  /v1/health     -> 200 {"ok":true}
//   GET  /v1/status     -> 200 {"players":3,"matches":2}
//   POST /v1/matchmake  {"version":1,"name":"Alex","platform":"ios"}
//        200 {"host":"1.2.3.4","port":24700,"match":"m1","ticket":"..."}
//        400 {"error":"bad_request"}      pedido estragado
//        426 {"error":"update_required"}  versão do jogo diferente da do servidor
//        429 {"error":"rate_limited"}     pedidos demais deste IP
//        503 {"error":"no_capacity"}      todas as partidas cheias
//        502 {"error":"match_failed"}     a partida nova não abriu

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import type { MatchRequest, MatchResult } from "./matchmaker.ts";
import { RateLimiter } from "./rate_limit.ts";

/** O que a API precisa do matchmaker (os testes passam um de mentira). */
export interface MatchService {
	request(request: MatchRequest): Promise<MatchResult>;
	summary(): { players: number; matches: unknown[] };
}

const MAX_BODY_BYTES = 1024;
const NAME_MAX = 14;
const PLATFORMS: readonly string[] = ["ios", "android", "windows", "macos", "linux", "other"];
const ERROR_STATUS: Record<string, number> = {
	update_required: 426,
	no_capacity: 503,
	match_failed: 502,
};

export function createApi(service: MatchService, config: Config, log: Logger, limiter?: RateLimiter): Server {
	const rateLimiter = limiter ?? new RateLimiter(config.rateLimitPerMinute, config.rateLimitBurst);
	const pruneTimer = setInterval(() => rateLimiter.prune(), 60_000);
	pruneTimer.unref();
	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			log.error("request failed", { error: error instanceof Error ? error.message : String(error) });
			send(response, 500, { error: "internal" });
		});
	});
	server.on("close", () => clearInterval(pruneTimer));
	// Pedido lento ou pendurado não segura conexão para sempre.
	server.requestTimeout = 45_000;
	server.headersTimeout = 10_000;

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "GET" && url.pathname === "/v1/health") {
			send(response, 200, { ok: true });
			return;
		}
		if (request.method === "GET" && url.pathname === "/v1/status") {
			const summary = service.summary();
			send(response, 200, { players: summary.players, matches: summary.matches.length });
			return;
		}
		if (url.pathname === "/v1/matchmake") {
			if (request.method !== "POST") {
				send(response, 405, { error: "method_not_allowed" });
				return;
			}
			if (!rateLimiter.take(clientIp(request, config.trustProxy))) {
				send(response, 429, { error: "rate_limited" });
				return;
			}
			const body = await readBody(request);
			const parsed = body === null ? null : parseMatchRequest(body);
			if (parsed === null) {
				send(response, 400, { error: "bad_request" });
				return;
			}
			const result = await service.request(parsed);
			if (result.ok) {
				send(response, 200, { host: result.host, port: result.port, match: result.match, ticket: result.ticket });
			} else {
				send(response, ERROR_STATUS[result.error] ?? 500, { error: result.error });
			}
			return;
		}
		send(response, 404, { error: "not_found" });
	}

	return server;
}

/** Confere e limpa o pedido de partida (null = estragado). */
export function parseMatchRequest(body: string): MatchRequest | null {
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const record = data as Record<string, unknown>;
	const version = record["version"];
	if (typeof version !== "number" || !Number.isInteger(version)) {
		return null;
	}
	const name = typeof record["name"] === "string" ? cleanName(record["name"]) : "Player";
	const platform = typeof record["platform"] === "string" && PLATFORMS.includes(record["platform"])
		? record["platform"] : "other";
	return { version, name, platform };
}

/** Nome como o jogo aceita: sem espaços nas pontas, até 14 letras, sem controle, nunca vazio. */
export function cleanName(value: string): string {
	// eslint-disable-next-line no-control-regex
	const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
	return text.length > 0 ? text : "Player";
}

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = request.headers["x-forwarded-for"];
		const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
		if (first) {
			return first;
		}
	}
	return request.socket.remoteAddress ?? "unknown";
}

function readBody(request: IncomingMessage): Promise<string | null> {
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let tooBig = false;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				tooBig = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
		request.on("error", () => resolve(null));
	});
}

function send(response: ServerResponse, status: number, body: unknown): void {
	if (response.headersSent) {
		return;
	}
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	});
	response.end(text);
}
