import assert from "node:assert/strict";
import { test } from "node:test";
import { RepeatFilter } from "../src/godot_spawner.ts";
import { Clock } from "./helpers.ts";

test("a repeated stderr line is logged once a minute, with the count", () => {
	const clock = new Clock();
	const filter = new RepeatFilter(clock.now);
	const probe = "ERROR: Not enough response headers, got: 3, expected >= 4.";
	assert.equal(filter.accept(probe), 0);
	for (let second = 1; second < 60; second += 1) {
		clock.advance(1_000);
		assert.equal(filter.accept(probe), null);
	}
	// Uma linha diferente não espera.
	assert.equal(filter.accept("ERROR: something else"), 0);
	clock.advance(1_000);
	assert.equal(filter.accept(probe), 59);
	assert.equal(filter.accept(probe), null);
});

test("the filter forgets the oldest lines instead of growing forever", () => {
	const clock = new Clock();
	const filter = new RepeatFilter(clock.now);
	for (let index = 0; index < 150; index += 1) {
		assert.equal(filter.accept(`ERROR: line ${index}`), 0);
	}
	// A primeira saiu da memória: volta a aparecer; a última ainda está segurada.
	assert.equal(filter.accept("ERROR: line 0"), 0);
	assert.equal(filter.accept("ERROR: line 149"), null);
});
