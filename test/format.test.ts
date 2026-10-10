import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ServerInfo } from "../src/config.ts";
import {
	buildLines,
	coloredIndicatorText,
	detailText,
	indicatorText,
	summaryText,
	tally,
} from "../src/format.ts";
import type { ServerState, ServerStatus } from "../src/status.ts";

function status(name: string, state: ServerState, tools = 0, waitedMs = 0): ServerStatus {
	const server: ServerInfo = { name, enabled: state !== "disabled", exposure: "codemode", config: {} };
	return { server, tools, state, waitedMs };
}

/** Marks every colored span as `<color>text</color>`, so colors can be asserted. */
const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Theme;
const plain = { fg: (_color: string, text: string) => text } as unknown as Theme;

test("tally counts by state; disabled servers are not enabled", () => {
	const result = tally([
		status("a", "connected", 2),
		status("b", "connecting"),
		status("c", "unresponsive"),
		status("d", "disabled"),
		status("e", "connected", 1),
	]);
	assert.deepEqual(result, { enabled: 4, connected: 2, connecting: 1, failed: 1 });
});

test("summaryText flags failures", () => {
	assert.equal(summaryText([status("a", "connected", 1), status("b", "connecting")]), "MCP 1/2");
	assert.equal(summaryText([status("a", "connected", 1), status("b", "unresponsive")]), "MCP 1/2 · 1!");
	assert.equal(summaryText([status("a", "disabled")]), "MCP 0/0");
});

test("indicatorText: the worst state wins", () => {
	assert.equal(indicatorText([]), null);
	assert.equal(indicatorText([status("a", "connected", 1)]), "● MCP 1/1");
	assert.equal(indicatorText([status("a", "connected", 1), status("b", "connecting")]), "◌ MCP 1/2");
	assert.equal(indicatorText([status("a", "connecting"), status("b", "unresponsive")]), "✗ MCP 0/2");
	assert.equal(indicatorText([status("a", "disabled")]), "– MCP");
});

test("coloredIndicatorText colors by the worst state", () => {
	const color = (statuses: ServerStatus[]) => coloredIndicatorText(statuses, theme);
	assert.equal(color([status("a", "connected", 1)]), "<success>● MCP 1/1</success>");
	assert.equal(color([status("a", "connecting")]), "<accent>◌ MCP 0/1</accent>");
	assert.equal(color([status("a", "connecting"), status("b", "unresponsive")]), "<error>✗ MCP 0/2</error>");
	assert.equal(color([status("a", "disabled")]), "<dim>– MCP</dim>");
	assert.equal(color([]), null);
});

test("detailText lists the worst servers first, then by name, with tool counts", () => {
	const text = detailText([
		status("zeta", "connected", 3),
		status("alpha", "connected", 1),
		status("off", "disabled"),
		status("slow", "connecting"),
		status("bad", "unresponsive"),
	]);
	assert.equal(text, "✗bad ◌slow ✓alpha(1) ✓zeta(3) –off");
});

test("buildLines: header, rows aligned by name, and the hint", () => {
	const lines = buildLines(
		[status("github", "connected", 42), status("fs", "connecting", 0, 3000), status("old", "disabled")],
		[],
		plain,
		true,
	);
	assert.deepEqual(lines, [
		"MCP 1/2 connected",
		" ◌ fs      connecting… · codemode",
		" ✓ github  42 tools · codemode",
		" – old     codemode",
		" /mcp-status to toggle · /mcp to manage",
	]);
});

test("buildLines: a slow connect shows how long it has waited", () => {
	const lines = buildLines([status("fs", "connecting", 0, 23_400)], [], plain, false);
	assert.match(lines[1] ?? "", /connecting 23s/);
});

test("buildLines: one tool is singular, a failure says why it may have failed", () => {
	const lines = buildLines([status("a", "connected", 1), status("b", "unresponsive")], [], plain, false);
	assert.match(lines[0] ?? "", /1 unresponsive/);
	assert.ok(lines.some((line) => /✗ b\s+failed or needs sign-in/.test(line)));
	assert.ok(lines.some((line) => /✓ a\s+1 tool ·/.test(line)));
});

test("buildLines: names longer than 24 characters are cut so the columns stay aligned", () => {
	const long = "a-very-long-server-name-that-keeps-going";
	const lines = buildLines([status(long, "connected", 1), status("b", "connected", 1)], [], plain, false);
	const row = lines.find((line) => line.includes("a-very-long")) ?? "";
	assert.ok(row.includes(`${long.slice(0, 23)}…`), row);
	assert.ok(!row.includes(long));
	const other = lines.find((line) => /✓ b/.test(line)) ?? "";
	assert.equal(row.indexOf("1 tool"), other.indexOf("1 tool"));
});

test("buildLines: more than 12 servers are summarized, as are more than 3 errors", () => {
	const statuses = Array.from({ length: 15 }, (_, i) => status(`s${String(i).padStart(2, "0")}`, "connected", 1));
	const errors = ["e1", "e2", "e3", "e4", "e5"];
	const lines = buildLines(statuses, errors, plain, false);
	assert.equal(lines.filter((line) => /✓ s\d\d/.test(line)).length, 12);
	assert.ok(lines.includes(" … 3 more"));
	assert.ok(lines.includes(" ! e3"));
	assert.ok(!lines.includes(" ! e4"));
	assert.ok(lines.includes(" … 2 more errors"));
	assert.match(lines[0] ?? "", /5 config errors/);
});

test("buildLines: only errors, no servers", () => {
	const lines = buildLines([], ["bad file"], plain, false);
	assert.deepEqual(lines, ["MCP 0/0 connected · 1 config error", " ! bad file"]);
});

test("buildLines colors the mark and the description by state", () => {
	const lines = buildLines([status("a", "unresponsive")], [], theme, false);
	assert.ok(lines[1]?.includes("<error>✗</error>"), lines[1]);
	assert.ok(lines[1]?.includes("<error>failed or needs sign-in · codemode</error>"), lines[1]);
});
