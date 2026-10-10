import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { namespaceOf, type ServerInfo } from "./config.ts";

export type ServerState = "connected" | "connecting" | "unresponsive" | "disabled";

export interface ServerStatus {
	server: ServerInfo;
	tools: number;
	state: ServerState;
	/** How long an enabled server has been awaited; 0 for a disabled one. */
	waitedMs: number;
}

/** The built-in integration's request timeout when a server sets none (runtime.js). */
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** Slack on top of the timeout, so a server answering right at it is not flagged first. */
export const SETTLE_GRACE_MS = 2000;

/**
 * How long a server without tools is still considered to be connecting. The built-in integration
 * gives up on a request after the server's `timeout`, so only after that is silence a failure.
 */
export function settleMs(server: ServerInfo): number {
	return (server.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000 + SETTLE_GRACE_MS;
}

/**
 * When each enabled server started to be awaited. A server keeps its start time across reloads of
 * the configuration; one that is new, or was disabled and is enabled again, starts at `now`.
 */
export function reconcileSince(
	previous: ReadonlyMap<string, number>,
	servers: ServerInfo[],
	now: number,
): Map<string, number> {
	const since = new Map<string, number>();
	for (const server of servers) {
		if (server.enabled) since.set(server.name, previous.get(server.name) ?? now);
	}
	return since;
}

/**
 * Connected servers and their tool counts, from the namespaces of the registered MCP tools.
 *
 * Tools cannot be unregistered, so the built-in integration re-registers the tools of a disabled
 * server, or ones a server dropped, as `hidden`; those do not count. A server configured with the
 * `hidden` exposure registers all its tools that way, so for it they do.
 */
export function readConnected(pi: ExtensionAPI, servers: ServerInfo[]): Map<string, number> {
	const counts = new Map<string, number>();
	const expected = new Map(servers.map((server) => [namespaceOf(server.name), server]));
	let tools: ReturnType<ExtensionAPI["getAllTools"]>;
	try {
		tools = pi.getAllTools();
	} catch {
		return counts;
	}
	for (const tool of tools) {
		const namespace = tool.namespace?.name;
		if (!namespace) continue;
		const server = expected.get(namespace);
		if (!server) continue;
		if (tool.exposure === "hidden" && server.exposure !== "hidden") continue;
		counts.set(server.name, (counts.get(server.name) ?? 0) + 1);
	}
	return counts;
}

export function computeStatuses(
	servers: ServerInfo[],
	counts: Map<string, number>,
	now: number,
	since: ReadonlyMap<string, number>,
): ServerStatus[] {
	return servers.map((server) => {
		const tools = counts.get(server.name) ?? 0;
		if (!server.enabled) return { server, tools, state: "disabled", waitedMs: 0 };
		const waitedMs = Math.max(0, now - (since.get(server.name) ?? now));
		if (tools > 0) return { server, tools, state: "connected", waitedMs };
		return { server, tools, state: waitedMs >= settleMs(server) ? "unresponsive" : "connecting", waitedMs };
	});
}

export function allSettled(statuses: ServerStatus[]): boolean {
	return statuses.every((status) => status.state !== "connecting");
}
