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
import {
	applyAction,
	INITIAL_PANEL_MODE,
	isVisible,
	stepAside,
	type PanelAction,
	type PanelMode,
} from "../src/panel.ts";
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
/** How long the automatic panel stays after every server settled, unless the first prompt hides it sooner. */
const HIDE_AFTER_SETTLED_MS = 3000;

function emitFooterWidget(pi: ExtensionAPI, widgetId: string, value: string | null): void {
	try {
		pi.events.emit(FOOTER_EVENT, { widgetId, value });
	} catch {
		// A pi without the shared event bus (or a throwing listener) must not break the panel.
	}
}

/** Timers must not keep the process alive because of a status poll. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

export default function mcpStatusExtension(pi: ExtensionAPI): void {
	/**
	 * Identifies the running session. Timers capture the value they were created under and do nothing
	 * once it changed, so a callback of a shut-down session cannot touch the next one.
	 */
	let epoch = 0;
	let servers: ServerInfo[] = [];
	let errors: string[] = [];
	let statuses: ServerStatus[] = [];
	let startedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let panelMode: PanelMode = INITIAL_PANEL_MODE;
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

	/** The colored token, or the plain one when the theme cannot color (a stale theme must not blank it). */
	const coloredIndicator = (indicator: string | null): string | null => {
		const theme = colorEnabled ? currentTheme() : undefined;
		if (!theme) return null;
		try {
			return coloredIndicatorText(statuses, theme);
		} catch {
			return indicator;
		}
	};

	/**
	 * Publish MCP state to pi-footer's event widgets. pi-footer is optional: without it the bus has
	 * no listener. Values are in-memory and only re-published when they change; a new session starts
	 * from a published `null`, so its first publish always goes out.
	 */
	const publishFooter = () => {
		const summary = servers.length > 0 ? summaryText(statuses) : null;
		const detail = statuses.length > 0 ? detailText(statuses) : null;
		const indicator = indicatorText(statuses);
		const colored = coloredIndicator(indicator);
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
		if (colored !== publishedIndicatorColor) {
			publishedIndicatorColor = colored;
			emitFooterWidget(pi, FOOTER_WIDGET_INDICATOR_COLOR, colored);
		}
	};

	const clearHideTimer = () => {
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = undefined;
	};

	const clearTimers = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		clearHideTimer();
	};

	const render = () => {
		const ctx = sessionCtx;
		if (!ctx) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		if (isVisible(panelMode) && statuses.length > 0) {
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

	/** Render from a timer or event: a stale context after session replacement must not throw. */
	const safeRender = () => {
		try {
			render();
		} catch {
			// Non-interactive modes and replaced sessions render nothing.
		}
	};

	/** The automatic panel steps aside; a pinned or hidden one is left alone. */
	const stepPanelAside = () => {
		const next = stepAside(panelMode);
		if (next === panelMode) return;
		panelMode = next;
		safeRender();
	};

	const scheduleHideWhenSettled = () => {
		if (hideTimer || panelMode !== "auto" || statuses.length === 0) return;
		if (!allSettled(statuses)) return;
		const run = epoch;
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			if (run === epoch) stepPanelAside();
		}, HIDE_AFTER_SETTLED_MS);
		unrefTimer(hideTimer);
	};

	const schedule = (delay: number) => {
		const run = epoch;
		timer = setTimeout(() => {
			timer = undefined;
			if (run === epoch) tick();
		}, delay);
		unrefTimer(timer);
	};

	const tick = () => {
		if (!sessionCtx) return;
		const settled = Date.now() - startedAt >= SETTLE_MS;
		try {
			statuses = computeStatuses(servers, readConnected(pi, servers), settled);
			publishFooter();
			safeRender();
			scheduleHideWhenSettled();
		} catch {
			// Whatever went wrong this round, the next poll gets its chance.
		} finally {
			schedule(settled ? SLOW_POLL_MS : FAST_POLL_MS);
		}
	};

	const parseAction = (value: string): PanelAction | undefined =>
		value === "on" || value === "off" || value === "toggle" ? value : value === "" ? "toggle" : undefined;

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
			const panelAction = parseAction(action);
			if (panelAction) {
				panelMode = applyAction(panelMode, panelAction);
				sessionCtx = ctx;
				clearHideTimer();
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
		epoch++;
		sessionCtx = ctx;
		panelMode = INITIAL_PANEL_MODE;
		startedAt = Date.now();
		try {
			const loaded = loadServers(pi, ctx);
			servers = loaded.servers;
			errors = loaded.errors;
		} catch (error) {
			servers = [];
			errors = [errorMessage(error)];
		}
		statuses = computeStatuses(servers, readConnected(pi, servers), false);
		publishFooter();
		safeRender();
		if (servers.length > 0) {
			schedule(FAST_POLL_MS);
			scheduleHideWhenSettled();
		}
	});

	// The first prompt is the user's turn: the automatic startup panel steps aside. The footer status stays.
	pi.on("turn_start", (_event, _ctx) => {
		clearHideTimer();
		stepPanelAside();
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		epoch++;
		sessionCtx = undefined;
		statuses = [];
		servers = [];
		errors = [];
		panelMode = "hidden";
		publishFooter();
	});
}
