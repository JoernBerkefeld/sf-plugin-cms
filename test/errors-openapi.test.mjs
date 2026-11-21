import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CmsError,
  errorCodeInfo,
  formatDiagnostic,
  registeredErrorCodes,
  toDiagnostic,
} from '../lib/errors/registry.js';
import { CmsRequestError } from '../lib/transport/json-request.js';
import { checkSelectedOpenApi } from '../lib/openapi/generate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every registered code has an upper-case name and a hint sentence', () => {
  for (const code of registeredErrorCodes()) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/u);
    assert.match(errorCodeInfo(code).hint, /\.$/u, code);
  }
});

test('a Salesforce answer keeps status, error code and request ID; 401 is an auth failure', () => {
  const diagnostic = toDiagnostic(
    new CmsRequestError('content.create', 'failed', 400, {
      errorCode: 'INVALID_INPUT',
      responseMessage: 'Bad title',
      requestId: 'req-1',
    }),
  );
  assert.deepEqual(diagnostic, {
    code: 'REQUEST_FAILED',
    message: 'content.create: HTTP 400: INVALID_INPUT: Bad title',
    status: 400,
    salesforceErrorCode: 'INVALID_INPUT',
    requestId: 'req-1',
    hint: errorCodeInfo('REQUEST_FAILED').hint,
  });
  assert.equal(
    toDiagnostic(new CmsRequestError('workspace.list', 'Session expired', 401)).code,
    'AUTHENTICATION_FAILED',
  );
  assert.equal(
    toDiagnostic(new CmsError('WORKSPACE_NOT_FOUND', 'No X')).code,
    'WORKSPACE_NOT_FOUND',
  );
  assert.equal(
    formatDiagnostic({ code: 'WORKSPACE_NOT_FOUND', message: 'No X' }),
    `WORKSPACE_NOT_FOUND: No X\nHint: ${errorCodeInfo('WORKSPACE_NOT_FOUND').hint}`,
  );
});

test('src/generated/operations.ts matches the bundled OpenAPI schema', async () => {
  await checkSelectedOpenApi(
    path.join(root, 'resources', 'openapi', 'connect-rest-api-cms-v67.yaml'),
    path.join(root, 'src', 'generated'),
  );
});
