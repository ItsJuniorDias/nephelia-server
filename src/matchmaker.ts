// Matchmaker: escolhe a partida de quem pede para jogar e cuida da vida das partidas.
//
// Cada partida é um servidor dedicado do Godot (um processo, uma porta UDP). Quem pede partida vai
// para a mais cheia que ainda tem vaga (as partidas enchem em vez de ficarem todas com uma pessoa);
// sem vaga, abre uma nova. A vaga fica guardada (`reservations`) até a pessoa aparecer no servidor
// ou o tempo acabar, para dois pedidos ao mesmo tempo não lotarem a mesma partida.
// Partidas vazias fecham sozinhas, mas `warmMatches` ficam sempre prontas (entrar é na hora).
//
// Partida que não consegue abrir (Godot faltando, porta presa...) não é tentada de novo em
// seguida: a próxima tentativa espera 2 s, 4 s, 8 s... até 60 s (`SPAWN_BACKOFF_*`).
//
// Nada aqui abre processo nem rede: quem abre é o `Spawner` (ver godot_spawner.ts), e o relógio é
// injetado, então os testes controlam tudo.

import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { silentLogger } from "./log.ts";
import type { MatchPhase, ServerEvent } from "./protocol.ts";

export type MatchStatus = "starting" | MatchPhase | "stopping";

/** Espera depois de uma partida que não abriu: começa aqui e dobra a cada falha seguida. */
export const SPAWN_BACKOFF_FIRST_MS = 2_000;
export const SPAWN_BACKOFF_MAX_MS = 60_000;

/** Processo de uma partida (parar = pedir para fechar). */
export interface MatchHandle {
	stop(): void;
}

export interface Spawner {
	spawn(
		match: { id: string; port: number },
		onEvent: (event: ServerEvent) => void,
		onExit: (code: number | null) => void,
	): MatchHandle;
}

export interface MatchRequest {
	/** Versão do protocolo de rede do jogo do cliente. */
	version: number;
	name: string;
	platform: string;
}

export type MatchErrorCode = "update_required" | "no_capacity" | "match_failed";

/** Onde entrar: ENet = `host` e `port`; WebSocket = `url` (wss://.../play/<partida>). */
export type MatchResult =
	| { ok: true; host: string; port: number; url: string; match: string; ticket: string }
	| { ok: false; error: MatchErrorCode };

export interface MatchSummary {
	id: string;
	port: number;
	status: MatchStatus;
	humans: number;
	reserved: number;
}

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

interface Match {
	id: string;
	port: number;
	status: MatchStatus;
	humans: number;
	/** Vagas guardadas: bilhete -> quando expira (ms). */
	reservations: Map<string, number>;
	createdAt: number;
	/** Desde quando está sem ninguém (null = tem gente ou vaga guardada). */
	emptySince: number | null;
	timeLeft: number;
	handle: MatchHandle | null;
	waiters: Waiter[];
	readyTimer: ReturnType<typeof setTimeout> | null;
}

export class Matchmaker {
	private readonly config: Config;
	private readonly spawner: Spawner;
	private readonly now: () => number;
	private readonly log: Logger;
	private readonly matches = new Map<string, Match>();
	private nextId = 1;
	/** Partidas seguidas que não chegaram a abrir, e até quando não tenta abrir outra. */
	private spawnFailures = 0;
	private spawnBlockedUntil = 0;

	constructor(config: Config, spawner: Spawner, now: () => number = Date.now, log: Logger = silentLogger) {
		this.config = config;
		this.spawner = spawner;
		this.now = now;
		this.log = log;
	}

	/** Alguém quer jogar: devolve onde entrar (e guarda a vaga) ou por que não dá. */
	async request(request: MatchRequest): Promise<MatchResult> {
		if (request.version !== this.config.protocolVersion) {
			return { ok: false, error: "update_required" };
		}
		this.expireReservations();
		const match = this.pickReady() ?? this.pickStarting() ?? this.spawnMatch();
		if (match === null) {
			this.log.warn("no capacity", { matches: this.matches.size });
			return { ok: false, error: "no_capacity" };
		}
		const ticket = randomBytes(9).toString("base64url");
		match.reservations.set(ticket, this.now() + this.config.reservationMs);
		match.emptySince = null;
		if (match.status === "starting") {
			try {
				await this.whenReady(match);
			} catch {
				match.reservations.delete(ticket);
				return { ok: false, error: "match_failed" };
			}
		}
		this.log.info("match assigned", { match: match.id, name: request.name, platform: request.platform });
		const url = this.config.transport === "websocket" ? `${this.config.publicUrl}/play/${match.id}` : "";
		return { ok: true, host: this.config.publicHost, port: match.port, url, match: match.id, ticket };
	}

	/** Chamado a cada segundo: vagas guardadas vencem, partidas vazias fecham, mantém as prontas. */
	tick(): void {
		this.expireReservations();
		const now = this.now();
		let idle = this.matches.size === 0 ? 0 : [...this.matches.values()].filter((match) => this.isIdle(match)).length;
		const byAge = [...this.matches.values()].sort((a, b) => a.createdAt - b.createdAt);
		for (const match of byAge) {
			if (idle <= this.config.warmMatches) {
				break;
			}
			if (this.isIdle(match) && match.emptySince !== null && now - match.emptySince >= this.config.idleShutdownMs) {
				this.log.info("closing idle match", { match: match.id });
				this.stopMatch(match);
				idle -= 1;
			}
		}
		// Partidas prontas (ou abrindo) sem ninguém, para quem chegar entrar na hora.
		let warm = [...this.matches.values()].filter((match) => match.status === "starting" || this.isIdle(match)).length;
		while (warm < this.config.warmMatches && this.spawnMatch() !== null) {
			warm += 1;
		}
	}

	/** Um evento do servidor da partida `id` (ver protocol.ts). */
	handleEvent(id: string, event: ServerEvent): void {
		const match = this.matches.get(id);
		if (match === undefined) {
			return;
		}
		switch (event.event) {
			case "ready":
				if (event.version !== this.config.protocolVersion) {
					this.log.error("match server has another protocol version", {
						match: id, version: event.version, expected: this.config.protocolVersion,
					});
					// Build errado não se conserta sozinho: não fica abrindo outro a cada segundo.
					this.spawnFailures += 1;
					this.spawnBlockedUntil = this.now()
						+ Math.min(SPAWN_BACKOFF_MAX_MS, SPAWN_BACKOFF_FIRST_MS * 2 ** (this.spawnFailures - 1));
					this.stopMatch(match);
					return;
				}
				if (match.status === "starting") {
					match.status = "waiting";
				}
				// A espera para abrir não conta no tempo de quem já tinha vaga guardada.
				for (const ticket of match.reservations.keys()) {
					match.reservations.set(ticket, this.now() + this.config.reservationMs);
				}
				this.updateEmpty(match);
				this.settle(match);
				this.spawnFailures = 0;
				this.spawnBlockedUntil = 0;
				this.log.info("match ready", { match: id, port: match.port });
				break;
			case "status": {
				const before = match.humans;
				match.humans = event.humans;
				match.timeLeft = event.timeLeft;
				if (match.status !== "stopping" && match.status !== "starting") {
					match.status = event.state;
				}
				// Chegou gente: as vagas guardadas mais antigas foram ocupadas.
				for (let arrived = event.humans - before; arrived > 0 && match.reservations.size > 0; arrived -= 1) {
					const oldest = [...match.reservations.entries()].sort((a, b) => a[1] - b[1])[0];
					if (oldest !== undefined) {
						match.reservations.delete(oldest[0]);
					}
				}
				this.updateEmpty(match);
				break;
			}
			case "bye":
				this.log.info("match server closing", { match: id, reason: event.reason });
				break;
		}
	}

	/** O processo da partida `id` acabou (fechou, caiu ou foi fechado). */
	handleExit(id: string, code: number | null): void {
		const match = this.matches.get(id);
		if (match === undefined) {
			return;
		}
		this.matches.delete(id);
		if (match.readyTimer !== null) {
			clearTimeout(match.readyTimer);
		}
		const expected = match.status === "stopping";
		(expected ? this.log.info : this.log.warn)("match process exited", { match: id, code });
		// Nem chegou a abrir: espera antes de tentar outra (não fica abrindo e caindo sem parar).
		if (match.status === "starting") {
			this.spawnFailures += 1;
			const wait = Math.min(SPAWN_BACKOFF_MAX_MS, SPAWN_BACKOFF_FIRST_MS * 2 ** (this.spawnFailures - 1));
			this.spawnBlockedUntil = this.now() + wait;
			this.log.error("match server failed to start; waiting before the next try", {
				failures: this.spawnFailures, waitMs: wait,
			});
		}
		for (const waiter of match.waiters) {
			waiter.reject(new Error("match process exited"));
		}
		match.waiters = [];
	}

	/** Porta local da partida `id` pronta para receber gente (null = não existe ou não abriu). */
	portOf(id: string): number | null {
		const match = this.matches.get(id);
		if (match === undefined || match.status === "starting" || match.status === "stopping") {
			return null;
		}
		return match.port;
	}

	/** Fecha todas as partidas (desligando o serviço). */
	stopAll(): void {
		for (const match of this.matches.values()) {
			this.stopMatch(match);
		}
	}

	/** Quantas pessoas e partidas (API de status e logs). */
	summary(): { players: number; matches: MatchSummary[] } {
		const matches = [...this.matches.values()].map((match) => ({
			id: match.id, port: match.port, status: match.status, humans: match.humans, reserved: match.reservations.size,
		}));
		return { players: matches.reduce((total, match) => total + match.humans, 0), matches };
	}

	// -------------------------------------------------------------- escolha da partida

	private freeSlots(match: Match): number {
		return this.config.maxPlayers - match.humans - match.reservations.size;
	}

	// A mais cheia com vaga (enche uma antes de começar outra); partida acabando por último.
	private pickReady(): Match | null {
		const candidates = [...this.matches.values()].filter((match) =>
			(match.status === "waiting" || match.status === "running" || match.status === "finished")
			&& this.freeSlots(match) > 0);
		candidates.sort((a, b) =>
			Number(a.status === "finished") - Number(b.status === "finished")
			|| (b.humans + b.reservations.size) - (a.humans + a.reservations.size)
			|| a.createdAt - b.createdAt);
		return candidates[0] ?? null;
	}

	private pickStarting(): Match | null {
		for (const match of this.matches.values()) {
			if (match.status === "starting" && this.freeSlots(match) > 0) {
				return match;
			}
		}
		return null;
	}

	private spawnMatch(): Match | null {
		if (this.now() < this.spawnBlockedUntil) {
			return null;
		}
		const running = [...this.matches.values()].filter((match) => match.status !== "stopping").length;
		if (running >= this.config.maxMatches) {
			return null;
		}
		const used = new Set([...this.matches.values()].map((match) => match.port));
		let port = -1;
		for (let candidate = this.config.matchPortFirst; candidate <= this.config.matchPortLast; candidate += 1) {
			if (!used.has(candidate)) {
				port = candidate;
				break;
			}
		}
		if (port < 0) {
			return null;
		}
		const id = `m${this.nextId}`;
		this.nextId += 1;
		const match: Match = {
			id, port, status: "starting", humans: 0, reservations: new Map(), createdAt: this.now(),
			emptySince: null, timeLeft: 0, handle: null, waiters: [], readyTimer: null,
		};
		this.matches.set(id, match);
		this.log.info("starting match", { match: id, port });
		match.handle = this.spawner.spawn({ id, port }, (event) => this.handleEvent(id, event),
				(code) => this.handleExit(id, code));
		match.readyTimer = setTimeout(() => {
			if (match.status === "starting") {
				this.log.error("match did not start in time", { match: id });
				this.stopMatch(match);
				this.handleExit(id, null);
			}
		}, this.config.spawnTimeoutMs);
		match.readyTimer.unref?.();
		return match;
	}

	private whenReady(match: Match): Promise<void> {
		if (match.status !== "starting") {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			match.waiters.push({ resolve, reject });
		});
	}

	// Ficou pronta: quem esperava recebe a resposta.
	private settle(match: Match): void {
		if (match.readyTimer !== null) {
			clearTimeout(match.readyTimer);
			match.readyTimer = null;
		}
		for (const waiter of match.waiters) {
			waiter.resolve();
		}
		match.waiters = [];
	}

	// -------------------------------------------------------------- vagas e partidas vazias

	private expireReservations(): void {
		const now = this.now();
		for (const match of this.matches.values()) {
			// Enquanto abre, a vaga não vence (quem pediu ainda está esperando a resposta).
			if (match.status === "starting") {
				continue;
			}
			for (const [ticket, expires] of match.reservations) {
				if (expires <= now) {
					match.reservations.delete(ticket);
				}
			}
			this.updateEmpty(match);
		}
	}

	private isIdle(match: Match): boolean {
		return (match.status === "waiting" || match.status === "running" || match.status === "finished")
			&& match.humans === 0 && match.reservations.size === 0;
	}

	private updateEmpty(match: Match): void {
		if (this.isIdle(match)) {
			match.emptySince ??= this.now();
		} else {
			match.emptySince = null;
		}
	}

	private stopMatch(match: Match): void {
		if (match.status === "stopping") {
			return;
		}
		match.status = "stopping";
		match.handle?.stop();
	}
}
