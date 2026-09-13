import { expect } from 'chai';
import GetChannel from '../../src/commands/cms/get/channel.js';
import GetContent from '../../src/commands/cms/get/content.js';
import GetVariant from '../../src/commands/cms/get/variant.js';
import GetWorkspace from '../../src/commands/cms/get/workspace.js';
import ListChannel from '../../src/commands/cms/list/channel.js';
import ListWorkspace from '../../src/commands/cms/list/workspace.js';

const commands = [GetWorkspace, GetChannel, GetContent, GetVariant, ListChannel, ListWorkspace];

describe('CMS read command definitions', () => {
  it('requires explicit target-org on every command', () => {
    for (const command of commands) {
      expect(command.flags['target-org'].required, command.name).to.equal(true);
    }
  });

  it('requires resource selectors for get commands and channel listing', () => {
    expect(GetWorkspace.flags['workspace-id'].required).to.equal(true);
    expect(GetChannel.flags['channel-id'].required).to.equal(true);
    expect(GetContent.flags['content-key-or-id'].required).to.equal(true);
    expect(GetVariant.flags['variant-id'].required).to.equal(true);
    expect(ListChannel.flags['workspace-id'].required).to.equal(true);
  });

  it('exposes descriptor-backed path and query flags', () => {
    expect(Object.keys(ListWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'name-fragment',
      'page',
      'page-size',
    ]);
    expect(Object.keys(ListChannel.flags)).to.have.members([
      'target-org',
      'api-version',
      'workspace-id',
      'page',
      'page-size',
    ]);
    expect(Object.keys(GetContent.flags)).to.have.members([
      'target-org',
      'api-version',
      'content-key-or-id',
      'content-version',
      'language',
      'variant-version',
      'version',
    ]);
  });
});
