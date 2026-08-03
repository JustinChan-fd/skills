// format — turns a message plus recipient into channel-ready body text.

import { mergeFields } from './legacy/mergeFields.js';
import { truncateForChannel } from './guards.js';

const SALUTATION = {
  email: 'Hello {{name}},',
  sms: '{{name}}:',
  push: '',
};

export function formatMessage(message, recipient, channel) {
  var salutation = SALUTATION[channel] ?? '';
  const values = { name: recipient.name ?? 'there', id: recipient.id };
  const opening = mergeFields(salutation, values);
  const body = mergeFields(message, values);
  const joined = opening ? `${opening} ${body}` : body;
  return truncateForChannel(joined, channel);
}

export function previewMessage(message, recipient, channel) {
  const out = formatMessage(message, recipient, channel);
  console.log(`[preview:${channel}] ${out}`);
  return out;
}
