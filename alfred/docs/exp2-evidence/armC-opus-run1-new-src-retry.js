// retry — the single retry policy shared by every notification channel:
// 3 attempts with exponential backoff. Only transient errors are retried.

export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 50;

// Exponential: 50ms before attempt 2, 100ms before attempt 3. `attempt` is
// 1-based and is never asked for on the final attempt.
export function backoffFor(attempt) {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `send(attempt)` under the standard policy and reports the outcome as
// either { ok: true, attempts, value } or { ok: false, attempts, error }.
//
// `classify(err, attempt)` is an optional per-channel hook. Returning a value
// from it stops the loop and makes that value the outcome, which is how sms
// turns a DUPLICATE rejection into a delivery instead of a failure.
export async function withRetry(send, classify) {
  let lastError = null;
  let used = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    used = attempt;
    try {
      return { ok: true, attempts: attempt, value: await send(attempt) };
    } catch (err) {
      const classified = classify ? classify(err, attempt) : null;
      if (classified) {
        return classified;
      }
      lastError = err;
      // A non-transient failure will not get better by waiting.
      if (!err.transient) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
      }
    }
  }

  // `used` is the number of sends actually made, which is below MAX_ATTEMPTS
  // when a non-transient error ended the loop early.
  return {
    ok: false,
    attempts: used,
    error: lastError ? lastError.message : 'unknown',
  };
}
