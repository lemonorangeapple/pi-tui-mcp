import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAction, INITIAL_PANEL_MODE, isVisible, stepAside, type PanelMode } from "../src/panel.ts";

test("a new session starts with the automatic panel", () => {
	assert.equal(INITIAL_PANEL_MODE, "auto");
});

test("only hidden is not visible", () => {
	assert.deepEqual(
		(["auto", "pinned", "hidden"] as PanelMode[]).map(isVisible),
		[true, true, false],
	);
});

test("on pins, off hides, toggle flips visibility", () => {
	assert.equal(applyAction("auto", "on"), "pinned");
	assert.equal(applyAction("hidden", "on"), "pinned");
	assert.equal(applyAction("pinned", "off"), "hidden");
	assert.equal(applyAction("auto", "off"), "hidden");
	assert.equal(applyAction("auto", "toggle"), "hidden");
	assert.equal(applyAction("pinned", "toggle"), "hidden");
	assert.equal(applyAction("hidden", "toggle"), "pinned");
});

test("only the automatic panel steps aside", () => {
	assert.equal(stepAside("auto"), "hidden");
	assert.equal(stepAside("pinned"), "pinned");
	assert.equal(stepAside("hidden"), "hidden");
});
