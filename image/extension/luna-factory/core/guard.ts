/**
 * The package's single canonical object guard.
 *
 * `Record<string, unknown>` narrows the container, not its fields: every caller
 * still checks the properties it reads. Keeping one copy here stops each module
 * from growing its own subtly different version.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
