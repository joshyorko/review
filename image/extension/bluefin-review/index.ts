/**
 * Project Bluefin review mode for Oh My Pi.
 *
 * Entry point. Binds the host's key matcher to the mode and starts it; all
 * behavior lives in `extension.ts` and the modules beneath it.
 *
 * Keyboard only — this mode registers no slash commands.
 *   alt+b   dashboard        alt+j / alt+k   next / previous queue item
 *   alt+x   toggle select    alt+i           prs <-> issues
 *   alt+u   refetch queue    alt+s           autoslay (slay PR / close issue)
 *   alt+y   cite selection(s)
 *
 * Inside the dashboard: j/k move, tab switches pane, h/l fold spans, / filters,
 * r review, d diff, a approve+merge, f fix findings, s slay, b snapshot, ? help.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { type ReviewExtensionHost, createReviewExtension } from "./extension.ts";

export default function bluefinReviewExtension(pi: ReviewExtensionHost): void {
	createReviewExtension(pi, { matchKey: (data, key) => matchesKey(data, key as KeyId) });
}
