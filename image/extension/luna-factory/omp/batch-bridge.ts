import type { FactoryAction, SelectedItem } from "../core/batch.ts";
import type { FactoryDashboardSnapshot } from "../ui/dashboard.ts";
export type { FactoryDashboardSnapshot } from "../ui/dashboard.ts";

type Controller = (command: string, context: unknown) => Promise<string>;
type Reconciler = (owner: string, resource: string) => Promise<"settled" | "unknown">;
export interface FactoryBatchHandoff {
	readonly batchId: string;
	readonly text: string;
}

type BatchSubmitter = (action: FactoryAction, context: unknown) => Promise<FactoryBatchHandoff>;
type DashboardReader = () => FactoryDashboardSnapshot;
type DashboardOpener = (context: unknown, batchId?: string) => Promise<void>;
type BridgeState = {
	selection?: (action: FactoryAction) => SelectedItem[];
	controller?: Controller;
	submitter?: BatchSubmitter;
	dashboardReader?: DashboardReader;
	dashboardOpener?: DashboardOpener;
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
	if (state.controller !== handler) {
		// A replacement controller belongs to a new extension lifetime. Do not
		// leave typed dashboard seams pointing at a stale cached module instance.
		state.submitter = undefined;
		state.dashboardReader = undefined;
		state.dashboardOpener = undefined;
	}
	state.controller = handler;
	state.loadFailure = undefined;
	return () => { if (state.controller === handler) state.controller = undefined; };
}

/** Register the typed Review-to-Factory handoff; callers never parse status text. */
export function registerFactoryBatchSubmitter(handler: BatchSubmitter): () => void {
	state.submitter = handler;
	return () => { if (state.submitter === handler) state.submitter = undefined; };
}

export async function submitFactoryBatch(action: FactoryAction, context: unknown): Promise<FactoryBatchHandoff> {
	if (!state.submitter) throw new Error(`Factory is not loaded; ${factoryLoadDiagnostic()}`);
	return state.submitter(action, context);
}
export function factoryBatchSubmitterRegistered(): boolean { return state.submitter !== undefined; }

/** Register a read-only local projection reader for the native dashboard. */
export function registerFactoryDashboardReader(reader: DashboardReader): () => void {
	state.dashboardReader = reader;
	return () => { if (state.dashboardReader === reader) state.dashboardReader = undefined; };
}

export function readFactoryDashboardSnapshot(): FactoryDashboardSnapshot {
	if (!state.dashboardReader) return { batches: [], claims: [], readOnly: true, error: factoryLoadDiagnostic() };
	try { return state.dashboardReader(); }
	catch (error) { return { batches: [], claims: [], readOnly: true, error: error instanceof Error ? error.message : String(error) }; }
}

export function registerFactoryDashboardOpener(opener: DashboardOpener): () => void {
	state.dashboardOpener = opener;
	return () => { if (state.dashboardOpener === opener) state.dashboardOpener = undefined; };
}

export async function openFactoryDashboard(context: unknown, batchId?: string): Promise<void> {
	if (!state.dashboardOpener) throw new Error(`Factory dashboard is not loaded; ${factoryLoadDiagnostic()}`);
	return state.dashboardOpener(context, batchId);
}
export function factoryDashboardOpenerRegistered(): boolean { return state.dashboardOpener !== undefined; }

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
