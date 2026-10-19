import { expect } from 'chai';
import { redactSecrets, redactLogValue, redactArgv } from '../../src/transport/redact-secrets.js';

describe('transport secret redaction', () => {
  it('matches the secret-key policy in leading, subsequent and encoded text fields', () => {
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
        expect(redactSecrets(text), text).not.to.include('SECRET');
        expect(redactSecrets(encodeURIComponent(text)), text).not.to.include('SECRET');
      }
    }
    expect(redactSecrets('not_token=ordinary&safe=value')).to.equal(
      'not_token=ordinary&safe=value',
    );
  });

  it('masks complete authorization credentials including Digest parameters', () => {
    for (const header of ['Authorization', 'proxy-authorization', 'proxy_authorization']) {
      for (const value of [
        'Basic SECRET',
        'Bearer SECRET',
        'Negotiate SECRET',
        'Digest username="SECRET", realm="SECRET", response="SECRET"',
      ]) {
        expect(redactSecrets(`${header}: ${value}\nselector required`)).to.equal(
          `${header}: [REDACTED]\nselector required`,
        );
      }
    }
  });

  it('preserves native error frames and nested causes without invoking custom accessors', () => {
    const cause = new Error('sessionKey=SECRET');
    const error = new Error('token=SECRET', { cause });
    const sanitized = redactLogValue(error) as { stack: string; cause: { stack: string } };
    expect(sanitized.stack).to.include('redact-secrets.test.ts:').and.not.to.include('SECRET');
    expect(sanitized.cause.stack)
      .to.include('redact-secrets.test.ts:')
      .and.not.to.include('SECRET');
    const custom = new Error('ordinary');
    Object.defineProperty(custom, 'stack', {
      get() {
        throw new Error('must not invoke');
      },
    });
    expect(redactLogValue(custom)).to.have.property('stack', '[omitted accessor]');
    const fake = Object.create(Error.prototype) as Error;
    Object.defineProperty(
      fake,
      'stack',
      Object.getOwnPropertyDescriptor(new Error('native stack descriptor'), 'stack')!,
    );
    expect(redactLogValue(fake)).to.have.property('stack', '[omitted accessor]');
  });
  it('sanitizes JSON headers, form credentials and encoded bodies without hiding guard prose', () => {
    for (const text of [
      '{"Authorization":"Basic SECRET", "nested":{"clientSecret":"SECRET"}, "reason":"selector required"}',
      'client_secret=SECRET&access_token=SECRET&safe=value',
      encodeURIComponent('{"cookie":"SECRET","reason":"selector required"}'),
    ]) {
      expect(redactSecrets(text)).not.to.include('SECRET');
    }
    expect(redactArgv(['content', '--password=SECRET', '--name=a b'])).to.deep.equal([
      'content',
      '--password=[REDACTED]',
      '--name=a b',
    ]);
    const value: Record<string, unknown> = { message: 'selector required' };
    value.self = value;
    Object.defineProperty(value, 'getter', {
      get() {
        throw new Error('must not invoke');
      },
    });
    expect(redactLogValue(value)).to.deep.equal({
      message: 'selector required',
      self: '[omitted circular reference]',
      getter: '[omitted accessor]',
    });
  });
  it('redacts sensitive headers case-insensitively', () => {
    const message = [
      'AUTHORIZATION: Bearer auth-secret',
      'proxy-Authorization=Basic proxy-secret',
      'Cookie: sid=cookie-secret; other=value',
      'SET-cookie=session=set-cookie-secret; Secure',
    ].join('\n');
    const redacted = redactSecrets(message);
    expect(redacted).to.equal(
      [
        'AUTHORIZATION: [REDACTED]',
        'proxy-Authorization=[REDACTED]',
        'Cookie: [REDACTED]',
        'SET-cookie=[REDACTED]',
      ].join('\n'),
    );
  });

  it('redacts bearer and Salesforce token query values', () => {
    const message =
      'failed Bearer loose-secret at https://example.test/?ACCESS_TOKEN=a&refresh_token=b&id_token=c&token=d&safe=value';
    const redacted = redactSecrets(message);
    expect(redacted).to.include('Bearer [REDACTED]');
    for (const secret of [
      'ACCESS_TOKEN=a',
      'refresh_token=b',
      'id_token=c',
      'token=d',
      'loose-secret',
    ]) {
      expect(redacted).not.to.include(secret);
    }
    expect(redacted).to.include('safe=value');
  });

  it('redacts AWS and Azure signed URL fields while preserving useful URL context', () => {
    const message =
      'GET https://bucket.example/path?X-Amz-Credential=cred&x-amz-signature=aws-signature&X-Amz-Security-Token=security&se=expiry&sp=rw&sr=b&sv=2024&sig=azure-signature&mode=diagnostic';
    const redacted = redactSecrets(message);
    expect(redacted).to.include('https://bucket.example/path?');
    expect(redacted).to.include('mode=diagnostic');
    for (const value of [
      'cred',
      'aws-signature',
      'security',
      'expiry',
      '=rw',
      '=b',
      '=2024',
      'azure-signature',
    ]) {
      expect(redacted).not.to.include(value);
    }
  });

  it('does not redact ordinary prose containing signature or cookie words', () => {
    const message =
      'The signature validation failed after the cookie parser returned a diagnostic.';
    expect(redactSecrets(message)).to.equal(message);
  });
});
