/**
 * Known defects, written as the behavior they should have. `todo` keeps them running without
 * failing the suite; each fix commit removes the `todo` of the tests it makes pass.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createEnv } from "./helpers.ts";

afterEach(() => mock.timers.reset());

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
