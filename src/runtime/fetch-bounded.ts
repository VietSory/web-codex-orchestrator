export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createBoundedFetch(options: {
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): FetchLike {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 24 * 60 * 60 * 1000) {
    throw new Error("Bounded fetch timeout must be a positive bounded integer.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init = {}) => {
    const controller = new AbortController();
    const external = init.signal;
    const relayAbort = () => controller.abort(external?.reason);
    if (external?.aborted) relayAbort();
    else external?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`HTTP request exceeded ${options.timeoutMs}ms deadline.`)), options.timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", relayAbort);
    }
  };
}
