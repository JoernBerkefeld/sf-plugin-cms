import { Plugin } from '@oclif/core';
import { expect } from 'chai';
import ListChannel from '../../src/commands/cms/list/channel.js';
import ListWorkspace from '../../src/commands/cms/list/workspace.js';

const commands = [ListChannel, ListWorkspace];

describe('CMS read command definitions', () => {
  it('requires explicit target-org on every retained list command', () => {
    for (const command of commands) {
      expect(command.flags['target-org'].required, command.name).to.equal(true);
    }
  });

  it('requires the workspace selector for channel listing', () => {
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
  });

  it('discovers retained commands without any public get route or alias', async () => {
    const plugin = new Plugin({ root: process.cwd() });
    await plugin.load();
    expect(plugin.commandIDs).to.include.members([
      'cms:info',
      'cms:list:workspace',
      'cms:list:channel',
      'cms:retrieve:content',
      'cms:deploy:content',
      'cms:upload',
      'cms:publish:content',
      'cms:unpublish:content',
      'cms:delete:content',
    ]);
    const aliasPairs = [
      ['cms:retrieve:content', 'content:retrieve'],
      ['cms:deploy:content', 'content:deploy'],
      ['cms:delete:content', 'content:delete'],
      ['cms:publish:content', 'content:publish'],
      ['cms:unpublish:content', 'content:unpublish'],
      ['cms:list:workspace', 'content:list:workspace'],
      ['cms:list:channel', 'content:list:channel'],
      ['cms:upload', 'content:upload'],
      ['cms:info', 'content:info'],
    ];
    for (const [canonical, alias] of aliasPairs) {
      const descriptor = await plugin.findCommand(canonical);
      expect(descriptor?.id, canonical).to.equal(canonical);
      expect(descriptor?.aliases, canonical).to.deep.equal([alias]);
    }
    expect(await plugin.findCommand('cms:upload:images')).to.equal(undefined);
    expect(await plugin.findCommand('content:upload:images')).to.equal(undefined);
    const aliases = plugin.commands.flatMap((command) => command.aliases ?? []);
    expect(aliases).to.have.members(aliasPairs.map(([, alias]) => alias));
    expect(new Set(aliases).size).to.equal(aliases.length);
    expect(plugin.commandIDs.filter((id) => id.split(':').includes('get'))).to.deep.equal([]);
    expect(plugin.commandIDs.filter((id) => id.split(':').includes('export'))).to.deep.equal([]);
    expect(plugin.commandIDs.filter((id) => id.split(':').includes('import'))).to.deep.equal([]);
    expect(plugin.commandIDs.filter((id) => id.split(':').includes('update'))).to.deep.equal([]);
    expect(await plugin.findCommand('cms:update:content')).to.equal(undefined);
    expect(plugin.commands.flatMap((command) => command.aliases ?? [])).not.to.include(
      'cms:update:content',
    );
    expect(await plugin.findCommand('cms:import:workspace')).to.equal(undefined);
    expect(plugin.commands.flatMap((command) => command.aliases ?? [])).not.to.include(
      'cms:import:workspace',
    );
    expect(await plugin.findCommand('cms:export:workspace')).to.equal(undefined);
    expect(plugin.commands.flatMap((command) => command.aliases ?? [])).not.to.include(
      'cms:export:workspace',
    );
    for (const resource of ['workspace', 'channel', 'content', 'variant']) {
      expect(await plugin.findCommand(`cms:get:${resource}`)).to.equal(undefined);
    }
    expect(plugin.commands.flatMap((command) => command.aliases ?? [])).not.to.include.members([
      'cms:get:workspace',
      'cms:get:channel',
      'cms:get:content',
      'cms:get:variant',
    ]);
  });
});
