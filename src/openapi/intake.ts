import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LineCounter, parseDocument, type YAMLParseError, type YAMLWarning } from 'yaml';

const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonPrimitive = boolean | null | number | string;

export type OpenApiOperation = {
  method: string;
  operationId: string;
  path: string;
};

export type OpenApiIntake = {
  byteSize: number;
  document: { [key: string]: JsonValue };
  operationCount: number;
  operations: OpenApiOperation[];
  refCount: number;
  sha256: string;
  source: string;
};

export class OpenApiIntakeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OpenApiIntakeError';
  }
}

function formatYamlDiagnostic(
  source: string,
  diagnostic: YAMLParseError | YAMLWarning,
  lineCounter: LineCounter,
): string {
  const position = diagnostic.pos?.[0];
  const location =
    position === undefined
      ? ''
      : (() => {
          const { line, col } = lineCounter.linePos(position);
          return `:${line}:${col}`;
        })();
  const code = diagnostic.code ? ` [${diagnostic.code}]` : '';
  return `${source}${location}${code}: ${diagnostic.message.replaceAll(/\s+/g, ' ').trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointerToken(token: string, reference: string): string {
  if (/%[0-9a-f]{2}/iu.test(token)) {
    throw new OpenApiIntakeError(`escaped ref is forbidden: ${reference}`);
  }
  if (/~(?![01])/u.test(token)) {
    throw new OpenApiIntakeError(`malformed JSON Pointer escape in ref: ${reference}`);
  }
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function resolveInternalRef(root: unknown, reference: string): unknown {
  if (!reference.startsWith('#/')) {
    throw new OpenApiIntakeError(
      `only canonical internal refs beginning #/ are allowed: ${reference}`,
    );
  }
  if (reference.includes('\\') || reference.includes('?')) {
    throw new OpenApiIntakeError(`malformed internal ref: ${reference}`);
  }

  let current = root;
  const tokens = reference
    .slice(2)
    .split('/')
    .map((token) => decodePointerToken(token, reference));
  for (const [index, token] of tokens.entries()) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(token) || Number(token) >= current.length) {
        throw new OpenApiIntakeError(
          `unresolved internal ref ${reference} at segment ${index + 1} (${JSON.stringify(token)})`,
        );
      }
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new OpenApiIntakeError(
        `unresolved internal ref ${reference} at segment ${index + 1} (${JSON.stringify(token)})`,
      );
    }
  }
  return current;
}

function validateRefs(root: unknown): number {
  const visitedObjects = new WeakSet<object>();
  const resolvedRefs = new Map<string, unknown>();
  let refCount = 0;

  const visit = (value: unknown, refStack: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      if (visitedObjects.has(value)) return;
      visitedObjects.add(value);
      for (const item of value) visit(item, refStack);
      return;
    }
    if (!isRecord(value)) return;
    if (visitedObjects.has(value)) return;
    visitedObjects.add(value);

    const reference = value.$ref;
    if (reference !== undefined) {
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new OpenApiIntakeError('$ref must be a non-empty string');
      }
      refCount += 1;
      const target = resolvedRefs.has(reference)
        ? resolvedRefs.get(reference)
        : resolveInternalRef(root, reference);
      resolvedRefs.set(reference, target);
      if (!refStack.has(reference)) {
        visit(target, new Set([...refStack, reference]));
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== '$ref') visit(child, refStack);
    }
  };

  visit(root, new Set());
  return refCount;
}

function validateOperations(root: Record<string, unknown>): OpenApiOperation[] {
  if (root.openapi !== '3.0.3') {
    throw new OpenApiIntakeError(
      `expected OpenAPI 3.0.3, received ${JSON.stringify(root.openapi)}`,
    );
  }
  const info = root.info;
  if (!isRecord(info) || info.title !== 'CMS Connect REST API' || info.version !== 'v67.0') {
    throw new OpenApiIntakeError('expected CMS Connect REST API document version v67.0');
  }
  if (!isRecord(root.paths)) throw new OpenApiIntakeError('OpenAPI paths must be an object');

  const operationIds = new Set<string>();
  const identities = new Set<string>();
  const operations: OpenApiOperation[] = [];
  for (const path of Object.keys(root.paths).toSorted()) {
    if (!path.startsWith('/')) throw new OpenApiIntakeError(`invalid OpenAPI path: ${path}`);
    const pathItem = root.paths[path];
    if (!isRecord(pathItem)) throw new OpenApiIntakeError(`path item must be an object: ${path}`);
    for (const method of Object.keys(pathItem).toSorted()) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operation = pathItem[method];
      if (!isRecord(operation))
        throw new OpenApiIntakeError(`operation must be an object: ${method} ${path}`);
      if (typeof operation.operationId !== 'string' || operation.operationId.trim() === '') {
        throw new OpenApiIntakeError(`missing operationId: ${method.toUpperCase()} ${path}`);
      }
      const operationId = operation.operationId.trim();
      const identity = `${method.toUpperCase()} ${path}`;
      if (identities.has(identity))
        throw new OpenApiIntakeError(`duplicate operation identity: ${identity}`);
      if (operationIds.has(operationId))
        throw new OpenApiIntakeError(`duplicate operationId: ${operationId}`);
      identities.add(identity);
      operationIds.add(operationId);
      operations.push({ method: method.toUpperCase(), operationId, path });
    }
  }
  return operations.toSorted(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
}

export async function intakeOpenApi(sourcePath: string): Promise<OpenApiIntake> {
  const bytes = await readFile(sourcePath);
  const text = bytes.toString('utf8');
  if (text.startsWith('\uFEFF'))
    throw new OpenApiIntakeError(`${sourcePath}: UTF-8 BOM is forbidden`);

  const lineCounter = new LineCounter();
  const yamlDocument = parseDocument(text, {
    customTags: [],
    lineCounter,
    uniqueKeys: true,
    version: '1.2',
  });
  const diagnostics = [...yamlDocument.errors, ...yamlDocument.warnings];
  if (diagnostics.length > 0) {
    throw new OpenApiIntakeError(
      diagnostics
        .map((diagnostic) => formatYamlDiagnostic(sourcePath, diagnostic, lineCounter))
        .join('\n'),
    );
  }

  const document: unknown = yamlDocument.toJS({ maxAliasCount: 100 });
  if (!isRecord(document)) throw new OpenApiIntakeError('OpenAPI document root must be an object');
  const operations = validateOperations(document);
  const refCount = validateRefs(document);

  return {
    byteSize: bytes.byteLength,
    document: document as { [key: string]: JsonValue },
    operationCount: operations.length,
    operations,
    refCount,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: sourcePath,
  };
}
