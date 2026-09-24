// Ajudantes dos testes: configuração, relógio controlado e servidor de partida de mentira.

import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import type { MatchHandle, Spawner } from "../src/matchmaker.ts";
import type { ServerEvent } from "../src/protocol.ts";

export function testConfig(overrides: Partial<Config> = {}): Config {
	return { ...loadConfig({}, []), warmMatches: 0, ...overrides };
}

export class Clock {
	time = 1_000_000;
	now = (): number => this.time;
	advance(ms: number): void {
		this.time += ms;
	}
}

export interface FakeMatch {
	id: string;
	port: number;
	stopped: boolean;
	emit(event: ServerEvent): void;
	exit(code: number | null): void;
}

/** Guarda cada partida "aberta"; o teste manda os eventos (ready, status) e fecha quando quiser. */
export class FakeSpawner implements Spawner {
	readonly spawned: FakeMatch[] = [];
	/** Abre já pronta (manda "ready" logo depois de abrir). */
	autoReady = true;
	version = 1;

	spawn(
		match: { id: string; port: number },
		onEvent: (event: ServerEvent) => void,
		onExit: (code: number | null) => void,
	): MatchHandle {
		const fake: FakeMatch = {
			id: match.id,
			port: match.port,
			stopped: false,
			emit: onEvent,
			exit: onExit,
		};
		this.spawned.push(fake);
		if (this.autoReady) {
			queueMicrotask(() => onEvent({ event: "ready", port: match.port, version: this.version }));
		}
		return {
			stop: () => {
				fake.stopped = true;
				queueMicrotask(() => onExit(0));
			},
		};
	}
}

/** Espera as tarefas já agendadas rodarem (microtarefas e um giro do laço). */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
