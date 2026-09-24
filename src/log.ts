// Log em uma linha JSON por evento (o journald do systemd guarda; fácil de filtrar).

export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): Logger {
	const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
		write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
	};
	return {
		info: (message, fields) => emit("info", message, fields),
		warn: (message, fields) => emit("warn", message, fields),
		error: (message, fields) => emit("error", message, fields),
	};
}

/** Logger que não escreve nada (testes). */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
