import {
  assertDiagnostics,
  assertExactKeys,
  assertIdentifier,
  assertNonemptyString,
  assertOpaqueCmsReference,
  assertRelativePosixPath,
  assertSha256,
  type CmsDiagnostics,
  type CmsProvenance,
  type OpaqueCmsReference,
} from './shared.js';

export const WORKSPACE_EXPORT_SET_CONTRACT = 'sf-cms-workspace-export-set' as const;
export const WORKSPACE_EXPORT_MANIFEST_CONTRACT = 'sf-cms-workspace-export' as const;
export const EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT =
  'sf-cms-external-reference-correlations@1' as const;

export class UnsupportedWorkspacePackageVersionError extends TypeError {
  public readonly code = 'UNSUPPORTED_PACKAGE_VERSION' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWorkspacePackageVersionError';
  }
}

export type WorkspaceExportManifestItem = {
  path: string;
  sha256: string;
  kind: string;
  referenceId?: string;
};

export type WorkspaceExportPreferencePageReport = {
  path: string;
  rawItemPath: string;
  workspaceId: string;
  contentType: 'sfdc_cms__preferencePage';
  variantId: string;
  apiName: string;
  format: 'sf-cms-preference-page-read-report@1';
};

export type WorkspaceExportBrandReport = {
  path: string;
  rawItemPath: string;
  workspaceId: string;
  contentType: 'sfdc_cms__brand';
  variantId: string;
  apiName: string;
  format: 'sf-cms-brand-read-report@1';
};

export type WorkspaceExportFormReport = {
  path: string;
  rawItemPath: string;
  workspaceId: string;
  contentType: 'sfdc_cms__form';
  variantId: string;
  apiName: string;
  format: 'sf-cms-form-read-report@1';
};

export type WorkspaceExportFormHandlerReport = {
  path: string;
  rawItemPath: string;
  workspaceId: string;
  contentType: 'sfdc_cms__formHandler';
  variantId: string;
  apiName: string;
  format: 'sf-cms-form-handler-read-report@1';
};

export type WorkspaceExportConsentBannerReport = {
  path: string;
  rawItemPath: string;
  workspaceId: string;
  contentType: 'sfdc_cms__consentBanner';
  variantId: string;
  apiName: string;
  format: 'sf-cms-consent-banner-read-report@1';
};

export type WorkspaceExportMedia = {
  variantId: string;
  contentKey: string;
  path: string;
  sha256: string;
  md5: string;
  bytes: number;
  mimeType: string;
  fileName: string;
  sourceStatus: string;
  sourceModifiedAt: string;
  sourceVersion: string;
  sourceUrl: string;
  transport: 'experimental-undocumented-authoring-media';
};

export type LandingPageTemplatePair = {
  page: { apiName: string; contentKey: string; variantId: string };
  template: {
    requestedTitle: string;
    apiName: string;
    contentKey: string;
    variantId: string;
  };
  compatibility: {
    basis: 'declared-source-pair';
    relationship: 'opaque-structural-match';
  };
};

export type WorkspaceExportManifest = {
  schemaVersion: 1 | 2;
  mode: 'experimental-best-effort';
  workspaceId: string;
  search: {
    contentSpaceOrFolderIds: [string];
    languages: ['All'];
    pageSize: 250;
    queryTerm: '*';
  };
  expectedCount: number;
  foundCount: number;
  exportedCount: number;
  pagesRequested: number;
  entries: Array<{ file: string; variantId: string }>;
  rejectedVariantIds: string[];
  failedVariantIds: string[];
  warnings: Array<{
    code:
      | 'COUNT_MISMATCH'
      | 'DETAIL_FAILED'
      | 'DUPLICATE_VARIANTS'
      | 'OWNERSHIP_MISMATCH'
      | 'PREMATURE_EMPTY_PAGE'
      | 'MEDIA_EXPORT_FAILED'
      | 'REFERENCE_UNRESOLVED'
      | 'REFERENCE_UNSUPPORTED'
      | 'UNSUPPORTED_WILDCARD';
    message: string;
    variantIds?: string[];
  }>;
  contract: typeof WORKSPACE_EXPORT_MANIFEST_CONTRACT;
  contractVersion: '1.0.0' | '2.0.0';
  media?: WorkspaceExportMedia[];
  provenance: {
    producer: 'sf-plugin-cms';
    sourceOrgId: string;
    sourceWorkspaceId: string;
    pluginVersion: string;
    generatedAt: string;
  };
  completeness: 'complete' | 'partial';
  dependencies: string[];
  landingPageTemplatePairs?: LandingPageTemplatePair[];
  preferencePageReports?: WorkspaceExportPreferencePageReport[];
  brandReports?: WorkspaceExportBrandReport[];
  formReports?: WorkspaceExportFormReport[];
  formHandlerReports?: WorkspaceExportFormHandlerReport[];
  consentBannerReports?: WorkspaceExportConsentBannerReport[];
  externalReferences: OpaqueCmsReference[];
  items: WorkspaceExportManifestItem[];
};

export type ExternalReferenceCorrelation = {
  sourceWorkspaceId: string;
  sourceReference: string;
  referenceKind: string;
  referenceId: string;
  packageManifestSha256: string;
};

export type WorkspaceExportSetEntry = {
  source: {
    kind: 'cms.workspace';
    sourceId: string;
    name: string;
    workspaceType: 'Marketing' | 'Content';
  };
  status: 'success' | 'partial' | 'failed';
  artifact: {
    path: string;
    manifestPath: string;
    manifestContract: typeof WORKSPACE_EXPORT_MANIFEST_CONTRACT;
    manifestContractVersion: '1.0.0';
    manifestSha256: string;
  } | null;
  diagnostics: CmsDiagnostics;
};

export type WorkspaceExportSetResult = {
  workspaceType: 'Marketing' | 'Content';
  outputDirectory: string;
  selection: {
    mode: 'all';
    discoveredCount: number;
    selectedCount: number;
  };
  summary: {
    succeededCount: number;
    partialCount: number;
    failedCount: number;
  };
  externalReferenceCorrelations: ExternalReferenceCorrelation[];
  workspaces: WorkspaceExportSetEntry[];
};

export function assertWorkspaceExportManifest(
  value: unknown,
): asserts value is WorkspaceExportManifest {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'mode',
      'workspaceId',
      'search',
      'expectedCount',
      'foundCount',
      'exportedCount',
      'pagesRequested',
      'entries',
      'rejectedVariantIds',
      'failedVariantIds',
      'warnings',
      'contract',
      'contractVersion',
      ...(typeof value === 'object' && value !== null && 'media' in value ? ['media'] : []),
      'provenance',
      'completeness',
      'dependencies',
      ...(typeof value === 'object' && value !== null && 'landingPageTemplatePairs' in value
        ? ['landingPageTemplatePairs']
        : []),
      ...(typeof value === 'object' && value !== null && 'preferencePageReports' in value
        ? ['preferencePageReports']
        : []),
      ...(typeof value === 'object' && value !== null && 'brandReports' in value
        ? ['brandReports']
        : []),
      ...(typeof value === 'object' && value !== null && 'formReports' in value
        ? ['formReports']
        : []),
      ...(typeof value === 'object' && value !== null && 'formHandlerReports' in value
        ? ['formHandlerReports']
        : []),
      ...(typeof value === 'object' && value !== null && 'consentBannerReports' in value
        ? ['consentBannerReports']
        : []),
      'externalReferences',
      'items',
    ],
    'manifest',
  );
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new UnsupportedWorkspacePackageVersionError('manifest schemaVersion is unsupported');
  }
  if (value.mode !== 'experimental-best-effort') {
    throw new TypeError('manifest mode is unsupported');
  }
  assertIdentifier(value.workspaceId, 'manifest.workspaceId');
  assertExactKeys(
    value.search,
    ['contentSpaceOrFolderIds', 'languages', 'pageSize', 'queryTerm'],
    'manifest.search',
  );
  if (
    !Array.isArray(value.search.contentSpaceOrFolderIds) ||
    value.search.contentSpaceOrFolderIds.length !== 1 ||
    value.search.contentSpaceOrFolderIds[0] !== value.workspaceId ||
    !Array.isArray(value.search.languages) ||
    value.search.languages.length !== 1 ||
    value.search.languages[0] !== 'All' ||
    value.search.pageSize !== 250 ||
    value.search.queryTerm !== '*'
  ) {
    throw new TypeError('manifest.search is invalid');
  }
  for (const key of ['expectedCount', 'foundCount', 'exportedCount', 'pagesRequested'] as const) {
    assertCount(value[key], `manifest.${key}`);
  }
  assertLegacyManifestArrays(value);
  if (value.contract !== WORKSPACE_EXPORT_MANIFEST_CONTRACT) {
    throw new TypeError('manifest contract is unsupported');
  }
  if (
    (value.schemaVersion === 1 && value.contractVersion !== '1.0.0') ||
    (value.schemaVersion === 2 && value.contractVersion !== '2.0.0')
  ) {
    throw new UnsupportedWorkspacePackageVersionError('manifest contract version is unsupported');
  }
  assertManifestMedia(value);
  assertExactKeys(
    value.provenance,
    ['producer', 'sourceOrgId', 'sourceWorkspaceId', 'pluginVersion', 'generatedAt'],
    'manifest.provenance',
  );
  if (value.provenance.producer !== 'sf-plugin-cms')
    throw new TypeError('manifest producer is invalid');
  assertIdentifier(value.provenance.sourceOrgId, 'manifest.provenance.sourceOrgId');
  assertIdentifier(value.provenance.sourceWorkspaceId, 'manifest.provenance.sourceWorkspaceId');
  if (value.provenance.sourceWorkspaceId !== value.workspaceId) {
    throw new TypeError('manifest provenance sourceWorkspaceId must match workspaceId');
  }
  assertNonemptyString(value.provenance.pluginVersion, 'manifest.provenance.pluginVersion');
  assertNonemptyString(value.provenance.generatedAt, 'manifest.provenance.generatedAt');
  if (value.completeness !== 'complete' && value.completeness !== 'partial') {
    throw new TypeError('manifest.completeness is invalid');
  }
  if (
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.externalReferences) ||
    !Array.isArray(value.items)
  ) {
    throw new TypeError('manifest arrays are required');
  }
  if (value.dependencies.length > 0) {
    throw new TypeError(
      'manifest.dependencies must be empty while dependency discovery is unavailable',
    );
  }
  assertLandingPageTemplatePairs(value);
  assertPreferencePageReports(value);
  assertBrandReports(value);
  assertFormReports(value);
  assertFormHandlerReports(value);
  assertConsentBannerReports(value);
  let previousReference = '';
  const referenceIds = new Set<string>();
  for (const [index, reference] of value.externalReferences.entries()) {
    assertOpaqueCmsReference(reference, `manifest.externalReferences[${index}]`);
    if (reference.source.workspaceId !== value.workspaceId) {
      throw new TypeError(`manifest.externalReferences[${index}] workspaceId must match manifest`);
    }
    const sortKey = [reference.kind, reference.referenceId, reference.portableKey.value].join(
      '\u0000',
    );
    if (sortKey.localeCompare(previousReference) < 0) {
      throw new TypeError('manifest.externalReferences must be sorted');
    }
    previousReference = sortKey;
    if (referenceIds.has(reference.referenceId)) {
      throw new TypeError(`duplicate manifest reference ID: ${reference.referenceId}`);
    }
    referenceIds.add(reference.referenceId);
  }
  const paths = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TypeError(`manifest.items[${index}] must be an object`);
    }
    const keys = Object.keys(item).toSorted();
    if (
      JSON.stringify(keys) !==
      JSON.stringify(
        ['kind', 'path', 'referenceId', 'sha256'].filter((key) => key in item).toSorted(),
      )
    ) {
      throw new TypeError(`manifest.items[${index}] has invalid keys`);
    }
    assertRelativePosixPath(item.path, `manifest.items[${index}].path`);
    if (item.path === 'manifest.json')
      throw new TypeError('manifest.json must not be listed as an item');
    if (paths.has(item.path)) throw new TypeError(`duplicate manifest item path: ${item.path}`);
    paths.add(item.path);
    assertSha256(item.sha256, `manifest.items[${index}].sha256`);
    assertIdentifier(item.kind, `manifest.items[${index}].kind`);
    if (item.referenceId !== undefined && !referenceIds.has(item.referenceId)) {
      throw new TypeError(`manifest item has no reference descriptor: ${item.referenceId}`);
    }
  }
  if (value.schemaVersion === 2) assertManifestMediaIntegrity(value as WorkspaceExportManifest);
  assertPreferencePageReportIntegrity(value as WorkspaceExportManifest);
  assertBrandReportIntegrity(value as WorkspaceExportManifest);
  assertFormReportIntegrity(value as WorkspaceExportManifest);
  assertFormHandlerReportIntegrity(value as WorkspaceExportManifest);
  assertConsentBannerReportIntegrity(value as WorkspaceExportManifest);
  if (value.completeness === 'complete' && hasAuthoritativeIncompleteness(value)) {
    throw new TypeError('manifest.completeness contradicts authoritative incompleteness evidence');
  }
}

function assertLandingPageTemplatePairs(value: Record<string, unknown>): void {
  if (!('landingPageTemplatePairs' in value)) return;
  if (
    !Array.isArray(value.landingPageTemplatePairs) ||
    value.landingPageTemplatePairs.length === 0
  ) {
    throw new TypeError('manifest.landingPageTemplatePairs must be a nonempty array');
  }
  const entries = new Set(
    (value.entries as WorkspaceExportManifest['entries']).map(({ variantId }) => variantId),
  );
  let previous = '';
  const pageVariantIds = new Set<string>();
  for (const [index, pair] of value.landingPageTemplatePairs.entries()) {
    const label = `manifest.landingPageTemplatePairs[${index}]`;
    assertExactKeys(pair, ['page', 'template', 'compatibility'], label);
    assertExactKeys(pair.page, ['apiName', 'contentKey', 'variantId'], `${label}.page`);
    assertExactKeys(
      pair.template,
      ['requestedTitle', 'apiName', 'contentKey', 'variantId'],
      `${label}.template`,
    );
    assertExactKeys(pair.compatibility, ['basis', 'relationship'], `${label}.compatibility`);
    for (const [field, fieldValue] of Object.entries(pair.page)) {
      assertNonemptyString(fieldValue, `${label}.page.${field}`);
    }
    for (const [field, fieldValue] of Object.entries(pair.template)) {
      assertNonemptyString(fieldValue, `${label}.template.${field}`);
    }
    if (
      pair.compatibility.basis !== 'declared-source-pair' ||
      pair.compatibility.relationship !== 'opaque-structural-match'
    ) {
      throw new TypeError(`${label}.compatibility is unsupported`);
    }
    const pageVariantId = pair.page.variantId as string;
    const templateVariantId = pair.template.variantId as string;
    if (!entries.has(pageVariantId) || !entries.has(templateVariantId)) {
      throw new TypeError(`${label} must bind exported item variants`);
    }
    if (pageVariantId === templateVariantId) {
      throw new TypeError(`${label} must bind distinct page and template variants`);
    }
    if (pageVariantIds.has(pageVariantId)) {
      throw new TypeError('manifest.landingPageTemplatePairs contains a duplicate page');
    }
    pageVariantIds.add(pageVariantId);
    const sortKey = [
      pair.page.apiName as string,
      pair.template.requestedTitle as string,
      pair.template.apiName as string,
    ].join('\u0000');
    if (sortKey.localeCompare(previous) < 0) {
      throw new TypeError('manifest.landingPageTemplatePairs must be sorted');
    }
    previous = sortKey;
  }
}

function assertPreferencePageReports(value: Record<string, unknown>): void {
  if (!('preferencePageReports' in value)) return;
  if (!Array.isArray(value.preferencePageReports) || value.preferencePageReports.length === 0) {
    throw new TypeError('manifest.preferencePageReports must be a nonempty array');
  }
  let previous = '';
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const [index, report] of value.preferencePageReports.entries()) {
    const label = `manifest.preferencePageReports[${index}]`;
    assertExactKeys(
      report,
      ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format'],
      label,
    );
    assertRelativePosixPath(report.path, `${label}.path`);
    if (
      report.path !== `reports/preference-pages/${String(report.variantId)}.json` ||
      !report.path.startsWith('reports/preference-pages/') ||
      !report.path.endsWith('.json')
    ) {
      throw new TypeError(`${label}.path must bind its variant under reports/preference-pages/`);
    }
    assertRelativePosixPath(report.rawItemPath, `${label}.rawItemPath`);
    if (!report.rawItemPath.startsWith('items/') || !report.rawItemPath.endsWith('.json')) {
      throw new TypeError(`${label}.rawItemPath must use items/`);
    }
    assertIdentifier(report.workspaceId, `${label}.workspaceId`);
    if (report.workspaceId !== value.workspaceId) {
      throw new TypeError(`${label}.workspaceId must match manifest`);
    }
    if (report.contentType !== 'sfdc_cms__preferencePage') {
      throw new TypeError(`${label}.contentType is unsupported`);
    }
    assertIdentifier(report.variantId, `${label}.variantId`);
    assertNonemptyString(report.apiName, `${label}.apiName`);
    if (report.format !== 'sf-cms-preference-page-read-report@1') {
      throw new TypeError(`${label}.format is unsupported`);
    }
    if (paths.has(report.path) || variants.has(report.variantId)) {
      throw new TypeError('manifest preference-page report paths and variants must be unique');
    }
    paths.add(report.path);
    variants.add(report.variantId);
    const sortKey = [report.variantId, report.apiName, report.path].join('\u0000');
    if (sortKey.localeCompare(previous) < 0) {
      throw new TypeError('manifest.preferencePageReports must be sorted');
    }
    previous = sortKey;
  }
}

function assertPreferencePageReportIntegrity(manifest: WorkspaceExportManifest): void {
  const descriptors = manifest.preferencePageReports ?? [];
  const reportItems = manifest.items.filter(
    ({ kind }) => kind === 'cms.preference-page.read-report',
  );
  if (descriptors.length !== reportItems.length) {
    throw new TypeError('manifest preference-page descriptors and report items must be bijective');
  }
  const descriptorPaths = new Set(descriptors.map(({ path }) => path));
  if (reportItems.some(({ path }) => !descriptorPaths.has(path))) {
    throw new TypeError('manifest contains an orphan preference-page report item');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  const rawItems = new Map(
    manifest.items.filter(({ kind }) => kind === 'cms.content').map((item) => [item.path, item]),
  );
  const reportItemPaths = new Set(reportItems.map(({ path }) => path));
  for (const descriptor of descriptors) {
    if (!reportItemPaths.has(descriptor.path)) {
      throw new TypeError('manifest preference-page report descriptor has no report item');
    }
    if (
      entries.get(descriptor.rawItemPath) !== descriptor.variantId ||
      !rawItems.has(descriptor.rawItemPath)
    ) {
      throw new TypeError('manifest preference-page report must bind an existing raw CMS item');
    }
  }
}

function assertBrandReports(value: Record<string, unknown>): void {
  if (!('brandReports' in value)) return;
  if (!Array.isArray(value.brandReports) || value.brandReports.length === 0) {
    throw new TypeError('manifest.brandReports must be a nonempty array');
  }
  let previous = '';
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const [index, report] of value.brandReports.entries()) {
    const label = `manifest.brandReports[${index}]`;
    assertExactKeys(
      report,
      ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format'],
      label,
    );
    assertRelativePosixPath(report.path, `${label}.path`);
    if (report.path !== `reports/brands/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.path must bind its variant under reports/brands/`);
    }
    assertRelativePosixPath(report.rawItemPath, `${label}.rawItemPath`);
    if (!report.rawItemPath.startsWith('items/') || !report.rawItemPath.endsWith('.json')) {
      throw new TypeError(`${label}.rawItemPath must use items/`);
    }
    assertIdentifier(report.workspaceId, `${label}.workspaceId`);
    if (report.workspaceId !== value.workspaceId)
      throw new TypeError(`${label}.workspaceId must match manifest`);
    if (report.contentType !== 'sfdc_cms__brand')
      throw new TypeError(`${label}.contentType is unsupported`);
    assertIdentifier(report.variantId, `${label}.variantId`);
    assertNonemptyString(report.apiName, `${label}.apiName`);
    if (report.format !== 'sf-cms-brand-read-report@1')
      throw new TypeError(`${label}.format is unsupported`);
    if (paths.has(report.path) || variants.has(report.variantId)) {
      throw new TypeError('manifest Brand report paths and variants must be unique');
    }
    paths.add(report.path);
    variants.add(report.variantId);
    const sortKey = [report.variantId, report.apiName, report.path].join('\u0000');
    if (sortKey.localeCompare(previous) < 0)
      throw new TypeError('manifest.brandReports must be sorted');
    previous = sortKey;
  }
}

function assertBrandReportIntegrity(manifest: WorkspaceExportManifest): void {
  const descriptors = manifest.brandReports ?? [];
  const reportItems = manifest.items.filter(({ kind }) => kind === 'cms.brand.read-report');
  if (descriptors.length !== reportItems.length) {
    throw new TypeError('manifest Brand descriptors and report items must be bijective');
  }
  const descriptorPaths = new Set(descriptors.map(({ path }) => path));
  if (reportItems.some(({ path }) => !descriptorPaths.has(path))) {
    throw new TypeError('manifest contains an orphan Brand report item');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  const rawItems = new Set(
    manifest.items.filter(({ kind }) => kind === 'cms.content').map(({ path }) => path),
  );
  const reportPaths = new Set(reportItems.map(({ path }) => path));
  for (const descriptor of descriptors) {
    if (!reportPaths.has(descriptor.path))
      throw new TypeError('manifest Brand report descriptor has no report item');
    if (
      entries.get(descriptor.rawItemPath) !== descriptor.variantId ||
      !rawItems.has(descriptor.rawItemPath)
    ) {
      throw new TypeError('manifest Brand report must bind an existing raw CMS item');
    }
  }
}

function assertFormReports(value: Record<string, unknown>): void {
  if (!('formReports' in value)) return;
  if (!Array.isArray(value.formReports) || value.formReports.length === 0) {
    throw new TypeError('manifest.formReports must be a nonempty array');
  }
  let previous = '';
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const [index, report] of value.formReports.entries()) {
    const label = `manifest.formReports[${index}]`;
    assertExactKeys(
      report,
      ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format'],
      label,
    );
    assertRelativePosixPath(report.path, `${label}.path`);
    if (report.path !== `reports/forms/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.path must bind its variant under reports/forms/`);
    }
    assertRelativePosixPath(report.rawItemPath, `${label}.rawItemPath`);
    if (report.rawItemPath !== `items/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.rawItemPath must bind its variant under items/`);
    }
    assertIdentifier(report.workspaceId, `${label}.workspaceId`);
    if (report.workspaceId !== value.workspaceId)
      throw new TypeError(`${label}.workspaceId must match manifest`);
    if (report.contentType !== 'sfdc_cms__form')
      throw new TypeError(`${label}.contentType is unsupported`);
    assertIdentifier(report.variantId, `${label}.variantId`);
    assertNonemptyString(report.apiName, `${label}.apiName`);
    if (report.format !== 'sf-cms-form-read-report@1')
      throw new TypeError(`${label}.format is unsupported`);
    if (paths.has(report.path) || variants.has(report.variantId)) {
      throw new TypeError('manifest Form report paths and variants must be unique');
    }
    paths.add(report.path);
    variants.add(report.variantId);
    const sortKey = [report.variantId, report.apiName, report.path].join('\u0000');
    if (sortKey.localeCompare(previous) < 0)
      throw new TypeError('manifest.formReports must be sorted');
    previous = sortKey;
  }
}

function assertFormReportIntegrity(manifest: WorkspaceExportManifest): void {
  const descriptors = manifest.formReports ?? [];
  const reportItems = manifest.items.filter(({ kind }) => kind === 'cms.form.read-report');
  if (descriptors.length !== reportItems.length) {
    throw new TypeError('manifest Form descriptors and report items must be bijective');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  const rawItems = new Set(
    manifest.items.filter(({ kind }) => kind === 'cms.content').map(({ path }) => path),
  );
  const reportPaths = new Set(reportItems.map(({ path }) => path));
  for (const descriptor of descriptors) {
    if (!reportPaths.has(descriptor.path))
      throw new TypeError('manifest Form report descriptor has no report item');
    if (
      entries.get(descriptor.rawItemPath) !== descriptor.variantId ||
      !rawItems.has(descriptor.rawItemPath)
    ) {
      throw new TypeError('manifest Form report must bind an existing raw CMS item');
    }
  }
}

function assertFormHandlerReports(value: Record<string, unknown>): void {
  if (!('formHandlerReports' in value)) return;
  if (!Array.isArray(value.formHandlerReports) || value.formHandlerReports.length === 0) {
    throw new TypeError('manifest.formHandlerReports must be a nonempty array');
  }
  let previous = '';
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const [index, report] of value.formHandlerReports.entries()) {
    const label = `manifest.formHandlerReports[${index}]`;
    assertExactKeys(
      report,
      ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format'],
      label,
    );
    assertRelativePosixPath(report.path, `${label}.path`);
    if (report.path !== `reports/form-handlers/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.path must bind its variant under reports/form-handlers/`);
    }
    assertRelativePosixPath(report.rawItemPath, `${label}.rawItemPath`);
    if (report.rawItemPath !== `items/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.rawItemPath must bind its variant under items/`);
    }
    assertIdentifier(report.workspaceId, `${label}.workspaceId`);
    if (report.workspaceId !== value.workspaceId)
      throw new TypeError(`${label}.workspaceId must match manifest`);
    if (report.contentType !== 'sfdc_cms__formHandler')
      throw new TypeError(`${label}.contentType is unsupported`);
    assertIdentifier(report.variantId, `${label}.variantId`);
    assertNonemptyString(report.apiName, `${label}.apiName`);
    if (report.format !== 'sf-cms-form-handler-read-report@1')
      throw new TypeError(`${label}.format is unsupported`);
    if (paths.has(report.path) || variants.has(report.variantId)) {
      throw new TypeError('manifest Form Handler report paths and variants must be unique');
    }
    paths.add(report.path);
    variants.add(report.variantId);
    const sortKey = [report.variantId, report.apiName, report.path].join('\u0000');
    if (sortKey.localeCompare(previous) < 0)
      throw new TypeError('manifest.formHandlerReports must be sorted');
    previous = sortKey;
  }
}

function assertFormHandlerReportIntegrity(manifest: WorkspaceExportManifest): void {
  const descriptors = manifest.formHandlerReports ?? [];
  const reportItems = manifest.items.filter(({ kind }) => kind === 'cms.form-handler.read-report');
  if (descriptors.length !== reportItems.length) {
    throw new TypeError('manifest Form Handler descriptors and report items must be bijective');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  const rawItems = new Set(
    manifest.items.filter(({ kind }) => kind === 'cms.content').map(({ path }) => path),
  );
  const reportPaths = new Set(reportItems.map(({ path }) => path));
  for (const descriptor of descriptors) {
    if (!reportPaths.has(descriptor.path))
      throw new TypeError('manifest Form Handler report descriptor has no report item');
    if (
      entries.get(descriptor.rawItemPath) !== descriptor.variantId ||
      !rawItems.has(descriptor.rawItemPath)
    ) {
      throw new TypeError('manifest Form Handler report must bind an existing raw CMS item');
    }
  }
}

function assertConsentBannerReports(value: Record<string, unknown>): void {
  if (!('consentBannerReports' in value)) return;
  if (!Array.isArray(value.consentBannerReports) || value.consentBannerReports.length === 0) {
    throw new TypeError('manifest.consentBannerReports must be a nonempty array');
  }
  let previous = '';
  const paths = new Set<string>();
  const variants = new Set<string>();
  for (const [index, report] of value.consentBannerReports.entries()) {
    const label = `manifest.consentBannerReports[${index}]`;
    assertExactKeys(
      report,
      ['path', 'rawItemPath', 'workspaceId', 'contentType', 'variantId', 'apiName', 'format'],
      label,
    );
    assertRelativePosixPath(report.path, `${label}.path`);
    if (report.path !== `reports/consent-banners/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.path must bind its variant under reports/consent-banners/`);
    }
    assertRelativePosixPath(report.rawItemPath, `${label}.rawItemPath`);
    if (report.rawItemPath !== `items/${String(report.variantId)}.json`) {
      throw new TypeError(`${label}.rawItemPath must bind its variant under items/`);
    }
    assertIdentifier(report.workspaceId, `${label}.workspaceId`);
    if (report.workspaceId !== value.workspaceId)
      throw new TypeError(`${label}.workspaceId must match manifest`);
    if (report.contentType !== 'sfdc_cms__consentBanner')
      throw new TypeError(`${label}.contentType is unsupported`);
    assertIdentifier(report.variantId, `${label}.variantId`);
    assertNonemptyString(report.apiName, `${label}.apiName`);
    if (report.format !== 'sf-cms-consent-banner-read-report@1')
      throw new TypeError(`${label}.format is unsupported`);
    if (paths.has(report.path) || variants.has(report.variantId)) {
      throw new TypeError('manifest Consent Banner report paths and variants must be unique');
    }
    paths.add(report.path);
    variants.add(report.variantId);
    const sortKey = [report.variantId, report.apiName, report.path].join('\u0000');
    if (sortKey.localeCompare(previous) < 0)
      throw new TypeError('manifest.consentBannerReports must be sorted');
    previous = sortKey;
  }
}

function assertConsentBannerReportIntegrity(manifest: WorkspaceExportManifest): void {
  const descriptors = manifest.consentBannerReports ?? [];
  const reportItems = manifest.items.filter(
    ({ kind }) => kind === 'cms.consent-banner.read-report',
  );
  if (descriptors.length !== reportItems.length) {
    throw new TypeError('manifest Consent Banner descriptors and report items must be bijective');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  const rawItems = new Set(
    manifest.items.filter(({ kind }) => kind === 'cms.content').map(({ path }) => path),
  );
  const reportPaths = new Set(reportItems.map(({ path }) => path));
  for (const descriptor of descriptors) {
    if (!reportPaths.has(descriptor.path))
      throw new TypeError('manifest Consent Banner report descriptor has no report item');
    if (
      entries.get(descriptor.rawItemPath) !== descriptor.variantId ||
      !rawItems.has(descriptor.rawItemPath)
    ) {
      throw new TypeError('manifest Consent Banner report must bind an existing raw CMS item');
    }
  }
}

function normalizedManifestPath(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function assertManifestMediaIntegrity(manifest: WorkspaceExportManifest): void {
  const entries = new Map<string, number>();
  for (const entry of manifest.entries) {
    entries.set(entry.variantId, (entries.get(entry.variantId) ?? 0) + 1);
  }
  const descriptors = new Map<string, WorkspaceExportMedia>();
  for (const descriptor of manifest.media ?? []) {
    if (entries.get(descriptor.variantId) !== 1) {
      throw new TypeError('manifest media variantId must occur exactly once in entries');
    }
    descriptors.set(normalizedManifestPath(descriptor.path), descriptor);
  }
  const mediaItems = new Map<string, WorkspaceExportManifestItem>();
  const normalizedItemPaths = new Set<string>();
  for (const item of manifest.items) {
    const normalized = normalizedManifestPath(item.path);
    if (normalizedItemPaths.has(normalized)) {
      throw new TypeError(`duplicate normalized manifest item path: ${normalized}`);
    }
    normalizedItemPaths.add(normalized);
    if (item.kind === 'cms.media') mediaItems.set(normalized, item);
  }
  if (descriptors.size !== (manifest.media ?? []).length || mediaItems.size !== descriptors.size) {
    throw new TypeError('manifest media descriptors and cms.media items must be bijective');
  }
  for (const [mediaPath, descriptor] of descriptors) {
    const item = mediaItems.get(mediaPath);
    if (item === undefined || item.sha256 !== descriptor.sha256) {
      throw new TypeError('manifest media descriptor and item integrity must match exactly');
    }
  }
}

function assertManifestMedia(value: Record<string, unknown>): void {
  if (value.schemaVersion === 1) {
    if ('media' in value) throw new TypeError('manifest v1 must not contain media descriptors');
    return;
  }
  if (!Array.isArray(value.media))
    throw new TypeError('manifest v2 media descriptors are required');
  const paths = new Set<string>();
  const variantIds = new Set<string>();
  for (const [index, media] of value.media.entries()) {
    const label = `manifest.media[${index}]`;
    assertExactKeys(
      media,
      [
        'variantId',
        'contentKey',
        'path',
        'sha256',
        'md5',
        'bytes',
        'mimeType',
        'fileName',
        'sourceStatus',
        'sourceModifiedAt',
        'sourceVersion',
        'sourceUrl',
        'transport',
      ],
      label,
    );
    assertIdentifier(media.variantId, `${label}.variantId`);
    assertIdentifier(media.contentKey, `${label}.contentKey`);
    assertRelativePosixPath(media.path, `${label}.path`);
    if (!media.path.startsWith('media/')) throw new TypeError(`${label}.path must use media/`);
    if (paths.has(media.path) || variantIds.has(media.variantId)) {
      throw new TypeError('manifest media paths and variant IDs must be unique');
    }
    paths.add(media.path);
    variantIds.add(media.variantId);
    assertSha256(media.sha256, `${label}.sha256`);
    if (typeof media.md5 !== 'string' || !/^[a-f\d]{32}$/u.test(media.md5)) {
      throw new TypeError(`${label}.md5 must be a lowercase MD5`);
    }
    assertCount(media.bytes, `${label}.bytes`);
    for (const key of [
      'mimeType',
      'fileName',
      'sourceStatus',
      'sourceModifiedAt',
      'sourceVersion',
      'sourceUrl',
    ] as const) {
      assertNonemptyString(media[key], `${label}.${key}`);
    }
    if (media.transport !== 'experimental-undocumented-authoring-media') {
      throw new TypeError(`${label}.transport is unsupported`);
    }
  }
}

function hasAuthoritativeIncompleteness(manifest: Record<string, unknown>): boolean {
  const warnings = manifest.warnings as WorkspaceExportManifest['warnings'];
  const externalReferences =
    manifest.externalReferences as WorkspaceExportManifest['externalReferences'];
  return (
    (manifest.rejectedVariantIds as unknown[]).length > 0 ||
    (manifest.failedVariantIds as unknown[]).length > 0 ||
    manifest.expectedCount !== manifest.foundCount ||
    manifest.foundCount !== manifest.exportedCount ||
    manifest.exportedCount !== (manifest.entries as unknown[]).length ||
    manifest.exportedCount !==
      (manifest.items as WorkspaceExportManifestItem[]).filter(({ kind }) => kind === 'cms.content')
        .length ||
    warnings.some(({ code }) => code !== 'UNSUPPORTED_WILDCARD') ||
    ((manifest.preferencePageReports as WorkspaceExportPreferencePageReport[] | undefined) !==
      undefined &&
      warnings.some(({ code }) => code === 'REFERENCE_UNRESOLVED')) ||
    externalReferences.some(
      ({ resolution }) => resolution === 'unresolved' || resolution === 'unsupported',
    )
  );
}

function assertLegacyManifestArrays(value: Record<string, unknown>): void {
  if (
    !Array.isArray(value.entries) ||
    !Array.isArray(value.rejectedVariantIds) ||
    !Array.isArray(value.failedVariantIds) ||
    !Array.isArray(value.warnings)
  ) {
    throw new TypeError('manifest legacy arrays are required');
  }
  const entryFiles = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const label = `manifest.entries[${index}]`;
    assertExactKeys(entry, ['file', 'variantId'], label);
    assertRelativePosixPath(entry.file, `${label}.file`);
    assertIdentifier(entry.variantId, `${label}.variantId`);
    if (entryFiles.has(entry.file))
      throw new TypeError(`duplicate manifest entry file: ${entry.file}`);
    entryFiles.add(entry.file);
  }
  for (const key of ['rejectedVariantIds', 'failedVariantIds'] as const) {
    const identifiers = value[key] as unknown[];
    for (const [index, identifier] of identifiers.entries()) {
      assertIdentifier(identifier, `manifest.${key}[${index}]`);
    }
  }
  for (const [index, warning] of value.warnings.entries()) {
    const label = `manifest.warnings[${index}]`;
    if (typeof warning !== 'object' || warning === null || Array.isArray(warning)) {
      throw new TypeError(`${label} must be an object`);
    }
    const keys = Object.keys(warning).toSorted();
    const expected = [
      'code',
      'message',
      ...(warning.variantIds === undefined ? [] : ['variantIds']),
    ].toSorted();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new TypeError(`${label} has invalid keys`);
    }
    assertIdentifier(warning.code, `${label}.code`);
    assertNonemptyString(warning.message, `${label}.message`);
    if (warning.variantIds !== undefined) {
      if (!Array.isArray(warning.variantIds))
        throw new TypeError(`${label}.variantIds must be an array`);
      for (const [variantIndex, identifier] of warning.variantIds.entries()) {
        assertIdentifier(identifier, `${label}.variantIds[${variantIndex}]`);
      }
    }
  }
}

export function assertWorkspaceExportSetResult(
  value: unknown,
  provenance?: CmsProvenance,
  status?: 'success' | 'partial' | 'failed' | 'blocked',
): asserts value is WorkspaceExportSetResult {
  assertExactKeys(
    value,
    [
      'workspaceType',
      'outputDirectory',
      'selection',
      'summary',
      'externalReferenceCorrelations',
      'workspaces',
    ],
    'result',
  );
  if (value.workspaceType !== 'Marketing' && value.workspaceType !== 'Content') {
    throw new TypeError('result.workspaceType is invalid');
  }
  assertRelativePosixPath(value.outputDirectory, 'result.outputDirectory');
  assertExactKeys(
    value.selection,
    ['mode', 'discoveredCount', 'selectedCount'],
    'result.selection',
  );
  if (value.selection.mode !== 'all') throw new TypeError('result.selection.mode must be all');
  assertCount(value.selection.discoveredCount, 'result.selection.discoveredCount');
  assertCount(value.selection.selectedCount, 'result.selection.selectedCount');
  assertExactKeys(
    value.summary,
    ['succeededCount', 'partialCount', 'failedCount'],
    'result.summary',
  );
  for (const key of ['succeededCount', 'partialCount', 'failedCount'] as const) {
    assertCount(value.summary[key], `result.summary.${key}`);
  }
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.externalReferenceCorrelations)) {
    throw new TypeError('result arrays are required');
  }
  const workspaceHashes = new Map<string, string>();
  let previousWorkspaceId = '';
  for (const [index, workspace] of value.workspaces.entries()) {
    assertWorkspaceEntry(workspace, index);
    if (workspace.source.sourceId.localeCompare(previousWorkspaceId) < 0) {
      throw new TypeError('result.workspaces must be sorted by source ID');
    }
    previousWorkspaceId = workspace.source.sourceId;
    if (workspace.artifact !== null)
      workspaceHashes.set(workspace.source.sourceId, workspace.artifact.manifestSha256);
  }
  const actualSummary = {
    succeededCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'success',
    ).length,
    partialCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'partial',
    ).length,
    failedCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'failed',
    ).length,
  };
  if (value.selection.selectedCount !== value.workspaces.length) {
    throw new TypeError('result.selection.selectedCount must match workspace rows');
  }
  for (const key of ['succeededCount', 'partialCount', 'failedCount'] as const) {
    if (value.summary[key] !== actualSummary[key]) {
      throw new TypeError(`result.summary.${key} must match workspace rows`);
    }
  }
  let expectedStatus: 'success' | 'partial' | 'failed' = 'success';
  if (actualSummary.failedCount === value.workspaces.length && value.workspaces.length > 0) {
    expectedStatus = 'failed';
  } else if (actualSummary.failedCount > 0 || actualSummary.partialCount > 0) {
    expectedStatus = 'partial';
  }
  if (status !== undefined && status !== expectedStatus) {
    throw new TypeError('envelope status must match workspace rows');
  }
  assertCorrelations(value.externalReferenceCorrelations, workspaceHashes);
  if (value.externalReferenceCorrelations.length > 0) {
    if (provenance === undefined)
      throw new TypeError('export correlations require envelope provenance');
    if (provenance.producer !== 'sf-plugin-cms' || provenance.exportSetId === undefined) {
      throw new TypeError('export correlation provenance binding is incomplete');
    }
  }
}

function assertWorkspaceEntry(
  value: unknown,
  index: number,
): asserts value is WorkspaceExportSetEntry {
  const label = `result.workspaces[${index}]`;
  assertExactKeys(value, ['source', 'status', 'artifact', 'diagnostics'], label);
  assertExactKeys(value.source, ['kind', 'sourceId', 'name', 'workspaceType'], `${label}.source`);
  if (value.source.kind !== 'cms.workspace') throw new TypeError(`${label}.source.kind is invalid`);
  assertIdentifier(value.source.sourceId, `${label}.source.sourceId`);
  assertNonemptyString(value.source.name, `${label}.source.name`);
  if (value.source.workspaceType !== 'Marketing' && value.source.workspaceType !== 'Content') {
    throw new TypeError(`${label}.source.workspaceType is invalid`);
  }
  if (!['success', 'partial', 'failed'].includes(value.status as string))
    throw new TypeError(`${label}.status is invalid`);
  assertDiagnostics(value.diagnostics, `${label}.diagnostics`);
  if (value.artifact === null) {
    if (value.status !== 'failed') throw new TypeError(`${label}.artifact is required`);
    return;
  }
  assertExactKeys(
    value.artifact,
    ['path', 'manifestPath', 'manifestContract', 'manifestContractVersion', 'manifestSha256'],
    `${label}.artifact`,
  );
  assertRelativePosixPath(value.artifact.path, `${label}.artifact.path`);
  assertRelativePosixPath(value.artifact.manifestPath, `${label}.artifact.manifestPath`);
  if (value.artifact.manifestPath !== `${value.artifact.path}/manifest.json`) {
    throw new TypeError(`${label}.artifact.manifestPath is inconsistent`);
  }
  if (
    value.artifact.manifestContract !== WORKSPACE_EXPORT_MANIFEST_CONTRACT ||
    value.artifact.manifestContractVersion !== '1.0.0'
  ) {
    throw new TypeError(`${label}.artifact manifest contract/version is invalid`);
  }
  assertSha256(value.artifact.manifestSha256, `${label}.artifact.manifestSha256`);
}

function assertCorrelations(rows: unknown[], workspaceHashes: ReadonlyMap<string, string>): void {
  let previous = '';
  const sourceKeys = new Map<string, string>();
  const referenceIds = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const label = `result.externalReferenceCorrelations[${index}]`;
    assertExactKeys(
      row,
      [
        'sourceWorkspaceId',
        'sourceReference',
        'referenceKind',
        'referenceId',
        'packageManifestSha256',
      ],
      label,
    );
    assertIdentifier(row.sourceWorkspaceId, `${label}.sourceWorkspaceId`);
    assertNonemptyString(row.sourceReference, `${label}.sourceReference`);
    assertIdentifier(row.referenceKind, `${label}.referenceKind`);
    if (row.referenceKind !== 'cms.content')
      throw new TypeError(`${label}.referenceKind is unsupported`);
    if (typeof row.referenceId !== 'string' || !/^ref:[a-f\d]{64}$/u.test(row.referenceId)) {
      throw new TypeError(`${label}.referenceId is invalid`);
    }
    assertSha256(row.packageManifestSha256, `${label}.packageManifestSha256`);
    if (workspaceHashes.get(row.sourceWorkspaceId) !== row.packageManifestSha256) {
      throw new TypeError(`${label} is not bound to its workspace package`);
    }
    const sortKey = [
      row.sourceWorkspaceId,
      row.sourceReference,
      row.referenceKind,
      row.referenceId,
      row.packageManifestSha256,
    ].join('\u0000');
    if (sortKey.localeCompare(previous) < 0) throw new TypeError('correlation rows must be sorted');
    previous = sortKey;
    const sourceKey = `${row.sourceWorkspaceId}\u0000${row.sourceReference}`;
    const sourceValue = `${row.referenceKind}\u0000${row.referenceId}\u0000${row.packageManifestSha256}`;
    if (sourceKeys.has(sourceKey))
      throw new TypeError(`duplicate or conflicting correlation source: ${sourceKey}`);
    sourceKeys.set(sourceKey, sourceValue);
    const referenceValue = `${row.sourceWorkspaceId}\u0000${row.sourceReference}\u0000${row.referenceKind}\u0000${row.packageManifestSha256}`;
    const prior = referenceIds.get(row.referenceId);
    if (prior !== undefined && prior !== referenceValue)
      throw new TypeError(`conflicting reference ID: ${row.referenceId}`);
    referenceIds.set(row.referenceId, referenceValue);
  }
}

function assertCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
}
