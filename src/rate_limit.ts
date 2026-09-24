// Limite de pedidos por IP (balde de fichas): `burst` de uma vez e `perMinute` repondo aos poucos.

export class RateLimiter {
	private readonly perMinute: number;
	private readonly burst: number;
	private readonly now: () => number;
	private readonly buckets = new Map<string, { tokens: number; updated: number }>();

	constructor(perMinute: number, burst: number, now: () => number = Date.now) {
		this.perMinute = perMinute;
		this.burst = burst;
		this.now = now;
	}

	/** Gasta uma ficha de `key`; false = passou do limite. */
	take(key: string): boolean {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
		bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.updated) / 60_000) * this.perMinute);
		bucket.updated = now;
		const allowed = bucket.tokens >= 1;
		if (allowed) {
			bucket.tokens -= 1;
		}
		this.buckets.set(key, bucket);
		return allowed;
	}

	/** Esquece quem já voltou a ter o balde cheio (chamar de vez em quando). */
	prune(): void {
		const now = this.now();
		for (const [key, bucket] of this.buckets) {
			if (bucket.tokens + ((now - bucket.updated) / 60_000) * this.perMinute >= this.burst) {
				this.buckets.delete(key);
			}
		}
	}

	get size(): number {
		return this.buckets.size;
	}
}
