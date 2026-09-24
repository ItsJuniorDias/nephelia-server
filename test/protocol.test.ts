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
	assert.deepEqual(serverArgs(24701, "m3", 4, true).slice(-2), ["--transport=websocket", "--bind=127.0.0.1"]);
});

test("on Render the defaults come from its variables (WebSocket, PORT, public address)", () => {
	const config = loadConfig({ RENDER: "true", PORT: "10000", RENDER_EXTERNAL_URL: "https://nephelia-server.onrender.com" }, []);
	assert.equal(config.transport, "websocket");
	assert.equal(config.httpPort, 10000);
	assert.equal(config.publicUrl, "wss://nephelia-server.onrender.com");
	assert.equal(config.godotBin, "./bin/godot");
	assert.equal(config.maxMatches, 1);
	// O que foi configurado à mão continua valendo.
	assert.equal(loadConfig({ RENDER: "true", RENDER_EXTERNAL_URL: "https://x.onrender.com", NEPHELIA_MAX_MATCHES: "2" }, []).maxMatches, 2);
	assert.throws(() => loadConfig({ NEPHELIA_TRANSPORT: "websocket" }, []));
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
