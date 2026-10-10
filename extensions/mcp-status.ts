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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { errorMessage, loadServers, type ServerInfo } from "../src/config.ts";
import {
	buildLines,
	coloredIndicatorText,
	detailText,
	indicatorText,
	summaryText,
} from "../src/format.ts";
import { allSettled, computeStatuses, readConnected, type ServerStatus } from "../src/status.ts";

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
