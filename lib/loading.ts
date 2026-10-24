// Loading a channel in stages the desk can show (connecting, downloading,
// processing), and bounded waits for work that may never finish: a fetch on a
// stalled mobile link, or an IndexedDB call Safari leaves pending forever.

export type LoadPhase =
  | { phase: 'connecting' }
  | { phase: 'downloading'; received: number; total?: number }
  | { phase: 'processing' };

/** What the timeline shows while a channel loads, or after it was cancelled. */
export type LoadState = (LoadPhase | { phase: 'cancelled' }) & { channelId: string };

/** The channel's programming request: generous, since a large channel on a slow link takes a while. */
export const PROGRAMMING_TIMEOUT_MS = 90_000;
/** Health, channel list and the day's guide: small answers. */
export const SHORT_TIMEOUT_MS = 30_000;
/** How long the lineup waits for the stored draft (read in parallel) before it is shown without it. */
export const DRAFT_WAIT_MS = 1_500;

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function loadingCopy(state: LoadState | null): { title: string; text: string } {
  switch (state?.phase) {
    case 'downloading':
      return { title: 'Downloading the lineup…', text: `${formatBytes(state.received)}${state.total ? ` of ${formatBytes(state.total)}` : ''} received.` };
    case 'processing':
      return { title: 'Preparing the lineup…', text: 'Working out this day’s schedule.' };
    case 'cancelled':
      return { title: 'Loading cancelled', text: 'This channel wasn’t loaded. Try again when you’re ready.' };
    default:
      return { title: 'Connecting to Tunarr…', text: 'Waiting for this channel’s programming.' };
  }
}

/**
 * Waits for `promise` at most `ms`. Either way it carries on in the
 * background; `late` is the same promise, for a result that arrives after.
 */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false; late: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const wrapped = promise.then((value) => ({ settled: true as const, value }));
  try {
    return (await Promise.race([wrapped, timeout])) ?? { settled: false, late: promise };
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects with `error()` if `promise` hasn't settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An AbortSignal that fires when `parent` does or after `timeoutMs`
 * (AbortSignal.any and AbortSignal.timeout aren't in every Safari the desk runs on).
 */
export function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}

/** Lets the browser paint (a phase change) before a long synchronous step such as JSON.parse. */
export const nextPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
