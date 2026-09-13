import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { intakeOpenApi, OpenApiIntakeError } from './intake.js';
import { SELECTED_OPERATION_CONFIG, type SelectedOperationConfig } from './selected.js';

type RecordValue = Record<string, unknown>;
type ParameterLocation = 'path' | 'query';

type ParameterDescriptor = {
  location: ParameterLocation;
  name: string;
  required: boolean;
  type: 'boolean' | 'integer' | 'string' | 'string-array';
};

export type OperationDescriptor = {
  localKey: string;
  method: string;
  operationId: string;
  parameters: ParameterDescriptor[];
  path: string;
  requestBodyMediaTypes: string[];
  requestBodyPresent: boolean;
  responses: Array<{ mediaTypes: string[]; status: string }>;
};

export type GeneratedOpenApiFiles = {
  operations: string;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(parent: RecordValue, key: string, context: string): RecordValue {
  const value = parent[key];
  if (!isRecord(value)) throw new OpenApiIntakeError(`${context}.${key} must be an object`);
  return value;
}

function resolveSchema(document: RecordValue, schema: RecordValue): RecordValue {
  const reference = schema.$ref;
  if (typeof reference !== 'string') return schema;
  const segments = reference.match(/^#\/components\/schemas\/([^/]+)$/u);
  if (!segments)
    throw new OpenApiIntakeError(`unsupported selected schema reference: ${reference}`);
  const components = readRecord(document, 'components', 'OpenAPI document');
  const schemas = readRecord(components, 'schemas', 'OpenAPI document.components');
  return readRecord(schemas, segments[1], 'OpenAPI document.components.schemas');
}

function parameterType(schema: RecordValue): ParameterDescriptor['type'] {
  const schemaType = schema.type;
  if (schemaType === 'boolean' || schemaType === 'integer' || schemaType === 'string') {
    return schemaType;
  }
  if (schemaType === 'array' && isRecord(schema.items) && schema.items.type === 'string') {
    return 'string-array';
  }
  throw new OpenApiIntakeError(`unsupported selected parameter type: ${String(schemaType)}`);
}

function collectParameters(
  document: RecordValue,
  pathItem: RecordValue,
  operation: RecordValue,
): ParameterDescriptor[] {
  const combined = [pathItem.parameters, operation.parameters].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const parameters = new Map<string, ParameterDescriptor>();
  for (const value of combined) {
    if (!isRecord(value)) {
      throw new OpenApiIntakeError('selected operation parameter must be an object');
    }
    const location = value.in;
    const name = value.name;
    const schema = value.schema;
    if (
      (location !== 'path' && location !== 'query') ||
      typeof name !== 'string' ||
      !isRecord(schema)
    ) {
      throw new OpenApiIntakeError('selected operation parameter is incomplete');
    }
    const type = parameterType(resolveSchema(document, schema));
    const identity = `${location}:${name}`;
    if (parameters.has(identity)) {
      throw new OpenApiIntakeError(`duplicate selected operation parameter: ${identity}`);
    }
    parameters.set(identity, {
      location,
      name,
      required: location === 'path' || value.required === true,
      type,
    });
  }
  return [...parameters.values()].toSorted(
    (left, right) =>
      left.location.localeCompare(right.location) || left.name.localeCompare(right.name),
  );
}

function mediaTypes(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).toSorted();
}

function describeResponses(
  operation: RecordValue,
): Array<{ mediaTypes: string[]; status: string }> {
  const responses = readRecord(operation, 'responses', 'selected operation');
  return Object.entries(responses)
    .map(([status, response]) => {
      if (!isRecord(response)) {
        throw new OpenApiIntakeError(`selected operation response ${status} must be an object`);
      }
      return { mediaTypes: mediaTypes(response.content), status };
    })
    .toSorted((left, right) => left.status.localeCompare(right.status));
}

export function buildSelectedOperationDescriptors(
  document: RecordValue,
  selections: readonly SelectedOperationConfig[],
): OperationDescriptor[] {
  const localKeys = new Set<string>();
  const selectedById = new Map<string, SelectedOperationConfig>();
  for (const selection of selections) {
    if (localKeys.has(selection.localKey)) {
      throw new OpenApiIntakeError(`duplicate selected operation local key: ${selection.localKey}`);
    }
    if (selectedById.has(selection.operationId)) {
      throw new OpenApiIntakeError(`duplicate selected operationId: ${selection.operationId}`);
    }
    localKeys.add(selection.localKey);
    selectedById.set(selection.operationId, selection);
  }

  const paths = readRecord(document, 'paths', 'OpenAPI document');
  const byId = new Map<string, OperationDescriptor>();
  for (const [operationPath, pathValue] of Object.entries(paths)) {
    if (!isRecord(pathValue)) continue;
    for (const [method, operationValue] of Object.entries(pathValue)) {
      if (!isRecord(operationValue) || typeof operationValue.operationId !== 'string') continue;
      const selection = selectedById.get(operationValue.operationId);
      if (!selection) continue;
      if (byId.has(operationValue.operationId)) {
        throw new OpenApiIntakeError(
          `selected operation appears more than once: ${operationValue.operationId}`,
        );
      }
      byId.set(operationValue.operationId, {
        localKey: selection.localKey,
        method: method.toUpperCase(),
        operationId: operationValue.operationId,
        parameters: collectParameters(document, pathValue, operationValue),
        path: operationPath,
        requestBodyMediaTypes: isRecord(operationValue.requestBody)
          ? mediaTypes(operationValue.requestBody.content)
          : [],
        requestBodyPresent: isRecord(operationValue.requestBody),
        responses: describeResponses(operationValue),
      });
    }
  }
  for (const { operationId } of selections) {
    if (!byId.has(operationId)) {
      throw new OpenApiIntakeError(`selected operation missing: ${operationId}`);
    }
  }
  return [...byId.values()].toSorted((left, right) => left.localKey.localeCompare(right.localKey));
}

function emitOperations(descriptors: OperationDescriptor[]): string {
  return `// Generated by scripts/generate-openapi.mjs. Do not edit.\n\nexport const SELECTED_OPERATIONS = ${JSON.stringify(descriptors, null, 2)} as const;\n\nexport type SelectedOperation = (typeof SELECTED_OPERATIONS)[number];\nexport type SelectedOperationId = SelectedOperation['operationId'];\n`;
}

export async function generateSelectedOpenApi(sourcePath: string): Promise<GeneratedOpenApiFiles> {
  const intake = await intakeOpenApi(sourcePath);
  return {
    operations: emitOperations(
      buildSelectedOperationDescriptors(intake.document as RecordValue, SELECTED_OPERATION_CONFIG),
    ),
  };
}

export async function writeSelectedOpenApi(
  sourcePath: string,
  outputDirectory: string,
): Promise<GeneratedOpenApiFiles> {
  const generated = await generateSelectedOpenApi(sourcePath);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'operations.ts'), generated.operations, 'utf8');
  return generated;
}

export async function checkSelectedOpenApi(
  sourcePath: string,
  outputDirectory: string,
): Promise<void> {
  const generated = await generateSelectedOpenApi(sourcePath);
  const actual = await readFile(path.join(outputDirectory, 'operations.ts'), 'utf8');
  if (actual !== generated.operations) {
    throw new OpenApiIntakeError('generated output is stale: operations.ts');
  }
}
