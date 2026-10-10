import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import mcpStatusExtension from "../extensions/mcp-status.ts";

/**
 * `mock.timers.tick(n)` does not fire timers that a callback schedules during the same call, which
 * swallows a self-rescheduling poll loop. Stepping in small increments lets each reschedule fire.
 */
const STEP_MS = 50;

function advance(ms: number): void {
	for (let left = ms; left > 0; left -= STEP_MS) mock.timers.tick(Math.min(STEP_MS, left));
}

export interface FooterEmit {
	widgetId: string;
	value: string | null;
}

export interface EnvOptions {
	/** Content of the global `mcp.json`. */
	globalConfig?: object;
	/** Content of the trusted project's `.pi/mcp.json`. */
	projectConfig?: object;
	/** `namespace.name` of the registered tools, one tool per entry. */
	toolNamespaces?: string[];
	/** Servers registered with `pi.registerMcpServer()`. */
	registered?: Array<{ name: string; config: Record<string, unknown>; extensionPath?: string }>;
}

/** The extension wired to a fake `pi` and a fake TUI context, driven by mock timers. */
export function createEnv(options: EnvOptions = {}) {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });

	const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-status-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-status-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (options.globalConfig) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(options.globalConfig));
	if (options.projectConfig) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(options.projectConfig));
	}

	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }> = {};
	const emits: FooterEmit[] = [];
	const state = {
		toolNamespaces: options.toolNamespaces ?? [],
		getAllToolsCalls: 0,
		themeThrows: false,
	};

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			handlers[event] = handler;
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
			commands[name] = command;
		},
		getAllTools: () => {
			state.getAllToolsCalls++;
			return state.toolNamespaces.map((name) => ({ name: `${name}__tool`, namespace: { name } }));
		},
		getMcpServers: () =>
			(options.registered ?? []).map((server) => ({ extensionPath: "/ext/registered.ts", ...server })),
		events: {
			emit: (_channel: string, payload: FooterEmit) => {
				emits.push(payload);
			},
		},
	};

	const ui = {
		// Identity theme: rendered lines are plain text.
		theme: {
			fg: (_color: string, text: string) => {
				if (state.themeThrows) throw new Error("stale theme");
				return text;
			},
		},
		widget: undefined as string[] | undefined,
		status: undefined as string | undefined,
		notifications: [] as string[],
		setWidget(_key: string, lines: string[] | undefined) {
			ui.widget = lines;
		},
		setStatus(_key: string, text: string | undefined) {
			ui.status = text;
		},
		notify(message: string) {
			ui.notifications.push(message);
		},
	};
	const ctx = { mode: "tui", hasUI: true, cwd, isProjectTrusted: () => true, ui };

	mcpStatusExtension(pi as never);

	return {
		pi,
		ctx,
		ui,
		state,
		emits,
		advance,
		startSession: () => handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx),
		shutdownSession: () => handlers.session_shutdown?.({ type: "session_shutdown" }, ctx),
		turnStart: () => handlers.turn_start?.({ type: "turn_start" }, ctx),
		command: async (args: string) => commands["mcp-status"]?.handler(args, ctx),
		writeGlobalConfig: (config: object) => writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(config)),
		/** Latest value emitted to one pi-footer widget, `undefined` when never emitted. */
		lastEmit: (widgetId: string) => emits.filter((emit) => emit.widgetId === widgetId).at(-1)?.value,
		panelText: () => ui.widget?.join("\n"),
	};
}

export type Env = ReturnType<typeof createEnv>;
