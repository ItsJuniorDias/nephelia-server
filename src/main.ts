// Liga o matchmaker: API HTTP + partidas (servidores dedicados do Godot).
//   node src/main.ts [--httpPort=8080] [--godotBin=...] [--godotArgs="--headless --path /jogo"] ...
// Configuração em config.ts / .env.example.

import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { loadConfig } from "./config.ts";
import { GodotSpawner } from "./godot_spawner.ts";
import { createApi } from "./http_api.ts";
import { jsonLogger } from "./log.ts";
import { Matchmaker } from "./matchmaker.ts";

const log = jsonLogger();
const config = loadConfig();
const matchmaker = new Matchmaker(config, new GodotSpawner(config, log), Date.now, log);
const server = createApi(matchmaker, config, log);

// Sem o Godot ou sem o pacote do jogo não há como abrir partida: avisa logo ao ligar.
if (!executableExists(config.godotBin)) {
	log.error("match server executable not found: set NEPHELIA_GODOT_BIN (see README)", {
		godotBin: config.godotBin,
	});
}
const packIndex = config.godotArgs.indexOf("--main-pack");
const pack = packIndex >= 0 ? config.godotArgs[packIndex + 1] : undefined;
if (pack !== undefined && !existsSync(pack)) {
	log.error("game pack not found: export the game's \"Linux Server\" preset to this path (see README)", { pack });
}

const ticker = setInterval(() => matchmaker.tick(), 1_000);
matchmaker.tick();

server.listen(config.httpPort, config.httpHost, () => {
	log.info("matchmaker listening", {
		http: `${config.httpHost}:${config.httpPort}`, publicHost: config.publicHost,
		ports: `${config.matchPortFirst}-${config.matchPortLast}`, maxMatches: config.maxMatches,
		maxPlayers: config.maxPlayers, protocolVersion: config.protocolVersion,
	});
});

function executableExists(command: string): boolean {
	const candidates = isAbsolute(command) || command.includes("/")
		? [command]
		: (process.env["PATH"] ?? "").split(delimiter).map((folder) => join(folder, command));
	return candidates.some((path) => {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

let closing = false;
function shutdown(signal: string): void {
	if (closing) {
		return;
	}
	closing = true;
	log.info("shutting down", { signal });
	clearInterval(ticker);
	matchmaker.stopAll();
	server.close();
	// Dá tempo das partidas fecharem (o spawner força depois de 5 s).
	setTimeout(() => process.exit(0), 6_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
