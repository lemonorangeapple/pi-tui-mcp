import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type McpExposure,
} from "@earendil-works/pi-coding-agent";

const VALID_EXPOSURES = new Set<McpExposure>(["codemode", "deferred", "direct", "hidden"]);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export type Origin = "global" | "project" | "extension";

export interface ServerInfo {
	name: string;
	origin: Origin;
	originPath: string;
	enabled: boolean;
	exposure: McpExposure;
	transport: string;
	description?: string;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Namespace the built-in MCP integration registers a server's tools under. */
export function namespaceOf(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

function resolveExposure(raw: unknown): McpExposure | undefined {
	const value = raw === "codemode-deferred" ? "codemode" : raw;
	return typeof value === "string" && VALID_EXPOSURES.has(value as McpExposure)
		? (value as McpExposure)
		: undefined;
}

function makeServerInfo(
	name: string,
	raw: Record<string, unknown>,
	origin: Origin,
	originPath: string,
): ServerInfo | string {
	if (!SERVER_NAME.test(name))
		return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	const url = typeof raw.url === "string" ? raw.url : undefined;
	const command = typeof raw.command === "string" ? raw.command : undefined;
	if (url === undefined && command === undefined)
		return `server "${name}" needs "command" (stdio) or "url" (streamable HTTP)`;
	const exposure = resolveExposure(raw.exposure) ?? "codemode";
	if (raw.exposure !== undefined && resolveExposure(raw.exposure) === undefined)
		return `server "${name}": exposure must be codemode, deferred, direct, or hidden`;
	const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
	return {
		name,
		origin,
		originPath,
		enabled: raw.enabled !== false,
		exposure,
		transport: url ?? [command, ...args].join(" "),
		description: typeof raw.description === "string" ? raw.description : undefined,
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

/**
 * The servers the built-in MCP integration connects, with the same precedence: a project entry
 * replaces a global entry of the same name, and `mcp.json` wins over an extension registration.
 */
export function loadServers(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): { servers: ServerInfo[]; errors: string[] } {
	const errors: string[] = [];
	const servers = new Map<string, ServerInfo>();

	const globalPath = join(getAgentDir(), "mcp.json");
	for (const { name, raw } of readEntries(globalPath, errors)) {
		const info = makeServerInfo(name, raw, "global", globalPath);
		if (typeof info === "string") {
			errors.push(`${globalPath}: ${info}`);
			continue;
		}
		const clash = findNamespaceClash(servers, name);
		if (clash) errors.push(`${globalPath}: server "${name}" conflicts with "${clash}"`);
		else servers.set(name, info);
	}

	if (ctx.isProjectTrusted()) {
		const projectPath = join(ctx.cwd, ".pi", "mcp.json");
		for (const { name, raw } of readEntries(projectPath, errors)) {
			if (isOverride(raw)) {
				const base = servers.get(name);
				if (!base) {
					errors.push(`${projectPath}: server "${name}" needs "command" or "url", or a global server to override`);
					continue;
				}
				const next: ServerInfo = { ...base, origin: "project", originPath: projectPath };
				if ("enabled" in raw) next.enabled = raw.enabled !== false;
				if ("exposure" in raw) {
					const exposure = resolveExposure(raw.exposure);
					if (exposure) next.exposure = exposure;
					else errors.push(`${projectPath}: server "${name}": invalid exposure`);
				}
				servers.set(name, next);
				continue;
			}
			const info = makeServerInfo(name, raw, "project", projectPath);
			if (typeof info === "string") {
				errors.push(`${projectPath}: ${info}`);
				continue;
			}
			const clash = findNamespaceClash(servers, name);
			if (clash) errors.push(`${projectPath}: server "${name}" conflicts with "${clash}"`);
			else servers.set(name, info);
		}
	}

	for (const registered of pi.getMcpServers()) {
		// `mcp.json` wins, also over a registration that only shares the namespace.
		const namespace = namespaceOf(registered.name);
		if ([...servers.keys()].some((name) => namespaceOf(name) === namespace)) continue;
		const info = makeServerInfo(
			registered.name,
			registered.config as unknown as Record<string, unknown>,
			"extension",
			registered.extensionPath,
		);
		if (typeof info === "string") errors.push(`registered server: ${info}`);
		else servers.set(registered.name, info);
	}

	return { servers: [...servers.values()], errors };
}
