import { expect } from 'chai';
import {
  assertDestinationFolderMappings,
  destinationFolderIdFor,
  parseDestinationFolderIds,
} from '../../src/services/deploy-destination-folder-mapping.js';
import type { DeployLocalSelection } from '../../src/services/deploy-source-selection.js';

const id = '9Pu000000000001AAA';
const key = 'emailFragment:Welcome';
const selection = {
  mode: 'source-dir',
  items: [
    {
      targetIdentity: {
        contentType: 'sfdc_cms__emailFragment',
        apiName: 'Welcome',
        language: 'en_US',
      },
    },
  ],
} as DeployLocalSelection;

describe('local destination folder mapping admission', () => {
  it('admits exact 15/18-character IDs and binds supplied selected Fragment keys', () => {
    expect(parseDestinationFolderIds()).to.equal(undefined);
    for (const value of [id, id.slice(0, 15)]) {
      const mappings = parseDestinationFolderIds([`${key}=${value}`]);
      expect(() => assertDestinationFolderMappings(mappings, selection)).not.to.throw();
      expect(destinationFolderIdFor(mappings, 'Welcome')).to.equal(value);
      expect(Object.isFrozen(mappings)).to.equal(true);
    }
  });
  it('rejects malformed IDs, unsupported keys and duplicates even with the same ID', () => {
    for (const assignments of [
      [],
      [`${key}=bad`],
      [`${key}=0Zu000000000001AAA`],
      [`${key}=${id}=extra`],
      [`email:Welcome=${id}`],
      [`${key}=${id}`, `${key}=${id}`],
    ])
      expect(() => parseDestinationFolderIds(assignments)).to.throw();
  });
  it('accepts optional subset mappings but rejects unselected or malformed assignments', () => {
    expect(() => assertDestinationFolderMappings({}, selection)).not.to.throw();
    const subset = structuredClone(selection);
    subset.items.push({
      ...subset.items[0],
      targetIdentity: { ...subset.items[0].targetIdentity, apiName: 'Other' },
    });
    expect(() => assertDestinationFolderMappings({ [key]: id }, subset)).not.to.throw();
    expect(destinationFolderIdFor({ [key]: id }, 'Other')).to.equal(undefined);
    expect(() =>
      assertDestinationFolderMappings({ 'emailFragment:Other': id }, selection),
    ).to.throw('Unselected');
    expect(() => assertDestinationFolderMappings({ [key]: 'bad' }, selection)).to.throw('Invalid');
    expect(() => assertDestinationFolderMappings(undefined, selection)).not.to.throw();
  });
});
