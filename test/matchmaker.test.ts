import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Matchmaker } from "../src/matchmaker.ts";
import { Clock, FakeSpawner, flush, testConfig } from "./helpers.ts";

const request = { version: 1, name: "Alex", platform: "ios" };

describe("Matchmaker", () => {
	test("a different game version is told to update", async () => {
		const matchmaker = new Matchmaker(testConfig(), new FakeSpawner());
		assert.deepEqual(await matchmaker.request({ ...request, version: 2 }), { ok: false, error: "update_required" });
	});

	test("the first request opens a match and answers once it is ready", async () => {
		const spawner = new FakeSpawner();
		const matchmaker = new Matchmaker(testConfig({ publicHost: "203.0.113.5" }), spawner);
		const result = await matchmaker.request(request);
		assert.equal(spawner.spawned.length, 1);
		assert.ok(result.ok);
		assert.equal(result.host, "203.0.113.5");
		assert.equal(result.port, 24700);
		assert.equal(result.match, spawner.spawned[0]?.id);
		assert.equal(matchmaker.summary().matches[0]?.reserved, 1);
	});

	test("four players share a match; the fifth opens another one", async () => {
		const spawner = new FakeSpawner();
		const matchmaker = new Matchmaker(testConfig({ maxPlayers: 4 }), spawner);
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => matchmaker.request(request)));
		const ports = results.map((result) => (result.ok ? result.port : -1));
		assert.deepEqual(ports, [24700, 24700, 24700, 24700, 24701]);
		assert.equal(spawner.spawned.length, 2);
	});

	test("players go to the fullest match that still has room", async () => {
		const spawner = new FakeSpawner();
		const matchmaker = new Matchmaker(testConfig({ maxPlayers: 4 }), spawner);
		// Duas partidas: a primeira com 3 pessoas, a segunda com 1.
		await Promise.all([1, 2, 3, 4, 5].map(() => matchmaker.request(request)));
		const [first, second] = spawner.spawned;
		first?.emit({ event: "status", humans: 3, state: "running", timeLeft: 200 });
		second?.emit({ event: "status", humans: 1, state: "running", timeLeft: 200 });
		// As vagas guardadas foram ocupadas (1 na primeira ainda sobra: 4 pedidos, 3 chegaram).
		const summary = matchmaker.summary().matches;
		assert.equal(summary[0]?.reserved, 1);
		assert.equal(summary[1]?.reserved, 0);
		const result = await matchmaker.request(request);
		// A primeira está cheia (3 + 1 guardada): vai para a segunda.
		assert.ok(result.ok);
		assert.equal(result.port, second?.port);
	});

	test("a saved spot expires if the player never shows up", async () => {
		const clock = new Clock();
		const spawner = new FakeSpawner();
		const matchmaker = new Matchmaker(testConfig({ reservationMs: 20_000 }), spawner, clock.now);
		await matchmaker.request(request);
		assert.equal(matchmaker.summary().matches[0]?.reserved, 1);
		clock.advance(19_000);
		matchmaker.tick();
		assert.equal(matchmaker.summary().matches[0]?.reserved, 1);
		clock.advance(2_000);
		matchmaker.tick();
		assert.equal(matchmaker.summary().matches[0]?.reserved, 0);
	});

	test("empty matches close after a while, but the warm ones stay", async () => {
		const clock = new Clock();
		const spawner = new FakeSpawner();
		const config = testConfig({ warmMatches: 1, idleShutdownMs: 60_000, reservationMs: 1_000 });
		const matchmaker = new Matchmaker(config, spawner, clock.now);
		matchmaker.tick();
		await flush();
		assert.equal(spawner.spawned.length, 1, "opens a warm match right away");
		// Duas pessoas: uma na pronta, e a pronta continua servindo (não abre outra à toa).
		await matchmaker.request(request);
		spawner.spawned[0]?.emit({ event: "status", humans: 1, state: "running", timeLeft: 200 });
		matchmaker.tick();
		await flush();
		assert.equal(spawner.spawned.length, 2, "keeps one empty match ready");
		// A pessoa sai: agora há duas vazias, uma fecha depois do tempo.
		spawner.spawned[0]?.emit({ event: "status", humans: 0, state: "waiting", timeLeft: 300 });
		clock.advance(59_000);
		matchmaker.tick();
		assert.equal(spawner.spawned.filter((match) => match.stopped).length, 0);
		clock.advance(2_000);
		matchmaker.tick();
		await flush();
		assert.equal(spawner.spawned.filter((match) => match.stopped).length, 1);
		assert.equal(matchmaker.summary().matches.length, 1);
	});

	test("no capacity when every match is full", async () => {
		const spawner = new FakeSpawner();
		const matchmaker = new Matchmaker(testConfig({ maxPlayers: 2, maxMatches: 1 }), spawner);
		assert.ok((await matchmaker.request(request)).ok);
		assert.ok((await matchmaker.request(request)).ok);
		assert.deepEqual(await matchmaker.request(request), { ok: false, error: "no_capacity" });
	});

	test("a match that crashes while starting fails the waiting request", async () => {
		const spawner = new FakeSpawner();
		spawner.autoReady = false;
		const matchmaker = new Matchmaker(testConfig(), spawner);
		const pending = matchmaker.request(request);
		await flush();
		spawner.spawned[0]?.exit(1);
		assert.deepEqual(await pending, { ok: false, error: "match_failed" });
		assert.equal(matchmaker.summary().matches.length, 0);
	});

	test("a match that never gets ready is closed after the timeout", async () => {
		const spawner = new FakeSpawner();
		spawner.autoReady = false;
		const matchmaker = new Matchmaker(testConfig({ spawnTimeoutMs: 50 }), spawner);
		const result = await matchmaker.request(request);
		assert.deepEqual(result, { ok: false, error: "match_failed" });
		assert.equal(spawner.spawned[0]?.stopped, true);
	});

	test("a match server built with another version is closed", async () => {
		const spawner = new FakeSpawner();
		spawner.version = 7;
		const matchmaker = new Matchmaker(testConfig({ spawnTimeoutMs: 100 }), spawner);
		const result = await matchmaker.request(request);
		assert.equal(result.ok, false);
		assert.equal(spawner.spawned[0]?.stopped, true);
	});
});
