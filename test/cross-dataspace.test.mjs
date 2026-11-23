import assert from 'node:assert/strict';
import { test } from 'node:test';
import Deploy from '../lib/commands/cms/deploy.js';
import { HANDLERS } from '../lib/content/registry.js';
import { mergeFieldSites } from '../lib/services/data-graph-check.js';
import { deployComponents } from '../lib/services/deploy.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, workspace } from './support/fake-org.mjs';

// Fictional data spaces, graphs and objects only.
const SPACES = ['default', { name: 'dataspace2', prefix: 'ds2' }];

const fields = (...names) => names.map((sourceFieldName) => ({ sourceFieldName }));
const node = (name, fieldNames, relatedObjects = []) => ({
  name,
  fields: fields(...fieldNames),
  relatedObjects,
});

// A standard object (Individual with a related ContactPointEmail) and an own object (Pet with a
// related Toy), each as a graph in default and its copy in dataspace2.
const GRAPHS = {
  Person_Graph: {
    dataspace: 'default',
    sourceObject: node(
      'ssot__Individual__dlm',
      ['ssot__Id__c', 'ssot__FirstName__c'],
      [node('ssot__ContactPointEmail__dlm', ['ssot__EmailAddress__c'])],
    ),
  },
  ds2_Person_Graph: {
    dataspace: 'dataspace2',
    sourceObject: node(
      'ds2_Individual__dlm',
      ['Id__c', 'FirstName__c'],
      [node('ds2_ContactPointEmail__dlm', ['EmailAddress__c'])],
    ),
  },
  Pet_Graph: {
    dataspace: 'default',
    sourceObject: node('Pet__dlm', ['Name__c', 'KQ_Id__c'], [node('Toy__dlm', ['Color__c'])]),
  },
  ds2_Pet_Graph: {
    dataspace: 'dataspace2',
    sourceObject: node(
      'ds2_Pet__dlm',
      ['Name__c', 'KQ_Id__c'],
      [node('ds2_Toy__dlm', ['Color__c'])],
    ),
  },
};

const expression = (name, value) => ({
  attributes: { value },
  default: '',
  definition: 'sfdc_cms__handlebarExpression',
  label: name,
  sfdcExpressionKey: name,
});
const root = (field) => `{{fallback (get (get @root "$dataGraph") "${field}") ""}}`;
const related = (object, field) =>
  `{{{fallback (get (map (get (get @root '$dataGraph') "${object}") "${field}") 0) "-"}}}`;

const emailHandler = HANDLERS.find((handler) => handler.type === 'email');

const emailFiles = (graph, dataspace, expressions, text = 'Hi {!$Expression.First}') => ({
  type: 'email',
  document: {
    apiName: 'CMSZ_Email',
    title: 'CMSZ_Email',
    folderPath: [],
    contentBody: {
      'lightning:dataProviders': [
        {
          attributes: { dataGraphApiName: graph, dataspace },
          definition: 'sfdc_cms__dataGraphDataProvider',
          sfdcExpressionKey: '$dataGraph',
        },
      ],
      'lightning:expressions': expressions,
      subjectLine: 'Hi',
      text,
    },
  },
  companions: {},
});

/**
 * Deploy one email through the pipeline against a fake org with both data spaces.
 * @param {object} files Source files.
 * @param {object} options preview, dataspace, allowCrossDataspace, graphs, org.
 * @returns {Promise<object>} Item, created body, diagnostics, writes.
 */
async function deployEmail(files, options = {}) {
  const { preview = false, graphs = GRAPHS, org, ...flags } = options;
  const connection = fakeConnection((org ?? fakeOrg({ dataSpaces: SPACES, graphs })).answer);
  const diagnostics = { warnings: [], errors: [] };
  const [item] = await deployComponents(
    connection,
    workspace,
    [
      {
        handler: emailHandler,
        workspaceFolder: workspace.apiName,
        apiName: files.document.apiName,
        path: 'CMSZ_Email.email.json',
        files,
      },
    ],
    { preview, diagnostics, writeOptions: { allowCallerConnection: true }, ...flags },
  );
  const writes = connection.calls.filter((call) => call.input.method !== 'GET');
  const body = writes.length > 0 ? JSON.parse(writes[0].input.body).contentBody : undefined;
  return { item, body, diagnostics, writes, calls: connection.calls };
}

const providerOf = (body) => body['lightning:dataProviders'][0].attributes;
const valuesOf = (body) => body['lightning:expressions'].map((entry) => entry.attributes.value);

test('mergeFieldSites: offsets of every name in handlebars literals and {!$dataGraph.…}', () => {
  const value = `${related('A__dlm', 'b__c')} {!$dataGraph.C__dlm.d__c}`;
  const sites = mergeFieldSites(value);
  assert.deepEqual(
    sites.map((site) => site.path),
    [
      ['A__dlm', 'b__c'],
      ['C__dlm', 'd__c'],
    ],
  );
  for (const site of sites)
    for (const [index, start] of site.starts.entries())
      assert.equal(value.slice(start, start + site.path[index].length), site.path[index]);
});

test('default -> dataspace2, standard object: graph, data space, root and related names renamed', async () => {
  const odd = `{{ fallback  (get   (get @root  "$dataGraph")\n "ssot__FirstName__c" ) "" }}`;
  const files = emailFiles(
    'Person_Graph',
    'default',
    [
      expression('First', odd),
      expression('Mail', related('ssot__ContactPointEmail__dlm', 'ssot__EmailAddress__c')),
    ],
    'Hi {!$dataGraph.ssot__FirstName__c}, {!$Expression.Mail} {!$brand.name}',
  );
  const { item, body, writes } = await deployEmail(files, {
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.equal(writes.length, 1);
  assert.deepEqual(providerOf(body), {
    dataGraphApiName: 'ds2_Person_Graph',
    dataspace: 'dataspace2',
  });
  assert.deepEqual(valuesOf(body), [
    `{{ fallback  (get   (get @root  "$dataGraph")\n "FirstName__c" ) "" }}`,
    `{{{fallback (get (map (get (get @root '$dataGraph') "ds2_ContactPointEmail__dlm") "EmailAddress__c") 0) "-"}}}`,
  ]);
  assert.equal(body.text, 'Hi {!$dataGraph.FirstName__c}, {!$Expression.Mail} {!$brand.name}');
  assert.deepEqual(item.renames, [
    'data graph Person_Graph -> ds2_Person_Graph',
    'data space default -> dataspace2',
    'merge field ssot__FirstName__c -> FirstName__c',
    'merge field ssot__ContactPointEmail__dlm.ssot__EmailAddress__c -> ds2_ContactPointEmail__dlm.EmailAddress__c',
  ]);
  // The files of the component are not changed.
  assert.equal(files.document.contentBody.text.includes('ssot__FirstName__c'), true);
});

test('default -> dataspace2, own object: object prefixed, fields and KQ_ fields kept', async () => {
  const files = emailFiles('Pet_Graph', 'default', [
    expression('First', root('Name__c')),
    expression('Key', root('KQ_Id__c')),
    expression('Toy', related('Toy__dlm', 'Color__c')),
  ]);
  const { item, body } = await deployEmail(files, {
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.deepEqual(providerOf(body), {
    dataGraphApiName: 'ds2_Pet_Graph',
    dataspace: 'dataspace2',
  });
  assert.deepEqual(valuesOf(body), [
    root('Name__c'),
    root('KQ_Id__c'),
    related('ds2_Toy__dlm', 'Color__c'),
  ]);
  assert.deepEqual(item.renames, [
    'data graph Pet_Graph -> ds2_Pet_Graph',
    'data space default -> dataspace2',
    'merge field Toy__dlm.Color__c -> ds2_Toy__dlm.Color__c',
  ]);
});

test('dataspace2 -> default, standard object: the target graph picks ssot__ names', async () => {
  const files = emailFiles('ds2_Person_Graph', 'dataspace2', [
    expression('First', root('FirstName__c')),
    expression('Mail', related('ds2_ContactPointEmail__dlm', 'EmailAddress__c')),
  ]);
  const { item, body } = await deployEmail(files, {
    dataspace: 'default',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.deepEqual(providerOf(body), { dataGraphApiName: 'Person_Graph', dataspace: 'default' });
  assert.deepEqual(valuesOf(body), [
    root('ssot__FirstName__c'),
    related('ssot__ContactPointEmail__dlm', 'ssot__EmailAddress__c'),
  ]);
});

test('dataspace2 -> default, own object: the target graph picks the plain names', async () => {
  const files = emailFiles('ds2_Pet_Graph', 'dataspace2', [
    expression('First', root('Name__c')),
    expression('Toy', related('ds2_Toy__dlm', 'Color__c')),
  ]);
  const { item, body } = await deployEmail(files, {
    dataspace: 'default',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.deepEqual(providerOf(body), { dataGraphApiName: 'Pet_Graph', dataspace: 'default' });
  assert.deepEqual(valuesOf(body), [root('Name__c'), related('Toy__dlm', 'Color__c')]);
});

const refused = async (files, graphs, dataspace = 'default') => {
  const result = await deployEmail(files, { dataspace, allowCrossDataspace: true, graphs });
  assert.equal(result.item.outcome, 'blocked');
  assert.equal(result.writes.length, 0);
  return result.diagnostics.errors.map((error) => [error.code, error.message]);
};

test('ambiguous: a field or an object with two possible names in the target graph is refused', async () => {
  const graphs = {
    ...GRAPHS,
    Person_Graph: {
      dataspace: 'default',
      sourceObject: node(
        'ssot__Individual__dlm',
        ['ssot__Title__c', 'Title__c'],
        [node('ssot__Toy__dlm', ['Color__c']), node('Toy__dlm', ['Color__c'])],
      ),
    },
  };
  const files = emailFiles('ds2_Person_Graph', 'dataspace2', [
    expression('Title', root('Title__c')),
    expression('Toy', related('ds2_Toy__dlm', 'Color__c')),
  ]);
  assert.deepEqual(await refused(files, graphs), [
    [
      'CROSS_DATASPACE_UNRESOLVED',
      'email:CMSZ_Email: merge fields of data graph ds2_Person_Graph (dataspace2) cannot be placed in Person_Graph (default): Title__c: Title__c (in ssot__Individual__dlm) matches several names of the target graph: ssot__Title__c, Title__c; the rules cannot tell which one it is; ds2_Toy__dlm.Color__c: ds2_Toy__dlm (in ssot__Individual__dlm) matches several names of the target graph: ssot__Toy__dlm, Toy__dlm; the rules cannot tell which one it is',
    ],
  ]);
});

test('unresolved: a name the target graph does not have, and one no rule places', async () => {
  const files = emailFiles('ds2_Person_Graph', 'dataspace2', [
    expression('Nick', root('Nickname__c')),
    expression('Odd', related('pkg__Thing__dlm', 'Color__c')),
  ]);
  assert.deepEqual(await refused(files, GRAPHS), [
    [
      'CROSS_DATASPACE_UNRESOLVED',
      'email:CMSZ_Email: merge fields of data graph ds2_Person_Graph (dataspace2) cannot be placed in Person_Graph (default): Nickname__c: Nickname__c (in ssot__Individual__dlm) is not in the target graph as ssot__Nickname__c or Nickname__c; pkg__Thing__dlm.Color__c: pkg__Thing__dlm (in ssot__Individual__dlm) is not in the target graph as any name (no rule places it)',
    ],
  ]);
  const graphless = emailFiles('ds2_Missing_Graph', 'dataspace2', [expression('A', root('A__c'))]);
  assert.deepEqual(await refused(graphless, GRAPHS), [
    [
      'DATA_GRAPH_NOT_IN_DESTINATION',
      'Data graph Missing_Graph does not exist in data space default of the destination org',
    ],
  ]);
});

test('silent trap: a target graph in the old spelling is refused, never matched as it is', async () => {
  // A dataspace2 graph built in the default spelling: Salesforce accepts it, the field stays empty.
  const defaultSpelled = {
    ...GRAPHS,
    ds2_Person_Graph: {
      dataspace: 'dataspace2',
      sourceObject: node('ds2_Individual__dlm', ['ssot__FirstName__c']),
    },
  };
  const files = emailFiles('Person_Graph', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  assert.deepEqual(await refused(files, defaultSpelled, 'dataspace2'), [
    [
      'CROSS_DATASPACE_UNRESOLVED',
      'email:CMSZ_Email: merge fields of data graph Person_Graph (default) cannot be placed in ds2_Person_Graph (dataspace2): ssot__FirstName__c: ssot__FirstName__c (in ds2_Individual__dlm): the target graph holds it spelled as in default (it would build and stay empty); rebuild the graph in the dataspace2 spelling (FirstName__c)',
    ],
  ]);
  // A kept name that still carries the old prefix after renaming.
  const prefixedField = {
    ...GRAPHS,
    Pet_Graph: { dataspace: 'default', sourceObject: node('Pet__dlm', ['ds2_Code__c']) },
  };
  const kept = emailFiles('ds2_Pet_Graph', 'dataspace2', [expression('Code', root('ds2_Code__c'))]);
  assert.deepEqual(await refused(kept, prefixedField), [
    [
      'CROSS_DATASPACE_UNRESOLVED',
      'email:CMSZ_Email: merge fields of data graph ds2_Pet_Graph (dataspace2) cannot be placed in Pet_Graph (default): ds2_Code__c: ds2_Code__c is still spelled as in dataspace2 after the renaming',
    ],
  ]);
});

test('without --allow-cross-dataspace a provider of another data space is refused before any read of the graph', async () => {
  const files = emailFiles('Person_Graph', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  for (const preview of [true, false]) {
    const { item, writes, diagnostics, calls } = await deployEmail(files, {
      preview,
      dataspace: 'dataspace2',
    });
    assert.equal(calls.filter((call) => call.input.url.startsWith('/ssot/')).length, 0);
    assert.deepEqual([item.outcome, item.reason], ['blocked', 'CROSS_DATASPACE_NOT_ALLOWED']);
    assert.equal(writes.length, 0);
    assert.equal(
      diagnostics.errors[0].message,
      'email:CMSZ_Email reads data graph Person_Graph of data space default, not of --dataspace dataspace2; add --allow-cross-dataspace (-c) to rename it into dataspace2',
    );
    assert.match(diagnostics.errors[0].hint, /--allow-cross-dataspace \(-c\)/u);
  }
});

test('an expression provider without a data space is not moved into another data space', async () => {
  const files = emailFiles('Person_Graph', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  delete files.document.contentBody['lightning:dataProviders'][0].attributes.dataspace;
  assert.deepEqual(await refused(files, GRAPHS, 'dataspace2'), [
    [
      'CROSS_DATASPACE_UNRESOLVED',
      'email:CMSZ_Email: its data graph provider names no data space (read as default), so it cannot be moved into dataspace2',
    ],
  ]);
});

test('without --dataspace, or with the provider already there, nothing is renamed', async () => {
  const files = emailFiles('Person_Graph', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  for (const flags of [
    {},
    { dataspace: 'default' },
    { dataspace: 'default', allowCrossDataspace: true },
  ]) {
    const { item, body } = await deployEmail(files, flags);
    assert.equal(item.outcome, 'created');
    assert.equal(item.renames, undefined);
    assert.deepEqual(
      body['lightning:dataProviders'],
      files.document.contentBody['lightning:dataProviders'],
    );
    assert.deepEqual(
      body['lightning:expressions'],
      files.document.contentBody['lightning:expressions'],
    );
    assert.equal(body.text, files.document.contentBody.text);
  }
});

test('preview lists every rename and writes nothing', async () => {
  const files = emailFiles('ds2_Pet_Graph', 'dataspace2', [
    expression('First', root('Name__c')),
    expression('Toy', related('ds2_Toy__dlm', 'Color__c')),
  ]);
  const { item, writes } = await deployEmail(files, {
    preview: true,
    dataspace: 'default',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'create');
  assert.equal(writes.length, 0);
  assert.deepEqual(item.renames, [
    'data graph ds2_Pet_Graph -> Pet_Graph',
    'data space dataspace2 -> default',
    'merge field ds2_Toy__dlm.Color__c -> Toy__dlm.Color__c',
  ]);
});

test('deploy flags: --dataspace and --allow-cross-dataspace (-c), which needs --dataspace', () => {
  assert.equal(Deploy.flags.dataspace.type, 'option');
  assert.equal(Deploy.flags['allow-cross-dataspace'].char, 'c');
  assert.deepEqual(Deploy.flags['allow-cross-dataspace'].dependsOn, ['dataspace']);
});

test('a renamed component deployed again compares in the target spelling and is unchanged', async () => {
  const files = emailFiles('Person_Graph', 'default', [
    expression('Mail', related('ssot__ContactPointEmail__dlm', 'ssot__EmailAddress__c')),
  ]);
  const org = fakeOrg({ dataSpaces: SPACES, graphs: GRAPHS });
  const flags = { org, dataspace: 'dataspace2', allowCrossDataspace: true };
  const first = await deployEmail(files, flags);
  assert.equal(first.item.outcome, 'created');
  const again = await deployEmail(files, flags);
  assert.equal(again.item.outcome, 'unchanged');
  assert.equal(again.writes.length, 0);
});

// Identity resolution outputs (fictional ruleset IDs): the graph Audience in default has the
// unified Individual of ruleset Individual_QX1 as its root; its copy ds2_Audience in dataspace2
// has the output of ruleset ds2_Individual_QX2, whose ID differs, so only the ruleset list pairs them.
const output = (space, id, entity) =>
  space === 'default'
    ? {
        entityName: `ssot__${entity}__dlm`,
        unifiedDmoName: `Unifiedssot${entity}${id}__dlm`,
        linkDmoName: `UnifiedLinkssot${entity}${id}__dlm`,
      }
    : {
        entityName: `ds2_${entity}__dlm`,
        unifiedDmoName: `ds2_Unified${entity}${id}__dlm`,
        linkDmoName: `ds2_UnifiedLink${entity}${id}__dlm`,
      };
const ruleset = (objectApiName, dataSpaceName, id) => ({
  objectApiName,
  dataSpaceName,
  configurationType: 'Individual',
  reconciliationRules: ['Individual', 'ContactPointEmail'].map((entity) =>
    output(dataSpaceName, id, entity),
  ),
});
const RULESETS = [
  ruleset('Individual_QX1', 'default', 'Qx1'),
  ruleset('ds2_Individual_QX2', 'dataspace2', 'Qx2'),
];
const UNIFIED_GRAPHS = {
  ...GRAPHS,
  Audience: {
    dataspace: 'default',
    sourceObject: node(
      'UnifiedssotIndividualQx1__dlm',
      ['ssot__Id__c', 'ssot__FirstName__c'],
      [node('UnifiedssotContactPointEmailQx1__dlm', ['ssot__EmailAddress__c'])],
    ),
  },
  ds2_Audience: {
    dataspace: 'dataspace2',
    sourceObject: node(
      'ds2_UnifiedIndividualQx2__dlm',
      ['Id__c', 'FirstName__c'],
      [node('ds2_UnifiedContactPointEmailQx2__dlm', ['EmailAddress__c'])],
    ),
  },
};
const unifiedOrg = (rulesets = RULESETS) =>
  fakeOrg({ dataSpaces: SPACES, graphs: UNIFIED_GRAPHS, rulesets });
const rulesetReads = (calls) =>
  calls.filter((call) => call.input.url.startsWith('/ssot/identity-resolutions')).length;

test('default -> dataspace2, unified root and related output: paired from the ruleset list, read once', async () => {
  const files = emailFiles(
    'Audience',
    'default',
    [
      expression('First', root('ssot__FirstName__c')),
      expression('Mail', related('UnifiedssotContactPointEmailQx1__dlm', 'ssot__EmailAddress__c')),
    ],
    'Hi {!$dataGraph.ssot__FirstName__c}',
  );
  const { item, body, calls } = await deployEmail(files, {
    org: unifiedOrg(),
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.equal(rulesetReads(calls), 1);
  assert.deepEqual(providerOf(body), { dataGraphApiName: 'ds2_Audience', dataspace: 'dataspace2' });
  assert.deepEqual(valuesOf(body), [
    root('FirstName__c'),
    related('ds2_UnifiedContactPointEmailQx2__dlm', 'EmailAddress__c'),
  ]);
  assert.equal(body.text, 'Hi {!$dataGraph.FirstName__c}');
  assert.deepEqual(item.renames, [
    'data graph Audience -> ds2_Audience',
    'data space default -> dataspace2',
    'merge field ssot__FirstName__c -> FirstName__c',
    'merge field UnifiedssotContactPointEmailQx1__dlm.ssot__EmailAddress__c -> ds2_UnifiedContactPointEmailQx2__dlm.EmailAddress__c',
  ]);
});

test('dataspace2 -> default, unified root and related output: paired back, fields get ssot__', async () => {
  const files = emailFiles('ds2_Audience', 'dataspace2', [
    expression('First', root('FirstName__c')),
    expression('Mail', related('ds2_UnifiedContactPointEmailQx2__dlm', 'EmailAddress__c')),
  ]);
  const { item, body } = await deployEmail(files, {
    org: unifiedOrg(),
    dataspace: 'default',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.deepEqual(providerOf(body), { dataGraphApiName: 'Audience', dataspace: 'default' });
  assert.deepEqual(valuesOf(body), [
    root('ssot__FirstName__c'),
    related('UnifiedssotContactPointEmailQx1__dlm', 'ssot__EmailAddress__c'),
  ]);
});

test('the ruleset list is read only when a Unified… name occurs', async () => {
  const files = emailFiles('Person_Graph', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  const { item, calls } = await deployEmail(files, {
    org: unifiedOrg(),
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(item.outcome, 'created');
  assert.equal(rulesetReads(calls), 0);
});

test('unpaired: a unified output whose target data space has no ruleset of its type is refused', async () => {
  const files = emailFiles('Audience', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  const result = await deployEmail(files, {
    org: unifiedOrg([RULESETS[0]]),
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(result.item.outcome, 'blocked');
  assert.equal(result.writes.length, 0);
  assert.deepEqual(
    result.diagnostics.errors.map((error) => [error.code, error.message]),
    [
      [
        'CROSS_DATASPACE_UNRESOLVED',
        'email:CMSZ_Email: merge fields of data graph Audience (default) cannot be placed in ds2_Audience (dataspace2): ssot__FirstName__c: ds2_UnifiedIndividualQx2__dlm (the root of the target graph): no identity resolution ruleset of dataspace2 lists it as an output, and no identity resolution ruleset of default has an output that is ds2_UnifiedIndividualQx2__dlm in dataspace2',
      ],
    ],
  );
  // A related output of a ruleset the source data space does not have.
  const stray = emailFiles('Audience', 'default', [
    expression('Mail', related('UnifiedssotContactPointEmailQx9__dlm', 'ssot__EmailAddress__c')),
  ]);
  const strayResult = await deployEmail(stray, {
    org: unifiedOrg(),
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.equal(strayResult.item.outcome, 'blocked');
  assert.match(
    strayResult.diagnostics.errors[0].message,
    /UnifiedssotContactPointEmailQx9__dlm \(in ds2_UnifiedIndividualQx2__dlm\): no identity resolution ruleset of default lists it as an output/u,
  );
});

test('a failed ruleset read refuses the component and writes nothing', async () => {
  const files = emailFiles('Audience', 'default', [
    expression('First', root('ssot__FirstName__c')),
  ]);
  const { item, writes, diagnostics } = await deployEmail(files, {
    org: fakeOrg({ dataSpaces: SPACES, graphs: UNIFIED_GRAPHS }),
    dataspace: 'dataspace2',
    allowCrossDataspace: true,
  });
  assert.deepEqual([item.outcome, item.reason], ['blocked', 'CROSS_DATASPACE_UNRESOLVED']);
  assert.equal(writes.length, 0);
  assert.match(
    diagnostics.errors[0].message,
    /^email:CMSZ_Email: data graph ds2_Audience uses an identity resolution output \(Unified…\), and the identity resolution ruleset list \(GET \/ssot\/identity-resolutions\) that pairs it with its ruleset could not be read: /u,
  );
});
