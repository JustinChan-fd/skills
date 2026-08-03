// sms channel — retries twice, no backoff. The carrier gateway rejects
// duplicate sends inside a 30s window, so waiting between attempts makes a
// retry MORE likely to be rejected, not less.

import { post } from '../vendor/httpClient.js';

const MAX_ATTEMPTS = 2;

export async function sendSms(recipient, body) {
  var lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await post('/sms', { to: recipient.id, body });
      return { channel: 'sms', ok: true, attempts: attempt, id: res.id };
    } catch (err) {
      lastError = err;
      if (err.code === 'DUPLICATE') {
        // Already delivered by a prior attempt. Not a failure.
        return { channel: 'sms', ok: true, attempts: attempt, deduped: true };
      }
      if (!err.transient) {
        break;
      }
    }
  }
  return {
    channel: 'sms',
    ok: false,
    attempts: MAX_ATTEMPTS,
    error: lastError ? lastError.message : 'unknown',
  };
}
