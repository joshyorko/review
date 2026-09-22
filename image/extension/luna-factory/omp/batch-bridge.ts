import type { FactoryAction, SelectedItem } from "../core/batch.ts";

type Controller = (command: string, context: unknown) => Promise<string>;
type Reconciler = (owner: string, resource: string) => Promise<"settled" | "unknown">;
type BridgeState = {
	selection?: (action: FactoryAction) => SelectedItem[];
	controller?: Controller;
	reconciler?: Reconciler;
	loadFailure?: string;
};

// OMP may cache explicit extensions as separate module instances. Keep the
// handoff in one versioned global slot so those instances share identity.
const BRIDGE_STATE_KEY = Symbol.for("projectbluefin.review.luna-factory.batch-bridge.v1");
const bridgeGlobal = globalThis as typeof globalThis & { [BRIDGE_STATE_KEY]?: BridgeState };
const state = bridgeGlobal[BRIDGE_STATE_KEY] ?? (bridgeGlobal[BRIDGE_STATE_KEY] = {});

/**
 * Bounded, secret-free reason the Factory package recorded for a failed load.
 *
 * A package that cannot register a controller can still be imported: Review
 * reaches `factoryCommand` through this module. Anything the loader reports is
 * whitespace-collapsed and truncated so a startup diagnostic can name the cause
 * without dumping an environment or a stack trace into the session.
 */
const LOAD_FAILURE_LIMIT = 240;

export function registerFactorySelection(provider: (action: FactoryAction) => SelectedItem[]): () => void {
	state.selection = provider;
	return () => { if (state.selection === provider) state.selection = undefined; };
}
export function selectedFactoryItems(action: FactoryAction): SelectedItem[] {
	if (!state.selection) throw new Error("Open Review and select exact items before submitting a Factory batch");
	return state.selection(action);
}
export function registerFactoryController(handler: Controller): () => void {
	state.controller = handler;
	state.loadFailure = undefined;
	return () => { if (state.controller === handler) state.controller = undefined; };
}

/** Register Review's authoritative claim reconciliation seam for textual Factory commands. */
export function registerFactoryReconciler(handler: Reconciler): () => void {
	state.reconciler = handler;
	return () => { if (state.reconciler === handler) state.reconciler = undefined; };
}

export function registeredFactoryReconciler(): Reconciler | undefined {
	return state.reconciler;
}
/** Record why the Factory extension failed to load, for the caller's diagnostic. */
export function reportFactoryLoadFailure(reason: string): void {
	const collapsed = reason.replace(/\s+/g, " ").trim();
	state.loadFailure = collapsed.length === 0
		? "the extension loader reported no reason"
		: collapsed.length > LOAD_FAILURE_LIMIT ? `${collapsed.slice(0, LOAD_FAILURE_LIMIT - 1)}…` : collapsed;
}

/** True once the Factory extension has registered its command controller. */
export function factoryControllerRegistered(): boolean {
	return state.controller !== undefined;
}

export type FactoryHandoffState = "registered" | "load-failed" | "not-registered";

/**
 * Which of the three handoff states this session is in.
 *
 * `registered` is the co-loaded package; `load-failed` means the package was
 * loaded and threw; `not-registered` is the residual state — the package is
 * either absent from this build or was never passed to omp as an `--extension`.
 * Execution being off is a fourth, separate fact: it is only observable once a
 * controller exists, and it is reported by the Factory command surface itself.
 */
export function factoryHandoffState(): FactoryHandoffState {
	if (state.controller !== undefined) return "registered";
	return state.loadFailure === undefined ? "not-registered" : "load-failed";
}

/** Bounded, secret-free description of why the Factory handoff is unavailable. */
export function factoryLoadDiagnostic(): string {
	switch (factoryHandoffState()) {
		case "registered":
			return "the Luna Factory controller is registered";
		case "load-failed":
			return `the Luna Factory extension is packaged but failed to load: ${state.loadFailure}`;
		default:
			return "the Luna Factory extension never registered a controller: it is either absent from this build or was not passed to omp as an --extension";
	}
}

export async function factoryCommand(command: string, context: unknown): Promise<string> {
	if (!state.controller) throw new Error(`Factory is not loaded; enable the packaged Luna Factory extension. ${factoryLoadDiagnostic()}`);
	return state.controller(command, context);
}
