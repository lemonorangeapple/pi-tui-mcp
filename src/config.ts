import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type McpExposure,
} from "@earendil-works/pi-coding-agent";
import { validateServerConfig } from "./validate.ts";

/** What an override entry of a project `mcp.json` may set on a global server. */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

export interface ServerInfo {
	name: string;
	enabled: boolean;
	exposure: McpExposure;
	/** Seconds the built-in integration waits on the server; unset means its default. */
	timeout?: number;
	/** The validated entry, kept to apply a project override on top of it. Never rendered. */
	config: Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Namespace the built-in MCP integration registers a server's tools under. */
export function namespaceOf(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

/** Validate an entry the way the built-in integration does; the message of what it would reject. */
export function makeServerInfo(name: string, raw: unknown): ServerInfo | string {
	const config = validateServerConfig(name, raw);
	if (typeof config === "string") return config;
	return {
		name,
		enabled: config.enabled !== false,
		// Validated above: an exposure is either absent or one of the four names.
		exposure: (config.exposure as McpExposure | undefined) ?? "codemode",
		timeout: typeof config.timeout === "number" ? config.timeout : undefined,
		config,
	};
}

function readEntries(path: string, errors: string[]): Array<{ name: string; raw: Record<string, unknown> }> {
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${errorMessage(error)}`);
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return [];
	}
	const servers = (parsed as Record<string, unknown>).mcpServers;
	if (servers === undefined) return [];
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		errors.push(`${path}: "mcpServers" must be an object`);
		return [];
	}
	const entries: Array<{ name: string; raw: Record<string, unknown> }> = [];
	for (const [name, value] of Object.entries(servers)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			errors.push(`${path}: server "${name}" must be an object`);
			continue;
		}
		entries.push({ name, raw: value as Record<string, unknown> });
	}
	return entries;
}

/** Whether a project entry only overrides an existing server instead of defining one. */
function isOverride(raw: Record<string, unknown>): boolean {
	return raw.command === undefined && raw.url === undefined && raw.type === undefined;
}

/**
 * A server already loaded under another name whose tools share `name`'s namespace: `-` and `_`
 * both become `_`, so `a-b` and `a_b` would register the same `mcp__a_b` tools. The built-in
 * integration keeps the first and reports the second as a conflict, so this does too.
 */
function findNamespaceClash(servers: Map<string, ServerInfo>, name: string): string | undefined {
	const namespace = namespaceOf(name);
	return [...servers.keys()].find((other) => other !== name && namespaceOf(other) === namespace);
}

const globalConfigPath = () => join(getAgentDir(), "mcp.json");
const projectConfigPath = (ctx: ExtensionContext) => join(ctx.cwd, ".pi", "mcp.json");

/**
 * The servers the built-in MCP integration connects, with the same precedence and the same
 * validation: a project entry replaces a global entry of the same name (or overrides parts of it),
 * and `mcp.json` wins over an extension registration.
 */
export function loadServers(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): { servers: ServerInfo[]; errors: string[] } {
	const errors: string[] = [];
	const servers = new Map<string, ServerInfo>();

	const globalPath = globalConfigPath();
	for (const { name, raw } of readEntries(globalPath, errors)) {
		const info = makeServerInfo(name, raw);
		if (typeof info === "string") {
			errors.push(`${globalPath}: ${info}`);
			continue;
		}
		const clash = findNamespaceClash(servers, name);
		if (clash) errors.push(`${globalPath}: server "${name}" conflicts with "${clash}"`);
		else servers.set(name, info);
	}

	if (ctx.isProjectTrusted()) {
		const projectPath = projectConfigPath(ctx);
		for (const { name, raw } of readEntries(projectPath, errors)) {
			if (isOverride(raw)) {
				const base = servers.get(name);
				if (!base) {
					errors.push(`${projectPath}: server "${name}" needs "command" or "url", or a global server to override`);
					continue;
				}
				const extra = Object.keys(raw).filter((key) => !OVERRIDE_KEYS.includes(key));
				if (extra.length > 0) {
					errors.push(`${projectPath}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
					continue;
				}
				const merged = makeServerInfo(name, { ...base.config, ...raw });
				if (typeof merged === "string") errors.push(`${projectPath}: ${merged}`);
				else servers.set(name, merged);
				continue;
			}
			const info = makeServerInfo(name, raw);
			if (typeof info === "string") {
				errors.push(`${projectPath}: ${info}`);
				continue;
			}
			const clash = findNamespaceClash(servers, name);
			if (clash) {
				errors.push(`${projectPath}: server "${name}" conflicts with "${clash}"`);
				continue;
			}
			if ("url" in info.config && info.config.auth) {
				errors.push(`${projectPath}: server "${name}": auth is only allowed in the global mcp.json`);
				continue;
			}
			servers.set(name, info);
		}
	}

	for (const registered of pi.getMcpServers()) {
		// `mcp.json` wins, also over a registration that only shares the namespace.
		const namespace = namespaceOf(registered.name);
		if ([...servers.keys()].some((name) => namespaceOf(name) === namespace)) continue;
		const info = makeServerInfo(registered.name, registered.config);
		if (typeof info === "string") errors.push(`registered server: ${info}`);
		else servers.set(registered.name, info);
	}

	return { servers: [...servers.values()], errors };
}

function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "-";
	}
}

/**
 * Cheap fingerprint of everything `loadServers` reads: both `mcp.json` files, whether the project
 * is trusted, and the servers extensions registered. It changes when `/mcp` enables or disables a
 * server, when the files are edited, and when an extension registers a server after startup.
 */
export function configSignature(pi: ExtensionAPI, ctx: ExtensionContext): string {
	let trusted = false;
	let registered = "";
	try {
		trusted = ctx.isProjectTrusted();
		registered = JSON.stringify(pi.getMcpServers());
	} catch {
		// A stale context keeps the last signature; nothing is reloaded from it.
	}
	return [fileStamp(globalConfigPath()), trusted ? fileStamp(projectConfigPath(ctx)) : "untrusted", registered].join("|");
}
