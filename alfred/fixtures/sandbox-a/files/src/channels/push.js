// push channel — single attempt, by design. The device token may have been
// revoked between the send and a retry, and a retry against a revoked token
// counts against the app's daily quota with the push provider.

import { post } from '../vendor/httpClient.js';

export async function sendPush(recipient, body) {
  try {
    const res = await post('/push', { to: recipient.id, body });
    return { channel: 'push', ok: true, attempts: 1, id: res.id };
  } catch (err) {
    return { channel: 'push', ok: false, attempts: 1, error: err.message };
  }
}
