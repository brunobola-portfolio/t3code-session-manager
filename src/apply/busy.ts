// Files another program holds open (antivirus, sync client, an editor): retried briefly, then the caller holds the root.

/** Error codes of a file another program holds open (antivirus, sync client, an editor) on Windows. */
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
export const isBusy = (e: unknown): boolean => BUSY_CODES.has((e as NodeJS.ErrnoException)?.code ?? "");
/** Waits between tries of a busy file: tried once, then again after 100, 300 and 1000 ms. */
export const BUSY_RETRY_MS = [100, 300, 1000];

/** `fn`, retried while it fails with a busy-file error; the last error is thrown. */
export async function retryBusy<T>(fn: () => Promise<T>, delays: readonly number[] = BUSY_RETRY_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusy(e) || i >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}
