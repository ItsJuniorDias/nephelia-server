import assert from "node:assert/strict";
import { test } from "node:test";
import { envName, loadConfig } from "../src/config.ts";
import { parseServerLine, serverArgs } from "../src/protocol.ts";

test("reads the match server events", () => {
	assert.deepEqual(parseServerLine('NEPHELIA {"event":"ready","port":24700,"version":1}'),
		{ event: "ready", port: 24700, version: 1 });
	assert.deepEqual(parseServerLine('NEPHELIA {"event":"status","humans":2,"state":"running","time_left":120.5}'),
		{ event: "status", humans: 2, state: "running", timeLeft: 120.5 });
	assert.deepEqual(parseServerLine('NEPHELIA {"event":"bye","reason":"stopping"}'), { event: "bye", reason: "stopping" });
});

test("ignores Godot log lines and broken events", () => {
	for (const line of [
		"Godot Engine v4.7.2.stable.official",
		"NEPHELIA not json",
		'NEPHELIA {"event":"status","humans":-1,"state":"running"}',
		'NEPHELIA {"event":"status","humans":1,"state":"dancing"}',
		'NEPHELIA {"event":"ready","port":"24700","version":1}',
		'NEPHELIA {"event":"unknown"}',
		"NEPHELIA null",
	]) {
		assert.equal(parseServerLine(line), null, line);
	}
});

test("builds the match server arguments", () => {
	assert.deepEqual(serverArgs(24701, "m3", 4), ["--server", "--port=24701", "--match-id=m3", "--max-players=4"]);
});

test("config comes from NEPHELIA_* variables and --key=value arguments", () => {
	assert.equal(envName("matchPortFirst"), "NEPHELIA_MATCH_PORT_FIRST");
	const config = loadConfig(
		{ NEPHELIA_PUBLIC_HOST: "game.example.com", NEPHELIA_MAX_MATCHES: "3", NEPHELIA_GODOT_ARGS: "--headless --path /game" },
		["--httpPort=9000", "--trustProxy=true"],
	);
	assert.equal(config.publicHost, "game.example.com");
	assert.equal(config.maxMatches, 3);
	assert.deepEqual(config.godotArgs, ["--headless", "--path", "/game"]);
	assert.equal(config.httpPort, 9000);
	assert.equal(config.trustProxy, true);
	assert.throws(() => loadConfig({ NEPHELIA_MAX_MATCHES: "lots" }, []));
	assert.throws(() => loadConfig({ NEPHELIA_MATCH_PORT_FIRST: "25000", NEPHELIA_MATCH_PORT_LAST: "24000" }, []));
});
