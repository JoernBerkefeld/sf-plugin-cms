import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exitCodeOf } from '../lib/exit-code.js';

/**
 * A result envelope with the given errors and items.
 * @param {object[]} errors Error diagnostics.
 * @param {object[] | undefined} items Result items; undefined for a result without items.
 * @returns {object} Envelope.
 */
function envelope(errors, items) {
  return {
    status: errors.length === 0 ? 'success' : 'failed',
    metadata: { command: 'sf cms deploy', apiVersion: '68.0', plugin: {} },
    diagnostics: { warnings: [], errors },
    result: items === undefined ? { workspaces: [] } : { items },
  };
}

const failed = (component) => ({ code: 'REQUEST_FAILED', message: 'x', hint: 'x', component });
const timedOut = (component) => ({
  code: 'UNKNOWN_OUTCOME',
  message: 'x',
  hint: 'x',
  component,
  transportError: { name: 'AbortError' },
});
const dropped = (component) => ({
  code: 'UNKNOWN_OUTCOME',
  message: 'x',
  hint: 'x',
  component,
  transportError: { name: 'FetchError', code: 'ECONNRESET' },
});
const unconfirmed = (component) => ({
  code: 'STATE_NOT_CONFIRMED',
  message: 'x',
  hint: 'x',
  component,
});
const item = (apiName, outcome) => ({ type: 'email', apiName, outcome });

test('exit code: 0 when nothing failed, also for a result without items', () => {
  assert.equal(exitCodeOf(envelope([], [item('A', 'created'), item('B', 'unchanged')])), 0);
  assert.equal(exitCodeOf(envelope([])), 0);
});

test('exit code: 1 when something failed and nothing else was written', () => {
  assert.equal(
    exitCodeOf(envelope([failed('email:A')], [item('A', 'failed'), item('B', 'not-attempted')])),
    1,
  );
  assert.equal(exitCodeOf(envelope([failed('email:A')], [item('A', 'blocked')])), 1);
  assert.equal(exitCodeOf(envelope([failed()])), 1);
  // The written component is the failed one (a confirmed delete whose local file stayed).
  assert.equal(exitCodeOf(envelope([failed('email:A')], [item('A', 'deleted')])), 1);
  // A dropped connection is no wait that ran out.
  assert.equal(exitCodeOf(envelope([dropped('email:A')], [item('A', 'unknown')])), 1);
});

test('exit code: 68 when something failed and another component was written', () => {
  for (const outcome of ['created', 'updated', 'deleted', 'published', 'unpublished', 'retrieved'])
    assert.equal(
      exitCodeOf(envelope([failed('email:B')], [item('A', outcome), item('B', 'failed')])),
      68,
      outcome,
    );
  assert.equal(
    exitCodeOf(envelope([failed('email:B')], [item('A', 'unchanged'), item('B', 'failed')])),
    1,
  );
});

test('exit code: 69 when an outcome is open and nothing failed', () => {
  assert.equal(
    exitCodeOf(
      envelope(
        [timedOut('email:B')],
        [item('A', 'created'), item('B', 'unknown'), item('C', 'not-attempted')],
      ),
    ),
    69,
  );
  assert.equal(exitCodeOf(envelope([unconfirmed('email:A')], [item('A', 'published')])), 69);
});

test('exit code: a failure wins over an open outcome', () => {
  // A published but not confirmed, B refused: A counts as written, so partial.
  assert.equal(
    exitCodeOf(
      envelope(
        [unconfirmed('email:A'), failed('email:B')],
        [item('A', 'published'), item('B', 'failed')],
      ),
    ),
    68,
  );
  assert.equal(exitCodeOf(envelope([timedOut('email:A'), failed()], [item('A', 'unknown')])), 1);
});
