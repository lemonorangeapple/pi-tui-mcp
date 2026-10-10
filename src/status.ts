import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { namespaceOf, type ServerInfo } from "./config.ts";

export type ServerState = "connected" | "connecting" | "unresponsive" | "disabled";

export interface ServerStatus {
	server: ServerInfo;
	tools: number;
	state: ServerState;
}

/** Connected servers and their tool counts, from the namespaces of the registered MCP tools. */
export function readConnected(pi: ExtensionAPI, servers: ServerInfo[]): Map<string, number> {
	const counts = new Map<string, number>();
	const expected = new Map(servers.map((server) => [namespaceOf(server.name), server.name]));
	let tools: ReturnType<ExtensionAPI["getAllTools"]>;
	try {
		tools = pi.getAllTools();
	} catch {
		return counts;
	}
	for (const tool of tools) {
		const namespace = tool.namespace?.name;
		if (!namespace) continue;
		const name = expected.get(namespace);
		if (!name) continue;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return counts;
}

export function computeStatuses(
	servers: ServerInfo[],
	counts: Map<string, number>,
	settled: boolean,
): ServerStatus[] {
	return servers.map((server) => {
		const tools = counts.get(server.name) ?? 0;
		let state: ServerState;
		if (!server.enabled) state = "disabled";
		else if (tools > 0) state = "connected";
		else if (settled) state = "unresponsive";
		else state = "connecting";
		return { server, tools, state };
	});
}

export function allSettled(statuses: ServerStatus[]): boolean {
	return statuses.every((status) => status.state !== "connecting");
}
