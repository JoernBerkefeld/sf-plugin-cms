import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactArgv, redactLogValue, redactSecrets } from '../lib/transport/redact-secrets.js';

test('masks secret keys in leading, later and encoded text fields', () => {
  for (const key of [
    'authorization',
    'proxy_authorization',
    'cookie',
    'set_cookie',
    'accessToken',
    'refresh-token',
    'id_token',
    'token',
    'password',
    'passwd',
    'clientSecret',
    'session',
    'sessionId',
    'sessionKey',
    'fueloauth',
  ]) {
    for (const text of [
      `${key}=SECRET&safe=value`,
      `safe=value&${key}=SECRET`,
      `failure ${key}: SECRET`,
    ]) {
      assert.doesNotMatch(redactSecrets(text), /SECRET/u, text);
      assert.doesNotMatch(redactSecrets(encodeURIComponent(text)), /SECRET/u, text);
    }
  }
  assert.equal(redactSecrets('not_token=ordinary&safe=value'), 'not_token=ordinary&safe=value');
});

test('masks complete authorization credentials, also Digest parameters', () => {
  for (const header of ['Authorization', 'proxy-authorization', 'proxy_authorization'])
    for (const value of [
      'Basic SECRET',
      'Bearer SECRET',
      'Negotiate SECRET',
      'Digest username="SECRET", realm="SECRET", response="SECRET"',
    ])
      assert.equal(
        redactSecrets(`${header}: ${value}\nselector required`),
        `${header}: [REDACTED]\nselector required`,
      );
});

test('masks headers case-insensitively, bearer tokens and token query values', () => {
  assert.equal(
    redactSecrets(
      [
        'AUTHORIZATION: Bearer auth-secret',
        'proxy-Authorization=Basic proxy-secret',
        'Cookie: sid=cookie-secret; other=value',
        'SET-cookie=session=set-cookie-secret; Secure',
      ].join('\n'),
    ),
    [
      'AUTHORIZATION: [REDACTED]',
      'proxy-Authorization=[REDACTED]',
      'Cookie: [REDACTED]',
      'SET-cookie=[REDACTED]',
    ].join('\n'),
  );
  const redacted = redactSecrets(
    'failed Bearer loose-secret at https://example.test/?ACCESS_TOKEN=a&refresh_token=b&id_token=c&token=d&safe=value',
  );
  assert.match(redacted, /Bearer \[REDACTED\]/u);
  for (const secret of ['ACCESS_TOKEN=a', 'refresh_token=b', 'id_token=c', 'token=d', 'loose'])
    assert.ok(!redacted.includes(secret), secret);
  assert.match(redacted, /safe=value/u);
});

test('masks signed URL fields and keeps the rest of the URL', () => {
  const redacted = redactSecrets(
    'GET https://bucket.example/path?X-Amz-Credential=cred&x-amz-signature=aws-signature&X-Amz-Security-Token=security&se=expiry&sp=rw&sr=b&sv=2024&sig=azure-signature&mode=diagnostic',
  );
  assert.match(redacted, /https:\/\/bucket\.example\/path\?/u);
  assert.match(redacted, /mode=diagnostic/u);
  for (const value of ['cred', 'aws-signature', 'security', 'expiry', '=rw', '=2024', 'azure'])
    assert.ok(!redacted.includes(value), value);
});

test('sanitizes JSON, form bodies, argv, cycles and accessors without invoking them', () => {
  for (const text of [
    '{"Authorization":"Basic SECRET", "nested":{"clientSecret":"SECRET"}, "reason":"ok"}',
    'client_secret=SECRET&access_token=SECRET&safe=value',
    encodeURIComponent('{"cookie":"SECRET","reason":"ok"}'),
  ])
    assert.doesNotMatch(redactSecrets(text), /SECRET/u);
  assert.deepEqual(redactArgv(['list', '--password=SECRET', '--name=a b', '--token', 'SECRET']), [
    'list',
    '--password=[REDACTED]',
    '--name=a b',
    '--token',
    '[REDACTED]',
  ]);
  const value = { message: 'ok' };
  value.self = value;
  Object.defineProperty(value, 'getter', {
    enumerable: true,
    get() {
      throw new Error('must not invoke');
    },
  });
  assert.deepEqual(
    { ...redactLogValue(value) },
    { message: 'ok', self: '[omitted circular reference]', getter: '[omitted accessor]' },
  );
});

test('keeps native error stacks and causes, redacted', () => {
  const error = new Error('token=SECRET', { cause: new Error('sessionKey=SECRET') });
  const sanitized = redactLogValue(error);
  assert.match(sanitized.stack, /redact-secrets\.test\.mjs:/u);
  assert.doesNotMatch(sanitized.stack, /SECRET/u);
  assert.doesNotMatch(sanitized.cause.stack, /SECRET/u);
  assert.deepEqual(redactLogValue(Buffer.from('abc')), { omitted: 'binary', byteLength: 3 });
});
