import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createEnv } from "./helpers.ts";

afterEach(() => mock.timers.reset());

const FOOTER_WIDGETS = ["mcp_status", "mcp_servers", "mcp_indicator", "mcp_indicator_color"];

test("a server whose tools are registered shows as connected", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	assert.match(env.panelText() ?? "", /MCP 1\/1 connected/);
	assert.match(env.panelText() ?? "", /✓ a\s+1 tool · codemode/);
	assert.equal(env.ui.status, "MCP 1/1");
});

test("a server without tools is connecting, then unresponsive after the settle timeout, then recovers", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } } });
	env.startSession();
	assert.match(env.panelText() ?? "", /◌ a/);
	assert.equal(env.ui.status, "MCP 0/1");

	env.advance(15_300);
	assert.match(env.panelText() ?? "", /✗ a\s+failed or needs sign-in/);
	assert.equal(env.ui.status, "MCP 0/1 · 1!");

	// Late connect is picked up by the slow poll.
	env.state.toolNamespaces = ["mcp__a"];
	env.advance(3_100);
	assert.equal(env.ui.status, "MCP 1/1");
});

test("a disabled server is listed as disabled and does not count as enabled", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x", enabled: false } } } });
	env.startSession();
	assert.match(env.panelText() ?? "", /– a/);
	assert.equal(env.ui.status, "MCP 0/0");
});

test("a project entry without command/url overrides the global server", () => {
	const env = createEnv({
		globalConfig: { mcpServers: { a: { command: "x" } } },
		projectConfig: { mcpServers: { a: { enabled: false } } },
		toolNamespaces: [],
	});
	env.startSession();
	assert.match(env.panelText() ?? "", /– a/);
});

test("mcp.json wins over an extension-registered server of the same name", () => {
	const env = createEnv({
		globalConfig: { mcpServers: { dup: { command: "x", enabled: false } } },
		registered: [{ name: "dup", config: { command: "y" } }],
	});
	env.startSession();
	const rows = (env.ui.widget ?? []).filter((line) => line.includes("dup"));
	assert.equal(rows.length, 1);
	assert.match(rows[0] ?? "", /– dup/);
});

test("an extension-registered server is listed", () => {
	const env = createEnv({ registered: [{ name: "ext", config: { command: "y" } }], toolNamespaces: ["mcp__ext"] });
	env.startSession();
	assert.match(env.panelText() ?? "", /✓ ext/);
});

test("invalid entries are reported as config errors", () => {
	const env = createEnv({
		globalConfig: {
			mcpServers: {
				ok: { command: "x" },
				"bad name": { command: "x" },
				nocmd: {},
				badexp: { command: "x", exposure: "nope" },
			},
		},
		toolNamespaces: ["mcp__ok"],
	});
	env.startSession();
	assert.match(env.panelText() ?? "", /3 config errors/);
	assert.match(env.panelText() ?? "", /invalid server name "bad name"/);
});

test("the panel hides itself 3s after every server settled", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	env.advance(2_900);
	assert.ok(env.ui.widget, "still visible just before the delay");
	env.advance(200);
	assert.equal(env.ui.widget, undefined);
	assert.equal(env.ui.status, "MCP 1/1", "the footer status stays");
});

test("the first turn hides the panel while servers are still connecting", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } } });
	env.startSession();
	assert.ok(env.ui.widget);
	env.turnStart();
	assert.equal(env.ui.widget, undefined);
});

test("/mcp-status off hides and on shows the panel", async () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } } });
	env.startSession();
	await env.command("off");
	assert.equal(env.ui.widget, undefined);
	await env.command("on");
	assert.ok(env.ui.widget);
});

test("footer widgets are published once and only again on change", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	assert.deepEqual(env.emits.map((emit) => emit.widgetId).sort(), [...FOOTER_WIDGETS].sort());
	env.advance(2_000);
	assert.equal(env.emits.length, FOOTER_WIDGETS.length, "unchanged state emits nothing");

	env.state.toolNamespaces = [];
	env.advance(20_000);
	assert.equal(env.lastEmit("mcp_status"), "MCP 0/1 · 1!");
	assert.equal(env.lastEmit("mcp_indicator"), "✗ MCP 0/1");
});

test("session shutdown clears every footer widget", () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	env.shutdownSession();
	for (const widgetId of FOOTER_WIDGETS) assert.equal(env.lastEmit(widgetId), null, widgetId);
});

test("/mcp-status color off clears the colored indicator and notifies", async () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	assert.equal(env.lastEmit("mcp_indicator_color"), "● MCP 1/1");
	await env.command("color off");
	assert.equal(env.lastEmit("mcp_indicator_color"), null);
	assert.match(env.ui.notifications.at(-1) ?? "", /off/);
	await env.command("color on");
	assert.equal(env.lastEmit("mcp_indicator_color"), "● MCP 1/1");
});
