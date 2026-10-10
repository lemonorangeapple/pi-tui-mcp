import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ServerState, ServerStatus } from "./status.ts";

type ThemeColor = Parameters<Theme["fg"]>[0];

/** Per state: sort rank (worst first), mark, and theme color. */
const STATE: Record<ServerState, { rank: number; mark: string; color: ThemeColor }> = {
	unresponsive: { rank: 0, mark: "✗", color: "error" },
	connecting: { rank: 1, mark: "◌", color: "accent" },
	connected: { rank: 2, mark: "✓", color: "success" },
	disabled: { rank: 3, mark: "–", color: "dim" },
};

/** Longest server name shown in full in the panel; longer ones are cut with an ellipsis. */
const MAX_NAME_WIDTH = 24;
/** Servers listed in the panel before the rest is summarized as "… N more". */
const MAX_ROWS = 12;

export interface Tally {
	/** Servers that are not disabled. */
	enabled: number;
	connected: number;
	connecting: number;
	/** Unresponsive servers. */
	failed: number;
}

export function tally(statuses: ServerStatus[]): Tally {
	const count = (state: ServerState) => statuses.filter((status) => status.state === state).length;
	return {
		enabled: statuses.filter((status) => status.server.enabled).length,
		connected: count("connected"),
		connecting: count("connecting"),
		failed: count("unresponsive"),
	};
}

/** Worst state first, then by name. */
function sortStatuses(statuses: ServerStatus[]): ServerStatus[] {
	return [...statuses].sort(
		(a, b) => STATE[a.state].rank - STATE[b.state].rank || a.server.name.localeCompare(b.server.name),
	);
}

/** Plain-text summary shared by the footer status and the pi-footer event widget. */
export function summaryText(statuses: ServerStatus[]): string {
	const { enabled, connected, failed } = tally(statuses);
	return failed > 0 ? `MCP ${connected}/${enabled} · ${failed}!` : `MCP ${connected}/${enabled}`;
}

/** Compact state token for the pi-footer event widget, small enough to inline anywhere. */
export function indicatorText(statuses: ServerStatus[]): string | null {
	if (statuses.length === 0) return null;
	const { enabled, connected, connecting, failed } = tally(statuses);
	if (failed > 0) return `✗ MCP ${connected}/${enabled}`;
	if (connecting > 0) return `◌ MCP ${connected}/${enabled}`;
	if (enabled === 0) return "– MCP";
	return `● MCP ${connected}/${enabled}`;
}

/**
 * Overall state → theme color for the auto-colored indicator widget. Worst state wins, so a single
 * failed server is red even while others are still connecting.
 */
function indicatorColor(statuses: ServerStatus[]): ThemeColor {
	const { enabled, connecting, failed } = tally(statuses);
	if (failed > 0) return STATE.unresponsive.color;
	if (connecting > 0) return STATE.connecting.color;
	if (enabled === 0) return STATE.disabled.color;
	return STATE.connected.color;
}

/**
 * `indicatorText` wrapped in theme ANSI. pi-footer preserves it, so the widget recolors itself as
 * state changes without any per-widget fg configuration.
 */
export function coloredIndicatorText(statuses: ServerStatus[], theme: Theme): string | null {
	const text = indicatorText(statuses);
	return text ? theme.fg(indicatorColor(statuses), text) : null;
}

/** One-line per-server overview for the pi-footer event widget. */
export function detailText(statuses: ServerStatus[]): string {
	return sortStatuses(statuses)
		.map(({ server, tools, state }) => `${STATE[state].mark}${server.name}${tools > 0 ? `(${tools})` : ""}`)
		.join(" ");
}

/** A connect that takes longer than this shows how long it has been waiting. */
const SHOW_WAIT_AFTER_MS = 10_000;

function describeStatus(status: ServerStatus): string {
	const { server, tools, state, waitedMs } = status;
	if (state === "connected") {
		const toolsText = `${tools} tool${tools === 1 ? "" : "s"}`;
		return `${toolsText} · ${server.exposure}`;
	}
	if (state === "unresponsive") return `failed or needs sign-in · ${server.exposure}`;
	if (state === "connecting") {
		const waiting = waitedMs >= SHOW_WAIT_AFTER_MS ? `connecting ${Math.floor(waitedMs / 1000)}s` : "connecting…";
		return `${waiting} · ${server.exposure}`;
	}
	return server.exposure;
}

/** The name padded to `width`, or cut with an ellipsis when it is longer. */
function fitName(name: string, width: number): string {
	return name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width);
}

export function buildLines(
	statuses: ServerStatus[],
	errors: string[],
	theme: Theme,
	showHint: boolean,
): string[] {
	const { enabled, connected, failed } = tally(statuses);
	const parts = [theme.fg("muted", `MCP ${connected}/${enabled} connected`)];
	if (failed > 0) parts.push(theme.fg("error", `${failed} unresponsive`));
	if (errors.length > 0) parts.push(theme.fg("warning", `${errors.length} config error${errors.length === 1 ? "" : "s"}`));
	const lines = [parts.join(theme.fg("dim", " · "))];

	const ordered = sortStatuses(statuses);
	const width = Math.min(MAX_NAME_WIDTH, Math.max(0, ...ordered.map((status) => status.server.name.length)));

	const shown = ordered.slice(0, MAX_ROWS);
	for (const status of shown) {
		const { mark, color } = STATE[status.state];
		const name = fitName(status.server.name, width);
		lines.push(` ${theme.fg(color, mark)} ${theme.fg("text", name)}  ${theme.fg(color, describeStatus(status))}`);
	}
	if (ordered.length > shown.length) {
		lines.push(theme.fg("muted", ` … ${ordered.length - shown.length} more`));
	}
	for (const error of errors.slice(0, 3)) lines.push(theme.fg("warning", ` ! ${error}`));
	if (errors.length > 3) lines.push(theme.fg("muted", ` … ${errors.length - 3} more errors`));
	if (showHint) lines.push(theme.fg("dim", " /mcp-status to toggle · /mcp to manage"));
	return lines;
}
