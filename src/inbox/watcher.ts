import { acquireExclusiveLock, watchLockPath } from "../run/locks.js";
import { loadTrustedConfig } from "../config/config-loader.js";
import { ensurePhaseStateDirectory } from "../run/preparation-service.js";
import { scanInbox } from "./scanner.js";
import type { ScanSummary, WatchOptions } from "./contracts.js";

export async function watchInbox(options: WatchOptions): Promise<void> {
  await ensurePhaseStateDirectory(options.stateDirectory);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const config = options.config ?? (await loadTrustedConfig(options.configPath)).inbox;
  const scanOptions = { ...options, config };
  const lock = await acquireExclusiveLock(watchLockPath(options.stateDirectory), "WATCH_LOCKED");
  let iterations = 0;
  try {
    while (!options.signal?.aborted && (options.maxIterations === undefined || iterations < options.maxIterations)) {
      const summary = await scanInbox(scanOptions);
      await options.onScan?.(summary);
      iterations += 1;
      if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
      await sleep(config.poll_interval_ms);
    }
  } finally {
    await lock.release();
  }
}

export const watch = watchInbox;
