// notify — entry point. Dispatches a message to one or more channels.

import { sendEmail } from './channels/email.js';
import { sendSms } from './channels/sms.js';
import { sendPush } from './channels/push.js';
import { formatMessage } from './format.js';
import { assertRecipient, assertChannelAllowed } from './guards.js';

const SENDERS = {
  email: sendEmail,
  sms: sendSms,
  push: sendPush,
};

export async function notify(recipient, message, channels = ['email']) {
  assertRecipient(recipient);

  const results = [];
  for (const channel of channels) {
    assertChannelAllowed(recipient, channel);
    const sender = SENDERS[channel];
    if (!sender) {
      results.push({ channel, ok: false, error: `unknown channel: ${channel}` });
      continue;
    }
    const body = formatMessage(message, recipient, channel);
    results.push(await sender(recipient, body));
  }
  return results;
}

export function availableChannels() {
  return Object.keys(SENDERS);
}
