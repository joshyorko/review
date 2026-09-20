import type { FactoryAction, SelectedItem } from "../core/batch.ts";

type Controller = (command: string, context: unknown) => Promise<string>;
let selection: ((action: FactoryAction) => SelectedItem[]) | undefined;
let controller: Controller | undefined;
let loadFailure: string | undefined;

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
	selection = provider;
	return () => { if (selection === provider) selection = undefined; };
}
export function selectedFactoryItems(action: FactoryAction): SelectedItem[] {
	if (!selection) throw new Error("Open Review and select exact items before submitting a Factory batch");
	return selection(action);
}
export function registerFactoryController(handler: Controller): () => void {
	controller = handler;
	loadFailure = undefined;
	return () => { if (controller === handler) controller = undefined; };
}

/** Record why the Factory extension failed to load, for the caller's diagnostic. */
export function reportFactoryLoadFailure(reason: string): void {
	const collapsed = reason.replace(/\s+/g, " ").trim();
	loadFailure = collapsed.length === 0
		? "the extension loader reported no reason"
		: collapsed.length > LOAD_FAILURE_LIMIT ? `${collapsed.slice(0, LOAD_FAILURE_LIMIT - 1)}…` : collapsed;
}

/** True once the Factory extension has registered its command controller. */
export function factoryControllerRegistered(): boolean {
	return controller !== undefined;
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
	if (controller !== undefined) return "registered";
	return loadFailure === undefined ? "not-registered" : "load-failed";
}

/** Bounded, secret-free description of why the Factory handoff is unavailable. */
export function factoryLoadDiagnostic(): string {
	switch (factoryHandoffState()) {
		case "registered":
			return "the Luna Factory controller is registered";
		case "load-failed":
			return `the Luna Factory extension is packaged but failed to load: ${loadFailure}`;
		default:
			return "the Luna Factory extension never registered a controller: it is either absent from this build or was not passed to omp as an --extension";
	}
}

export async function factoryCommand(command: string, context: unknown): Promise<string> {
	if (!controller) throw new Error(`Factory is not loaded; enable the packaged Luna Factory extension. ${factoryLoadDiagnostic()}`);
	return controller(command, context);
}
