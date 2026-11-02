/** Wait `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Read until `done(value)` or `timeoutMs` has passed (every `gapMs`); returns the LAST value read either way, so the
 * caller asserts or reports BLOCKED on it. One copy for the specs that each had their own (2026-10-19 clean-up).
 */
export async function poll<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 180_000, gapMs = 6_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let v = await read();
  while (!done(v) && Date.now() < until) { await sleep(gapMs); v = await read(); }
  return v;
}
