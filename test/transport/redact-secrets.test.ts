import { expect } from 'chai';
import { redactSecrets } from '../../src/transport/redact-secrets.js';

describe('transport secret redaction', () => {
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
