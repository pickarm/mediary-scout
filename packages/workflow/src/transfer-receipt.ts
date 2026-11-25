/** A persistence callback failure must escape provider catch blocks unchanged in
 *  meaning: the remote task is already live, so continuing the landing poll would
 *  let the workflow proceed without a recoverable receipt. */
export class TransferSubmissionPersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TransferSubmissionPersistenceError";
  }
}

export async function notifyTransferSubmitted(
  callback: ((receipt: Record<string, unknown>) => Promise<void>) | undefined,
  receipt: Record<string, unknown>,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(receipt);
  } catch (error) {
    throw new TransferSubmissionPersistenceError(error);
  }
}

export function isTransferSubmissionPersistenceError(
  error: unknown,
): error is TransferSubmissionPersistenceError {
  return error instanceof TransferSubmissionPersistenceError;
}
