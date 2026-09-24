// Conversa entre o matchmaker e os servidores de partida (Godot sem tela).
//
// O matchmaker abre cada partida como um processo:
//   <godot> <godotArgs...> -- --server --port=<porta> --match-id=<id> --max-players=<n>
//       [--transport=websocket --bind=127.0.0.1]   (WebSocket: só o matchmaker conecta nela)
// e o servidor escreve na saída padrão uma linha por evento, começando com "NEPHELIA ":
//   NEPHELIA {"event":"ready","port":24700,"version":1}
//   NEPHELIA {"event":"status","humans":2,"state":"running","time_left":123.4}
//   NEPHELIA {"event":"bye","reason":"..."}
// O resto da saída é log do Godot.

export const LINE_PREFIX = "NEPHELIA ";

/** Estado da partida contado pelo servidor. */
export type MatchPhase = "waiting" | "running" | "finished";

export type ServerEvent =
	| { event: "ready"; port: number; version: number }
	| { event: "status"; humans: number; state: MatchPhase; timeLeft: number }
	| { event: "bye"; reason: string };

const PHASES: readonly string[] = ["waiting", "running", "finished"];

/** Lê uma linha da saída do servidor. Devolve null se não é um evento (ou veio estragado). */
export function parseServerLine(line: string): ServerEvent | null {
	if (!line.startsWith(LINE_PREFIX)) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(line.slice(LINE_PREFIX.length));
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) {
		return null;
	}
	const record = data as Record<string, unknown>;
	switch (record["event"]) {
		case "ready":
			if (isInt(record["port"]) && isInt(record["version"])) {
				return { event: "ready", port: record["port"], version: record["version"] };
			}
			return null;
		case "status":
			if (isInt(record["humans"]) && record["humans"] >= 0 && typeof record["state"] === "string"
					&& PHASES.includes(record["state"])) {
				const timeLeft = typeof record["time_left"] === "number" ? record["time_left"] : 0;
				return { event: "status", humans: record["humans"], state: record["state"] as MatchPhase, timeLeft };
			}
			return null;
		case "bye":
			return { event: "bye", reason: typeof record["reason"] === "string" ? record["reason"] : "" };
		default:
			return null;
	}
}

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** Argumentos depois do "--" que o servidor de partida entende. */
export function serverArgs(port: number, matchId: string, maxPlayers: number, websocket = false): string[] {
	const args = ["--server", `--port=${port}`, `--match-id=${matchId}`, `--max-players=${maxPlayers}`];
	if (websocket) {
		args.push("--transport=websocket", "--bind=127.0.0.1");
	}
	return args;
}
