// retry — shared retry policy for all notification channels: 3 attempts,
// exponential backoff between attempts.

export const MAX_ATTEMPTS = 3;

const BACKOFF_BASE_MS = 50;

export function backoffMs(attempt) {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
