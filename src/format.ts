import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ServerState, ServerStatus } from "./status.ts";

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
export function summaryText(statuses: ServerStatus[]): string {
	const enabled = statuses.filter((status) => status.server.enabled).length;
	const connected = statuses.filter((status) => status.state === "connected").length;
	const failed = statuses.filter((status) => status.state === "unresponsive").length;
	return failed > 0 ? `MCP ${connected}/${enabled} · ${failed}!` : `MCP ${connected}/${enabled}`;
}

/** Compact state token for the pi-footer event widget, small enough to inline anywhere. */
export function indicatorText(statuses: ServerStatus[]): string | null {
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
export function coloredIndicatorText(statuses: ServerStatus[], theme: Theme): string | null {
	const text = indicatorText(statuses);
	return text ? theme.fg(indicatorColor(statuses), text) : null;
}

/** One-line per-server overview for the pi-footer event widget. */
export function detailText(statuses: ServerStatus[]): string {
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

export function buildLines(
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
