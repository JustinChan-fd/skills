// differential-oracle — behavioral-equivalence check for the refactor.
//
// Added in round 2 after the round-1 verifier found a real regression the
// original harness could not catch: every probe in e2e-probe.mjs asserts the
// NEW code against hand-written expectations, so any path where old and new
// differ — but the new value still looks reasonable — passes. For a refactor,
// the central question is not "is the new behavior sensible" but "is it the
// SAME". That needs the old code, executed.
//
// Usage:
//   node <this file> --old <path-to-main-worktree> --new <path-to-branch-tree>
//
// It imports BOTH trees' real modules in one process, runs every scenario
// against each, canonicalizes the outcome (including key order, and
// thrown-vs-returned), and diffs. Exit 0 iff every scenario matches.
//
// Scenarios deliberately include the degenerate transport responses the repo
// suite never exercises: empty/null bodies, non-Error throws, DUPLICATE on the
// first attempt. Those are where a refactor silently changes shape.

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { values } = parseArgs({
  options: { old: { type: 'string' }, new: { type: 'string' } },
});

if (!values.old || !values.new) {
  console.error('usage: node differential-oracle.mjs --old <dir> --new <dir>');
  process.exit(2);
}

async function loadTree(root) {
  const url = (rel) => pathToFileURL(join(root, rel)).href;
  return {
    http: await import(url('src/vendor/httpClient.js')),
    email: await import(url('src/channels/email.js')),
    sms: await import(url('src/channels/sms.js')),
    push: await import(url('src/channels/push.js')),
    notify: await import(url('src/notify.js')),
  };
}

const OLD = await loadTree(values.old);
const NEW = await loadTree(values.new);

function transient(message) {
  const err = new Error(message);
  err.transient = true;
  return err;
}

function duplicateErr() {
  const err = new Error('duplicate within window');
  err.code = 'DUPLICATE';
  return err;
}

// Canonical form captures VALUE, KEY ORDER, and whether it threw — three ways
// a refactor can drift while still "working".
function canonical(outcome) {
  if (outcome.threw) {
    return `THREW ${outcome.name}: ${outcome.message}`;
  }
  const render = (v) => {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `[${v.map(render).join(', ')}]`;
    if (typeof v === 'object') {
      // Key order preserved deliberately — a reordered result object is an
      // observable change for anything doing JSON.stringify comparison.
      return `{${Object.keys(v)
        .map((k) => `${k}: ${render(v[k])}`)
        .join(', ')}}`;
    }
    return JSON.stringify(v);
  };
  return `RETURNED ${render(outcome.value)}`;
}

async function run(tree, scenario) {
  try {
    const value = await scenario(tree);
    return { threw: false, value };
  } catch (err) {
    return { threw: true, name: err?.name ?? typeof err, message: err?.message ?? String(err) };
  }
}

// Each scenario is a function of the tree, so it runs identically on both.
// `counter` is per-invocation so old and new each get a fresh call sequence.
const SCENARIOS = {
  // --- well-formed responses (the paths the repo suite covers) ---
  'email: success first attempt': async (t) => {
    t.http.setHandler(async () => ({ id: 'e-1' }));
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: transient x2 then success': async (t) => {
    let n = 0;
    t.http.setHandler(async () => {
      n++;
      if (n < 3) throw transient('busy');
      return { id: 'e-2' };
    });
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: transient forever (exhaust)': async (t) => {
    t.http.setHandler(async () => {
      throw transient('busy');
    });
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: non-transient first attempt': async (t) => {
    t.http.setHandler(async () => {
      throw new Error('address rejected');
    });
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'sms: success first attempt': async (t) => {
    t.http.setHandler(async () => ({ id: 's-1' }));
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: transient then success': async (t) => {
    let n = 0;
    t.http.setHandler(async () => {
      n++;
      if (n < 2) throw transient('busy');
      return { id: 's-2' };
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: transient forever (exhaust at 2)': async (t) => {
    t.http.setHandler(async () => {
      throw transient('busy');
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: DUPLICATE on first attempt': async (t) => {
    t.http.setHandler(async () => {
      throw duplicateErr();
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: transient then DUPLICATE': async (t) => {
    let n = 0;
    t.http.setHandler(async () => {
      n++;
      if (n === 1) throw transient('busy');
      throw duplicateErr();
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: non-transient first attempt': async (t) => {
    t.http.setHandler(async () => {
      throw new Error('bad number');
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'push: success': async (t) => {
    t.http.setHandler(async () => ({ id: 'p-1' }));
    return t.push.sendPush({ id: 'u1' }, 'hi');
  },
  'push: transient failure (no retry)': async (t) => {
    t.http.setHandler(async () => {
      throw transient('busy');
    });
    return t.push.sendPush({ id: 'u1' }, 'hi');
  },

  // --- degenerate responses: THE REGRESSION CLASS from round 1 ---
  'email: transport resolves undefined': async (t) => {
    t.http.setHandler(async () => undefined);
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: transport resolves null': async (t) => {
    t.http.setHandler(async () => null);
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: transport resolves body with no id': async (t) => {
    t.http.setHandler(async () => ({ status: 204 }));
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'sms: transport resolves undefined': async (t) => {
    t.http.setHandler(async () => undefined);
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: transport resolves null': async (t) => {
    t.http.setHandler(async () => null);
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'sms: transport resolves body with no id': async (t) => {
    t.http.setHandler(async () => ({ status: 204 }));
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'push: transport resolves undefined': async (t) => {
    t.http.setHandler(async () => undefined);
    return t.push.sendPush({ id: 'u1' }, 'hi');
  },

  // --- odd throws ---
  'email: throws a string, not an Error': async (t) => {
    t.http.setHandler(async () => {
      throw 'plain string failure';
    });
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'email: throws Error with empty message': async (t) => {
    t.http.setHandler(async () => {
      throw new Error('');
    });
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },
  'sms: throws transient with DUPLICATE code': async (t) => {
    t.http.setHandler(async () => {
      const err = transient('dup and transient');
      err.code = 'DUPLICATE';
      throw err;
    });
    return t.sms.sendSms({ id: 'u1' }, 'hi');
  },
  'email: no handler installed': async (t) => {
    t.http.resetHandler();
    return t.email.sendEmail({ id: 'u1' }, 'hi');
  },

  // --- through the real dispatcher, incl. the blast-radius case ---
  'notify: all three channels succeed': async (t) => {
    t.http.setHandler(async (path) => ({ id: `x${path}` }));
    return t.notify.notify({ id: 'u9', name: 'Sam', prefs: {} }, 'hello', [
      'email',
      'sms',
      'push',
    ]);
  },
  'notify: email empty body, other channels healthy (blast radius)': async (t) => {
    t.http.setHandler(async (path) =>
      path === '/email' ? undefined : { id: `x${path}` },
    );
    return t.notify.notify({ id: 'u9', name: 'Sam', prefs: {} }, 'hello', [
      'email',
      'sms',
      'push',
    ]);
  },
  'notify: sms empty body, other channels healthy': async (t) => {
    t.http.setHandler(async (path) =>
      path === '/sms' ? undefined : { id: `x${path}` },
    );
    return t.notify.notify({ id: 'u9', name: 'Sam', prefs: {} }, 'hello', [
      'email',
      'sms',
      'push',
    ]);
  },
  'notify: opted-out channel rejects': async (t) => {
    t.http.setHandler(async () => ({ id: 'x-1' }));
    return t.notify.notify(
      { id: 'u9', name: 'Sam', prefs: { optOut: ['sms'] } },
      'hello',
      ['sms'],
    );
  },
  'notify: unknown channel': async (t) => {
    t.http.setHandler(async () => ({ id: 'x-1' }));
    return t.notify.notify({ id: 'u9', name: 'Sam', prefs: {} }, 'hello', [
      'fax',
    ]);
  },
  'notify: retry through dispatcher': async (t) => {
    let n = 0;
    t.http.setHandler(async () => {
      n++;
      if (n < 3) throw transient('busy');
      return { id: 'e-3' };
    });
    return t.notify.notify({ id: 'u1', name: 'Ada', prefs: {} }, 'hi', [
      'email',
    ]);
  },
  'notify: non-object recipient': async (t) => {
    t.http.setHandler(async () => ({ id: 'x' }));
    return t.notify.notify('not-an-object', 'hi', ['email']);
  },
  'notify: default channel list': async (t) => {
    t.http.setHandler(async () => ({ id: 'd-1' }));
    return t.notify.notify({ id: 'u1', name: 'Ada', prefs: {} }, 'hi');
  },
  'notify: availableChannels': async (t) => t.notify.availableChannels(),
};

let mismatches = 0;
const names = Object.keys(SCENARIOS);

for (const name of names) {
  const oldOut = canonical(await run(OLD, SCENARIOS[name]));
  OLD.http.resetHandler();
  const newOut = canonical(await run(NEW, SCENARIOS[name]));
  NEW.http.resetHandler();

  if (oldOut === newOut) {
    emit(`SAME  ${name}\n        ${oldOut}`);
  } else {
    mismatches++;
    emit(`DIFF  ${name}`);
    emit(`        old: ${oldOut}`);
    emit(`        new: ${newOut}`);
  }
}

emit(
  `\n${names.length} scenarios, ${mismatches} divergence(s)` +
    (mismatches === 0 ? ' — BEHAVIORALLY EQUIVALENT' : ' — NOT EQUIVALENT'),
);
process.exit(mismatches === 0 ? 0 : 1);
