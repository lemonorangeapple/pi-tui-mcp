/**
 * MCP startup status for the TUI.
 *
 * pi's built-in MCP integration keeps its connection state private: there is no status API and no
 * connection event. This extension therefore observes the one thing the built-in integration does
 * expose, the tool registry. As a server connects, its tools are registered as
 * `mcp__<server>__<tool>` with the `mcp__<server>` namespace, so the registered namespace reveals
 * whether a server connected and how many tools it offers.
 *
 * Configured servers are read from `~/.pi/agent/mcp.json`, from the trusted project's
 * `.pi/mcp.json`, and from extensions that registered servers with `pi.registerMcpServer()`.
 *
 * What it can show: configured, connected, tool count, exposure, disabled, and after the settle
 * timeout `unresponsive` (which covers both a failed connection and a server that needs sign-in,
 * because the built-in integration does not report the difference here).
 *
 * This extension does not connect, alter, or replace anything. The built-in MCP support stays in
 * charge; run `/mcp` for the full manager.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type McpExposure,
	type McpServerConfig,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "mcp-status";
const STATUS_KEY = "mcp";

/** pi-footer integration: publish the same state as event widgets the user can place in the footer. */
const FOOTER_EVENT = "pi-footer:update-widget";
const FOOTER_WIDGET_SUMMARY = "mcp_status";
const FOOTER_WIDGET_SERVERS = "mcp_servers";
const FOOTER_WIDGET_INDICATOR = "mcp_indicator";
/** Auto-colored twin of `mcp_indicator`: same token, ANSI-colored from the pi theme. */
const FOOTER_WIDGET_INDICATOR_COLOR = "mcp_indicator_color";

/** Poll fast while servers connect, slowly once the settle timeout passed. */
const FAST_POLL_MS = 400;
const SLOW_POLL_MS = 3000;
/** After this long without tools, an enabled server is shown as unresponsive. */
const SETTLE_MS = 15_000;
/** How long the panel stays after every server settled, unless the first prompt hides it sooner. */
const HIDE_AFTER_SETTLED_MS = 3000;

const VALID_EXPOSURES = new Set<McpExposure>(["codemode", "deferred", "direct", "hidden"]);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

type Origin = "global" | "project" | "extension";
type ServerState = "connected" | "connecting" | "unresponsive" | "disabled";

interface ServerInfo {
	name: string;
	origin: Origin;
	originPath: string;
	enabled: boolean;
	exposure: McpExposure;
	transport: string;
	description?: string;
}

interface ServerStatus {
	server: ServerInfo;
	tools: number;
	state: ServerState;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Namespace the built-in MCP integration registers a server's tools under. */
function namespaceOf(name: string): string {
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
	const hasUrl = typeof raw.url === "string";
	const hasCommand = typeof raw.command === "string";
	if (!hasUrl && !hasCommand) return `server "${name}" needs "command" (stdio) or "url" (streamable HTTP)`;
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
		transport: hasUrl ? raw.url : [raw.command, ...args].join(" "),
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
 * The servers the built-in MCP integration connects, with the same precedence: a project entry
 * replaces a global entry of the same name, and `mcp.json` wins over an extension registration.
 */
function loadServers(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): { servers: ServerInfo[]; errors: string[] } {
	const errors: string[] = [];
	const servers = new Map<string, ServerInfo>();

	const globalPath = join(getAgentDir(), "mcp.json");
	for (const { name, raw } of readEntries(globalPath, errors)) {
		const info = makeServerInfo(name, raw, "global", globalPath);
		if (typeof info === "string") errors.push(`${globalPath}: ${info}`);
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
			if (typeof info === "string") errors.push(`${projectPath}: ${info}`);
			else servers.set(name, info);
		}
	}

	for (const registered of pi.getMcpServers()) {
		if (servers.has(registered.name)) continue;
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

/** Connected servers and their tool counts, from the namespaces of the registered MCP tools. */
function readConnected(pi: ExtensionAPI, servers: ServerInfo[]): Map<string, number> {
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

function computeStatuses(
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

function allSettled(statuses: ServerStatus[]): boolean {
	return statuses.every((status) => status.state !== "connecting");
}

const STATE_RANK: Record<ServerState, number> = {
	unresponsive: 0,
	connecting: 1,
	connected: 2,
	disabled: 3,
};

const STATE_TEXT: Record<ServerState, string> = {
	connected: "connected",
	connecting: "connecting…",
	unresponsive: "no response",
	disabled: "disabled",
};

const DETAIL_MARK: Record<ServerState, string> = {
	connected: "✓",
	connecting: "◌",
	unresponsive: "✗",
	disabled: "–",
};

/** Plain-text summary shared by the footer status and the pi-footer event widget. */
function summaryText(statuses: ServerStatus[]): string {
	const enabled = statuses.filter((status) => status.server.enabled).length;
	const connected = statuses.filter((status) => status.state === "connected").length;
	const failed = statuses.filter((status) => status.state === "unresponsive").length;
	return failed > 0 ? `MCP ${connected}/${enabled} · ${failed}!` : `MCP ${connected}/${enabled}`;
}

/** Compact state token for the pi-footer event widget, small enough to inline anywhere. */
function indicatorText(statuses: ServerStatus[]): string | null {
	if (statuses.length === 0) return null;
	const enabled = statuses.filter((status) => status.server.enabled).length;
	const connected = statuses.filter((status) => status.state === "connected").length;
	const connecting = statuses.filter((status) => status.state === "connecting").length;
	const failed = statuses.filter((status) => status.state === "unresponsive").length;
	if (failed > 0) return `✗ MCP ${connected}/${enabled}`;
	if (connecting > 0) return `◌ MCP ${connected}/${enabled}`;
	if (enabled === 0) return "– MCP";
	return `● MCP ${connected}/${enabled}`;
}

/**
 * Overall state → theme color for the auto-colored indicator widget. Worst state wins, so a single
 * failed server is red even while others are still connecting.
 */
function indicatorColor(statuses: ServerStatus[]): Parameters<Theme["fg"]>[0] {
	if (statuses.some((status) => status.state === "unresponsive")) return "error";
	if (statuses.some((status) => status.state === "connecting")) return "accent";
	if (statuses.every((status) => !status.server.enabled)) return "dim";
	return "success";
}

/**
 * `indicatorText` wrapped in theme ANSI. pi-footer preserves it, so the widget recolors itself as
 * state changes without any per-widget fg configuration.
 */
function coloredIndicatorText(statuses: ServerStatus[], theme: Theme): string | null {
	const text = indicatorText(statuses);
	return text ? theme.fg(indicatorColor(statuses), text) : null;
}

/** One-line per-server overview for the pi-footer event widget. */
function detailText(statuses: ServerStatus[]): string {
	const ordered = [...statuses].sort(
		(a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.server.name.localeCompare(b.server.name),
	);
	return ordered
		.map(({ server, tools, state }) => `${DETAIL_MARK[state]}${server.name}${tools > 0 ? `(${tools})` : ""}`)
		.join(" ");
}

function describeStatus(status: ServerStatus): string {
	const { server, tools, state } = status;
	if (state === "connected") {
		const toolsText = `${tools} tool${tools === 1 ? "" : "s"}`;
		return `${toolsText} · ${server.exposure}`;
	}
	if (state === "unresponsive") return `failed or needs sign-in · ${server.exposure}`;
	return server.exposure;
}

function buildLines(
	statuses: ServerStatus[],
	errors: string[],
	theme: Theme,
	showHint: boolean,
): string[] {
	const enabled = statuses.filter((status) => status.server.enabled).length;
	const connected = statuses.filter((status) => status.state === "connected").length;
	const failed = statuses.filter((status) => status.state === "unresponsive").length;
	const parts = [theme.fg("muted", `MCP ${connected}/${enabled} connected`)];
	if (failed > 0) parts.push(theme.fg("error", `${failed} unresponsive`));
	if (errors.length > 0) parts.push(theme.fg("warning", `${errors.length} config error${errors.length === 1 ? "" : "s"}`));
	const lines = [parts.join(theme.fg("dim", " · "))];

	const ordered = [...statuses].sort(
		(a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.server.name.localeCompare(b.server.name),
	);
	const width = Math.min(24, Math.max(0, ...ordered.map((status) => status.server.name.length)));

	const icons: Record<ServerState, string> = {
		connected: theme.fg("success", "✓"),
		connecting: theme.fg("accent", "◌"),
		unresponsive: theme.fg("error", "✗"),
		disabled: theme.fg("dim", "–"),
	};
	const colors: Record<ServerState, Parameters<Theme["fg"]>[0]> = {
		connected: "success",
		connecting: "accent",
		unresponsive: "error",
		disabled: "dim",
	};

	const shown = ordered.slice(0, 12);
	for (const status of shown) {
		const name = status.server.name.padEnd(width);
		lines.push(` ${icons[status.state]} ${theme.fg("text", name)}  ${theme.fg(colors[status.state], describeStatus(status))}`);
	}
	if (ordered.length > shown.length) {
		lines.push(theme.fg("muted", ` … ${ordered.length - shown.length} more`));
	}
	for (const error of errors.slice(0, 3)) lines.push(theme.fg("warning", ` ! ${error}`));
	if (errors.length > 3) lines.push(theme.fg("muted", ` … ${errors.length - 3} more errors`));
	if (showHint) lines.push(theme.fg("dim", " /mcp-status to toggle · /mcp to manage"));
	return lines;
}

function emitFooterWidget(pi: ExtensionAPI, widgetId: string, value: string | null): void {
	try {
		pi.events.emit(FOOTER_EVENT, { widgetId, value });
	} catch {
		// A pi without the shared event bus (or a throwing listener) must not break the panel.
	}
}

export default function mcpStatusExtension(pi: ExtensionAPI): void {
	let generation = 0;
	let servers: ServerInfo[] = [];
	let errors: string[] = [];
	let statuses: ServerStatus[] = [];
	let startedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetVisible = true;
	let sessionCtx: ExtensionContext | undefined;
	let publishedSummary: string | null = null;
	let publishedServers: string | null = null;
	let publishedIndicator: string | null = null;
	let publishedIndicatorColor: string | null = null;
	/** Whether the auto-colored indicator widget is published. Runtime-only, toggled by /mcp-status color. */
	let colorEnabled = true;

	/** `sessionCtx.ui.theme` is absent in non-interactive modes. */
	const currentTheme = (): Theme | undefined => {
		try {
			return sessionCtx?.ui.theme;
		} catch {
			return undefined;
		}
	};

	/**
	 * Publish MCP state to pi-footer's event widgets. pi-footer is optional: without it the bus has
	 * no listener. Values are in-memory, so they are re-published on every session start and tick.
	 */
	const publishFooter = () => {
		const summary = servers.length > 0 ? summaryText(statuses) : null;
		const detail = statuses.length > 0 ? detailText(statuses) : null;
		const indicator = indicatorText(statuses);
		const theme = colorEnabled ? currentTheme() : undefined;
		const coloredIndicator = theme ? coloredIndicatorText(statuses, theme) : null;
		if (summary !== publishedSummary) {
			publishedSummary = summary;
			emitFooterWidget(pi, FOOTER_WIDGET_SUMMARY, summary);
		}
		if (detail !== publishedServers) {
			publishedServers = detail;
			emitFooterWidget(pi, FOOTER_WIDGET_SERVERS, detail);
		}
		if (indicator !== publishedIndicator) {
			publishedIndicator = indicator;
			emitFooterWidget(pi, FOOTER_WIDGET_INDICATOR, indicator);
		}
		if (coloredIndicator !== publishedIndicatorColor) {
			publishedIndicatorColor = coloredIndicator;
			emitFooterWidget(pi, FOOTER_WIDGET_INDICATOR_COLOR, coloredIndicator);
		}
	};

	const clearTimers = () => {
		if (timer) clearTimeout(timer);
		if (hideTimer) clearTimeout(hideTimer);
		timer = undefined;
		hideTimer = undefined;
	};

	const render = () => {
		const ctx = sessionCtx;
		if (!ctx) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		if (widgetVisible && statuses.length > 0) {
			const theme = ctx.ui.theme;
			ctx.ui.setWidget(WIDGET_KEY, buildLines(statuses, errors, theme, true), { placement: "aboveEditor" });
		} else {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}

		if (servers.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, summaryText(statuses));
	};

	const hideWidget = () => {
		if (!widgetVisible) return;
		widgetVisible = false;
		render();
	};

	const scheduleHideWhenSettled = () => {
		if (hideTimer || !widgetVisible || statuses.length === 0) return;
		if (!allSettled(statuses)) return;
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			if (generation === currentGeneration) hideWidget();
		}, HIDE_AFTER_SETTLED_MS);
		(hideTimer as unknown as { unref?: () => void }).unref?.();
	};

	let currentGeneration = 0;

	const schedule = (delay: number) => {
		timer = setTimeout(() => {
			timer = undefined;
			if (generation !== currentGeneration) return;
			tick();
		}, delay);
		// Do not keep the process alive because of a status poll.
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	const tick = () => {
		const ctx = sessionCtx;
		if (!ctx || generation !== currentGeneration) return;
		let counts: Map<string, number>;
		try {
			counts = readConnected(pi, servers);
		} catch {
			counts = new Map();
		}
		const settled = Date.now() - startedAt >= SETTLE_MS;
		statuses = computeStatuses(servers, counts, settled);
		publishFooter();
		try {
			render();
		} catch {
			// A stale context after session replacement must not break the poll loop.
		}
		scheduleHideWhenSettled();
		schedule(settled ? SLOW_POLL_MS : FAST_POLL_MS);
	};

	pi.registerCommand("mcp-status", {
		description: "Show or hide the MCP server loading status panel",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trimStart();
			const options = ["toggle", "on", "off", "color", "color on", "color off"].filter((option) =>
				option.startsWith(value),
			);
			return options.length > 0 ? options.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off" || action === "toggle" || action === "") {
				const next = action === "on" ? true : action === "off" ? false : !widgetVisible;
				widgetVisible = next;
				sessionCtx = ctx;
				if (hideTimer) {
					clearTimeout(hideTimer);
					hideTimer = undefined;
				}
				render();
				return;
			}
			if (action === "color" || action === "color on" || action === "color off") {
				colorEnabled = action === "color on" ? true : action === "color off" ? false : !colorEnabled;
				sessionCtx = ctx;
				publishFooter();
				ctx.ui.notify(
					`Automatic color ${colorEnabled ? "on" : "off"} for the ${FOOTER_WIDGET_INDICATOR_COLOR} footer widget.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(`Usage: /mcp-status [toggle|on|off|color [on|off]]\n\n${statuses.length} server(s) known, ${errors.length} config error(s).`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearTimers();
		currentGeneration = ++generation;
		sessionCtx = ctx;
		widgetVisible = true;
		startedAt = Date.now();
		try {
			const loaded = loadServers(pi, ctx);
			servers = loaded.servers;
			errors = loaded.errors;
		} catch (error) {
			servers = [];
			errors = [errorMessage(error)];
		}
		const counts = servers.length > 0 ? readConnected(pi, servers) : new Map<string, number>();
		statuses = computeStatuses(servers, counts, false);
		publishFooter();
		try {
			render();
		} catch {
			// Non-interactive modes render nothing.
		}
		if (servers.length > 0) {
			schedule(FAST_POLL_MS);
			scheduleHideWhenSettled();
		}
	});

	// The first prompt is the user's turn: the startup panel steps aside. The footer status stays.
	pi.on("turn_start", (_event, _ctx) => {
		if (widgetVisible) {
			if (hideTimer) {
				clearTimeout(hideTimer);
				hideTimer = undefined;
			}
			hideWidget();
		}
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		generation++;
		sessionCtx = undefined;
		statuses = [];
		servers = [];
		errors = [];
		widgetVisible = false;
		publishFooter();
	});
}
