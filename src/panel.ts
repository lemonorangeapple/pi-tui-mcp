/**
 * Visibility of the startup panel.
 *
 * - `auto`: the default after a session start. Shown; steps aside by itself, either some seconds
 *   after every server settled or when the first turn starts.
 * - `pinned`: the user asked for it with `/mcp-status on` (or toggled it back on). Stays until the
 *   user hides it, so neither the settle timer nor a new turn takes it away.
 * - `hidden`: not shown.
 */
export type PanelMode = "auto" | "pinned" | "hidden";

export type PanelAction = "on" | "off" | "toggle";

export const INITIAL_PANEL_MODE: PanelMode = "auto";

export function isVisible(mode: PanelMode): boolean {
	return mode !== "hidden";
}

export function applyAction(mode: PanelMode, action: PanelAction): PanelMode {
	if (action === "on") return "pinned";
	if (action === "off") return "hidden";
	return isVisible(mode) ? "hidden" : "pinned";
}

/**
 * What happens when the panel should get out of the way: the first turn started, or every server
 * settled. Only the automatic panel does; a pinned one stays.
 */
export function stepAside(mode: PanelMode): PanelMode {
	return mode === "auto" ? "hidden" : mode;
}
