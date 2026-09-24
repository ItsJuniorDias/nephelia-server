// Configuração do matchmaker: variáveis de ambiente NEPHELIA_* (ver .env.example) e, por cima,
// argumentos --chave=valor na linha de comando (útil nos testes e para rodar local).
//
// No Render (variável RENDER=true, posta por ele) o que não foi configurado vem de lá: a porta
// (PORT), a conexão das partidas por WebSocket (o Render não aceita UDP), o endereço público
// (RENDER_EXTERNAL_URL, https -> wss), o Godot baixado no build (./bin/godot) e uma partida por vez
// (a máquina é pequena).

export interface Config {
	/** Como os jogadores conectam nas partidas: "enet" (UDP direto, VPS) ou "websocket" (pelo
	 * matchmaker, em wss://<publicUrl>/play/<partida>: Render e parecidos). */
	transport: "enet" | "websocket";
	/** Endereço público do matchmaker para o WebSocket (ex.: "wss://nephelia.onrender.com"). */
	publicUrl: string;
	/** Porta e endereço em que a API HTTP escuta. */
	httpPort: number;
	httpHost: string;
	/** Endereço que os jogadores usam para chegar nas partidas (IP público ou domínio). */
	publicHost: string;
	/** Executável do Godot (ou do servidor exportado) e argumentos antes do "--". */
	godotBin: string;
	godotArgs: string[];
	/** Faixa de portas UDP das partidas (inclusive). */
	matchPortFirst: number;
	matchPortLast: number;
	/** Partidas rodando ao mesmo tempo, no máximo. */
	maxMatches: number;
	/** Pessoas por partida (os bots completam o resto). */
	maxPlayers: number;
	/** Partidas vazias já abertas, esperando gente (entrar é na hora). */
	warmMatches: number;
	/** Partida sem ninguém fecha depois deste tempo (se sobrar mais que `warmMatches`). */
	idleShutdownMs: number;
	/** Vaga guardada para quem acabou de pedir partida, até ele entrar. */
	reservationMs: number;
	/** Tempo máximo para uma partida nova ficar pronta. */
	spawnTimeoutMs: number;
	/** Versão do protocolo de rede do jogo (NetMessage.VERSION): cliente diferente é recusado. */
	protocolVersion: number;
	/** Pedidos de partida por minuto e rajada, por IP. */
	rateLimitPerMinute: number;
	rateLimitBurst: number;
	/** Ler o IP do cliente de X-Forwarded-For (só atrás de um proxy de confiança). */
	trustProxy: boolean;
}

const DEFAULTS: Config = {
	transport: "enet",
	publicUrl: "",
	httpPort: 8080,
	httpHost: "0.0.0.0",
	publicHost: "127.0.0.1",
	godotBin: "godot",
	godotArgs: ["--headless"],
	matchPortFirst: 24700,
	matchPortLast: 24719,
	maxMatches: 8,
	maxPlayers: 4,
	warmMatches: 1,
	idleShutdownMs: 120_000,
	reservationMs: 20_000,
	spawnTimeoutMs: 30_000,
	protocolVersion: 1,
	rateLimitPerMinute: 12,
	rateLimitBurst: 4,
	trustProxy: false,
};

/** Nome da variável de ambiente de cada campo: httpPort -> NEPHELIA_HTTP_PORT. */
export function envName(key: string): string {
	return "NEPHELIA_" + key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase();
}

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv.slice(2),
): Config {
	const overrides: Record<string, string> = {};
	for (const key of Object.keys(DEFAULTS)) {
		const value = env[envName(key)];
		if (value !== undefined && value !== "") {
			overrides[key] = value;
		}
	}
	for (const arg of argv) {
		const match = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
		if (match?.[1] !== undefined && match[2] !== undefined && match[1] in DEFAULTS) {
			overrides[match[1]] = match[2];
		}
	}
	const config: Config = { ...DEFAULTS, godotArgs: [...DEFAULTS.godotArgs] };
	if (env["RENDER"] === "true") {
		applyRenderDefaults(config, env);
	}
	for (const [key, raw] of Object.entries(overrides)) {
		setField(config, key as keyof Config, raw);
	}
	validate(config);
	return config;
}

// Render: só HTTP(S) por uma porta, máquina pequena, Godot baixado no build (scripts/install_godot.sh).
function applyRenderDefaults(config: Config, env: Record<string, string | undefined>): void {
	config.transport = "websocket";
	config.httpPort = Number(env["PORT"] ?? 10000);
	config.publicUrl = (env["RENDER_EXTERNAL_URL"] ?? "").replace(/^http/, "ws");
	config.godotBin = "./bin/godot";
	config.godotArgs = ["--headless", "--main-pack", "./game/nephelia_server.pck"];
	config.maxMatches = 1;
	config.warmMatches = 1;
}

function setField(config: Config, key: keyof Config, raw: string): void {
	const current = DEFAULTS[key];
	if (typeof current === "number") {
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			throw new Error(`${envName(key)}: número inválido "${raw}"`);
		}
		(config as unknown as Record<string, unknown>)[key] = value;
	} else if (typeof current === "boolean") {
		(config as unknown as Record<string, unknown>)[key] = raw === "1" || raw.toLowerCase() === "true";
	} else if (Array.isArray(current)) {
		(config as unknown as Record<string, unknown>)[key] = raw.split(/\s+/).filter((part) => part.length > 0);
	} else {
		(config as unknown as Record<string, unknown>)[key] = raw;
	}
}

function validate(config: Config): void {
	if (config.transport !== "enet" && config.transport !== "websocket") {
		throw new Error(`NEPHELIA_TRANSPORT inválido "${String(config.transport)}" (enet ou websocket)`);
	}
	if (config.transport === "websocket" && !/^wss?:\/\//.test(config.publicUrl)) {
		throw new Error("com NEPHELIA_TRANSPORT=websocket, NEPHELIA_PUBLIC_URL precisa ser wss://... (ou ws://)");
	}
	if (config.matchPortLast < config.matchPortFirst) {
		throw new Error("NEPHELIA_MATCH_PORT_LAST é menor que NEPHELIA_MATCH_PORT_FIRST");
	}
	if (config.maxPlayers < 1 || config.maxMatches < 1) {
		throw new Error("maxPlayers e maxMatches precisam ser pelo menos 1");
	}
	if (config.warmMatches > config.maxMatches) {
		throw new Error("warmMatches não pode passar de maxMatches");
	}
}
