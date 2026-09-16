import type { FactoryAction, SelectedItem } from "../core/batch.ts";

type Controller = (command: string, context: unknown) => Promise<string>;
let selection: ((action: FactoryAction) => SelectedItem[]) | undefined;
let controller: Controller | undefined;

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
	return () => { if (controller === handler) controller = undefined; };
}
export async function factoryCommand(command: string, context: unknown): Promise<string> {
	if (!controller) throw new Error("Factory is not loaded; enable the packaged Luna Factory extension");
	return controller(command, context);
}
