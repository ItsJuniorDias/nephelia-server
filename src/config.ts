// Configuração do matchmaker: variáveis de ambiente NEPHELIA_* (ver .env.example) e, por cima,
// argumentos --chave=valor na linha de comando (útil nos testes e para rodar local).

export interface Config {
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
	for (const [key, raw] of Object.entries(overrides)) {
		setField(config, key as keyof Config, raw);
	}
	validate(config);
	return config;
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
