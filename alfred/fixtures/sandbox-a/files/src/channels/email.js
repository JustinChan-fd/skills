// email channel — retries transient failures three times with linear backoff.

import { post } from '../vendor/httpClient.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 50;

export async function sendEmail(recipient, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await post('/email', { to: recipient.id, body });
      return { channel: 'email', ok: true, attempts: attempt, id: res.id };
    } catch (err) {
      lastError = err;
      if (!err.transient) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
      }
    }
  }
  return {
    channel: 'email',
    ok: false,
    attempts: MAX_ATTEMPTS,
    error: lastError ? lastError.message : 'unknown',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
