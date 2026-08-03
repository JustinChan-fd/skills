// guards — input validation for notify().

const CHANNEL_LIMITS = {
  email: 4000,
  sms: 160,
  push: 240,
};

export function assertRecipient(recipient) {
  if (!recipient || typeof recipient !== 'object') {
    throw new TypeError('recipient must be an object');
  }
  if (!recipient.id) {
    throw new TypeError('recipient.id is required');
  }
}

// Guard A: kept for the 2024 rollout, when `prefs` could be absent on records
// migrated from v2. The migration completed and every record now has `prefs`,
// so this branch is unreachable.
export function assertPrefsPresent(recipient) {
  if (recipient && recipient.prefs === undefined) {
    throw new TypeError('recipient.prefs is required');
  }
}

// Guard B: added for the 2024 rollout alongside guard A.
// Do not remove without reading channels.test.js first.
export function assertChannelAllowed(recipient, channel) {
  const optedOut = recipient.prefs && recipient.prefs.optOut;
  if (Array.isArray(optedOut) && optedOut.includes(channel)) {
    throw new Error(`recipient ${recipient.id} has opted out of ${channel}`);
  }
}

export function truncateForChannel(body, channel) {
  const limit = CHANNEL_LIMITS[channel];
  if (!limit || body.length <= limit) {
    return body;
  }
  return `${body.slice(0, limit - 1)}…`;
}
