import assert from "node:assert/strict";
import { test } from "node:test";
import { validateServerConfig } from "../src/validate.ts";

/** Entries the built-in integration (pi-coding-agent 1.1.0) accepts. */
const VALID: Array<[string, string, unknown]> = [
	["stdio", "fs", { command: "npx", args: ["-y", "server"], env: { A: "1" }, cwd: "." }],
	["http", "docs", { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } }],
	["http on loopback", "local", { url: "http://localhost:8080/mcp" }],
	["explicit stdio type", "fs", { type: "stdio", command: "x" }],
	["explicit http type", "docs", { type: "http", url: "https://example.com" }],
	["streamable-http type", "docs", { type: "streamable-http", url: "https://example.com" }],
	["exposure alias", "docs", { command: "x", exposure: "codemode-deferred" }],
	["toolExposure", "docs", { command: "x", toolExposure: { "search*": "direct", read: "hidden" } }],
	["timeout and enabled", "docs", { command: "x", timeout: 5, enabled: false, description: "d" }],
	["dashes and underscores", "a-b_c", { command: "x" }],
	["auth over https", "docs", { url: "https://example.com", auth: { provider: "github" } }],
	["auth over loopback http", "docs", { url: "http://127.0.0.1:1/mcp", auth: { provider: "github" } }],
	["oauth", "docs", { url: "https://example.com", oauth: { clientId: "id", callbackPort: 8123, scope: "read" } }],
];

/** Entries it rejects, with the message it gives. */
const INVALID: Array<[string, string, unknown, string | RegExp]> = [
	["space in name", "bad name", { command: "x" }, 'invalid server name "bad name" (use letters, digits, "_" and "-")'],
	["not an object", "a", "x", 'server "a" must be an object'],
	["array", "a", [], 'server "a" must be an object'],
	["no command or url", "a", {}, 'server "a" needs either "command" (stdio) or "url" (streamable HTTP)'],
	["bad exposure", "a", { command: "x", exposure: "nope" }, /exposure must be one of "codemode", "deferred", "direct", "hidden"/],
	["toolExposure not a map", "a", { command: "x", toolExposure: "direct" }, 'server "a": toolExposure must map tool names to exposures'],
	["bad toolExposure value", "a", { command: "x", toolExposure: { t: "nope" } }, /toolExposure "t" must be one of/],
	["enabled string", "a", { command: "x", enabled: "no" }, 'server "a": enabled must be a boolean'],
	["description number", "a", { command: "x", description: 1 }, 'server "a": description must be a string'],
	["timeout zero", "a", { command: "x", timeout: 0 }, 'server "a": timeout must be a positive number of seconds'],
	["timeout string", "a", { command: "x", timeout: "5" }, 'server "a": timeout must be a positive number of seconds'],
	["sse", "a", { url: "https://example.com", type: "sse" }, /legacy SSE transport is not supported/],
	["non-http url", "a", { url: "ftp://example.com" }, 'server "a": url must be an http or https URL'],
	["garbage url", "a", { url: "not a url" }, 'server "a": url must be an http or https URL'],
	["headers not strings", "a", { url: "https://e.com", headers: { A: 1 } }, 'server "a": headers must map names to strings'],
	["oauth not an object", "a", { url: "https://e.com", oauth: 1 }, 'server "a": oauth must be an object'],
	["oauth bad port", "a", { url: "https://e.com", oauth: { callbackPort: 70000 } }, /oauth\.callbackPort must be a port number/],
	["oauth non-loopback callback", "a", { url: "https://e.com", oauth: { callbackUrl: "https://e.com/cb" } }, /oauth\.callbackUrl must be an http URI/],
	["oauth port mismatch", "a", { url: "https://e.com", oauth: { callbackUrl: "http://localhost:1/cb", callbackPort: 2 } }, /name different ports/],
	["auth without provider", "a", { url: "https://e.com", auth: {} }, 'server "a": auth.provider must be a provider name'],
	["auth over plain http", "a", { url: "http://example.com", auth: { provider: "p" } }, /auth requires an https URL/],
	["args not strings", "a", { command: "x", args: [1] }, 'server "a": args must be an array of strings'],
	["env not strings", "a", { command: "x", env: { A: 1 } }, 'server "a": env must map names to strings'],
	["cwd number", "a", { command: "x", cwd: 1 }, 'server "a": cwd must be a string'],
	["stdio type with only url", "a", { type: "stdio", url: "https://e.com" }, /needs either "command"/],
];

for (const [label, name, entry] of VALID) {
	test(`accepts ${label}`, () => {
		assert.equal(typeof validateServerConfig(name, entry), "object");
	});
}

for (const [label, name, entry, expected] of INVALID) {
	test(`rejects ${label}`, () => {
		const result = validateServerConfig(name, entry);
		assert.equal(typeof result, "string");
		if (typeof expected === "string") assert.equal(result, expected);
		else assert.match(result as string, expected);
	});
}

test("exposure aliases are resolved in the returned copy, not in the input", () => {
	const input = { command: "x", exposure: "codemode-deferred", toolExposure: { t: "codemode-deferred" } };
	const result = validateServerConfig("a", input);
	assert.deepEqual(result, { command: "x", exposure: "codemode", toolExposure: { t: "codemode" } });
	assert.equal(input.exposure, "codemode-deferred");
});
