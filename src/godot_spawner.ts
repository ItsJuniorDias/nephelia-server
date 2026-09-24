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
		errors.on("line", (line) => {
			// O Godot escreve avisos e erros aqui; guarda só as linhas de erro de verdade.
			if (/ERROR|SCRIPT ERROR/.test(line)) {
				this.log.warn("match server stderr", { match: match.id, line: line.slice(0, 500) });
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
