// Abre as partidas: um processo do Godot sem tela por partida (ver protocol.ts para a conversa).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import type { MatchHandle, Spawner } from "./matchmaker.ts";
import { parseServerLine, serverArgs } from "./protocol.ts";
import type { ServerEvent } from "./protocol.ts";

/** Depois de pedir para fechar, espera isto e fecha à força. */
const KILL_AFTER_MS = 5_000;
/** A mesma linha de erro vai para o log no máximo uma vez a cada isto (as outras só contam). */
const REPEAT_WINDOW_MS = 60_000;
/** Quantas linhas diferentes a conta guarda (as mais antigas saem). */
const REPEAT_MEMORY = 100;

/**
 * Segura as linhas de erro repetidas de uma partida. No Render a própria plataforma sonda as portas
 * abertas da máquina com pedidos HTTP simples (não são jogadores) e o servidor da partida reclama
 * de cada um ("Not enough response headers"): era uma linha por segundo no log.
 */
export class RepeatFilter {
	private readonly now: () => number;
	private readonly lines = new Map<string, { loggedAt: number; skipped: number }>();

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** null = linha repetida há pouco (só conta); senão, quantas vezes ela repetiu sem ir para o log. */
	accept(line: string): number | null {
		const now = this.now();
		const seen = this.lines.get(line);
		if (seen !== undefined && now - seen.loggedAt < REPEAT_WINDOW_MS) {
			seen.skipped += 1;
			return null;
		}
		this.lines.delete(line);
		this.lines.set(line, { loggedAt: now, skipped: 0 });
		if (this.lines.size > REPEAT_MEMORY) {
			const oldest = this.lines.keys().next().value;
			if (oldest !== undefined) {
				this.lines.delete(oldest);
			}
		}
		return seen?.skipped ?? 0;
	}
}

export class GodotSpawner implements Spawner {
	private readonly config: Config;
	private readonly log: Logger;

	constructor(config: Config, log: Logger) {
		this.config = config;
		this.log = log;
	}

	spawn(
		match: { id: string; port: number },
		onEvent: (event: ServerEvent) => void,
		onExit: (code: number | null) => void,
	): MatchHandle {
		const args = [...this.config.godotArgs, "--",
			...serverArgs(match.port, match.id, this.config.maxPlayers, this.config.transport === "websocket")];
		const child = spawn(this.config.godotBin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let exited = false;
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const event = parseServerLine(line);
			if (event !== null) {
				onEvent(event);
			}
		});
		const errors = createInterface({ input: child.stderr });
		const repeats = new RepeatFilter();
		errors.on("line", (line) => {
			// O Godot escreve avisos e erros aqui; guarda só as linhas de erro de verdade.
			if (!/ERROR|SCRIPT ERROR/.test(line)) {
				return;
			}
			const text = line.slice(0, 500);
			const repeated = repeats.accept(text);
			if (repeated !== null) {
				this.log.warn("match server stderr", { match: match.id, line: text, ...(repeated > 0 ? { repeated } : {}) });
			}
		});
		child.on("error", (error) => {
			this.log.error("could not start match server", { match: match.id, error: error.message });
			if (!exited) {
				exited = true;
				onExit(null);
			}
		});
		child.on("exit", (code) => {
			if (!exited) {
				exited = true;
				onExit(code);
			}
		});
		return {
			stop: () => {
				if (exited) {
					return;
				}
				child.kill("SIGTERM");
				const timer = setTimeout(() => {
					if (!exited) {
						child.kill("SIGKILL");
					}
				}, KILL_AFTER_MS);
				timer.unref();
			},
		};
	}
}
