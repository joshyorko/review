/**
 * Key normalization.
 *
 * omp enables the kitty keyboard protocol when the terminal supports it, so the
 * bytes for Escape or an arrow differ between terminals. The host's `matchesKey`
 * knows the difference; this module turns it into one canonical name the dashboard
 * can switch on, and supplies a raw-sequence fallback for headless use.
 */

export type KeyMatcher = (data: string, key: string) => boolean;

/** Canonical names the dashboard reacts to, with their legacy sequences. */
export const RAW_KEYS: Record<string, readonly string[]> = {
	escape: ["\u001b"],
	return: ["\r", "\n"],
	tab: ["\t"],
	space: [" "],
	up: ["\u001b[A"],
	down: ["\u001b[B"],
	right: ["\u001b[C"],
	left: ["\u001b[D"],
	backspace: ["\u007f", "\b"],
};

export const rawKeyMatcher: KeyMatcher = (data, key) => (RAW_KEYS[key] ?? [key]).includes(data);

/** Special-key name for `data`, or the data itself when it is ordinary text. */
export function canonicalKey(data: string, matchKey: KeyMatcher): string {
	for (const name of Object.keys(RAW_KEYS)) {
		if (matchKey(data, name)) return name;
	}
	return data;
}
