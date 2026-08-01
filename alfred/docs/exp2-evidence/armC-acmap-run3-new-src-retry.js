// retry — shared policy for all notification channels: 3 attempts, exponential backoff.

export const MAX_ATTEMPTS = 3;

const BASE_BACKOFF_MS = 50;

export function backoffMs(attempt) {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
