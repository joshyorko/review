/**
 * One deadline primitive, shared by every network read in this mode.
 *
 * omp gives an extension handler a bounded budget and kills it when it expires,
 * so an unbounded `fetch` is not slow — it is fatal to the session that owns it.
 * Every read here therefore carries its own ceiling and degrades to "we could
 * not ask" rather than holding the handler open.
 */

/**
 * The caller's cancellation, plus our own deadline.
 *
 * `AbortSignal.timeout` alone would discard an explicit `signal`; composing them
 * keeps both, so a session teardown still cancels an in-flight read.
 */
export function deadlineSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
