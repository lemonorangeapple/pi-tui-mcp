/**
 * Known defects, written as the behavior they should have. `todo` keeps them running without
 * failing the suite; each fix commit removes the `todo` of the tests it makes pass.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createEnv } from "./helpers.ts";

afterEach(() => mock.timers.reset());

test("/mcp-status on keeps the panel open after servers settled", { todo: "commit 2" }, async () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	env.advance(6_000);
	assert.equal(env.ui.widget, undefined, "auto-hidden after settle");
	await env.command("on");
	env.advance(10_000);
	assert.ok(env.ui.widget, "pinned panel must not be auto-hidden again");
});

test("/mcp-status on survives the next turn", { todo: "commit 2" }, async () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	env.advance(6_000);
	await env.command("on");
	env.turnStart();
	assert.ok(env.ui.widget, "an explicit 'on' is not undone by the next prompt");
});

test("names that share a namespace are reported as a conflict, the first one wins", { todo: "commit 2" }, () => {
	const env = createEnv({
		globalConfig: { mcpServers: { "a-b": { command: "x" }, a_b: { command: "y" } } },
		toolNamespaces: ["mcp__a_b"],
	});
	env.startSession();
	env.advance(16_000);
	const panel = env.panelText() ?? "";
	assert.match(panel, /✓ a-b/);
	assert.doesNotMatch(panel, /✗/);
	assert.match(panel, /server "a_b" conflicts with "a-b"/);
});

test("a throwing publish does not stop the poll loop", { todo: "commit 2" }, () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } } });
	env.startSession();
	env.state.themeThrows = true;
	assert.doesNotThrow(() => env.advance(400));
	const before = env.state.getAllToolsCalls;
	env.advance(3_000);
	assert.ok(env.state.getAllToolsCalls > before, "polling continues");
});

test("config the built-in rejects is a config error, not a failing server", { todo: "commit 3" }, () => {
	const env = createEnv({
		globalConfig: {
			mcpServers: {
				ok: { command: "x" },
				sse: { url: "https://example.com", type: "sse" },
				flag: { command: "x", enabled: "no" },
			},
		},
		toolNamespaces: ["mcp__ok"],
	});
	env.startSession();
	env.advance(16_000);
	const panel = env.panelText() ?? "";
	assert.match(panel, /2 config errors/);
	assert.doesNotMatch(panel, /✗/);
});

test("config errors are visible even when no server is valid", { todo: "commit 3" }, () => {
	const env = createEnv({ globalConfig: { mcpServers: { nocmd: {} } } });
	env.startSession();
	assert.match(env.panelText() ?? "", /1 config error/);
});

test("disabling a server in mcp.json after start is picked up", { todo: "commit 3" }, () => {
	const env = createEnv({ globalConfig: { mcpServers: { a: { command: "x" } } }, toolNamespaces: ["mcp__a"] });
	env.startSession();
	env.writeGlobalConfig({ mcpServers: { a: { command: "x", enabled: false } } });
	env.advance(4_000);
	assert.equal(env.ui.status, "MCP 0/0");
});
