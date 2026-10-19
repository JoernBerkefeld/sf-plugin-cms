import { expect } from 'chai';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Readable } from 'node:stream';
import sinon from 'sinon';
import { createRequire } from 'node:module';
import { createInvocationLogger } from '../src/logging.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../src/filesystem/runOwnedTemp.js';

const startedAt = new Date('2026-10-19T11:24:05.123Z');
describe('invocation logging foundation', () => {
  let run: RunOwnedTemp;
  let cwd: string;
  beforeEach(async () => {
    run = await createRunOwnedTemp('cms-logging');
    cwd = await createRunOwnedDirectory(run, 'fixture');
  });
  afterEach(async () => {
    sinon.restore();
    await removeRunOwnedPath(run, cwd);
  });
  it('commits actual version and alias tokens first, flushes records and closes once', async () => {
    const argv = [
      'content',
      'retrieve',
      '--name=a b',
      '--name',
      'second',
      '--access-token',
      'SECRET',
    ];
    const logger = createInvocationLogger({ cwd, argv, startedAt });
    logger.log('debug', 'later', { stage: 'guard', reason: 'signature validation failed' });
    const close = logger.close();
    expect(logger.close()).to.equal(close);
    await close;
    logger.log('info', 'ignored after close');
    expect(logger.filePath).to.equal(path.join(cwd, 'logs', 'cms', '2026-10-19T11.24.05.123Z.log'));
    const text = fs.readFileSync(logger.filePath, 'utf8');
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const version = (createRequire(import.meta.url)('../package.json') as { version: string })
      .version;
    expect(records.map((record) => record.message)).to.deep.equal([
      `sf-plugin-cms ${version}`,
      'invocation',
      'later',
    ]);
    expect(records[1].details.argv).to.deep.equal([...argv.slice(0, -1), '[REDACTED]']);
    expect(records[2].details.reason).to.equal('signature validation failed');
    expect(text).not.to.include('SECRET');
  });
  it('isolates simultaneous frozen-clock invocations without overwrite or append', async () => {
    const loggers = Array.from({ length: 4 }, (_, index) =>
      createInvocationLogger({ cwd, argv: ['cms', String(index)], startedAt }),
    );
    await Promise.all(loggers.map((logger) => logger.close()));
    expect(new Set(loggers.map((logger) => logger.filePath)).size).to.equal(4);
    expect(loggers[3].filePath).to.match(/11\.24\.05\.126Z\.log$/u);
    for (const [index, logger] of loggers.entries()) {
      const records = fs
        .readFileSync(logger.filePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).to.have.length(2);
      expect(records[1].details.argv).to.deep.equal(['cms', String(index)]);
    }
  });
  it('arbitrates the same timestamp across independent processes', async () => {
    const moduleUrl = new URL('../lib/logging.js', import.meta.url).href;
    const code = `import {createInvocationLogger} from ${JSON.stringify(moduleUrl)};const logger=createInvocationLogger({cwd:process.argv[1],argv:['content',process.argv[2]],startedAt:new Date('2026-10-19T11:24:05.123Z')});await logger.close();console.log(logger.filePath);`;
    const results = await Promise.all(
      ['first', 'second'].map((name) =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, cwd, name]),
      ),
    );
    const files = results.map((result) => result.stdout.trim());
    expect(new Set(files).size).to.equal(2);
    for (const [index, file] of files.entries()) {
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).to.have.length(2);
      expect(records[1].details.argv).to.deep.equal(['content', index === 0 ? 'first' : 'second']);
    }
  });

  it('sanitizes nested errors, encoded JSON, URLs and binary without consuming streams', async () => {
    let consumed = false;
    const stream = new Readable({
      read() {
        consumed = true;
      },
    });
    const logger = createInvocationLogger({ cwd, argv: ['cms'], startedAt });
    const error = new Error('Blocked: missing selector; Bearer SECRETbearer');
    Object.assign(error, {
      cause: {
        Authorization: 'SECRETauth',
        refresh_token: 'SECRETrefresh',
        clientSecret: 'SECRETclient',
        cookie: 'SECRETcookie',
        validation: ['Choose one selector'],
      },
    });
    logger.log('error', 'guard', {
      error,
      encoded: encodeURIComponent('{"access_token":"SECRETencoded","reason":"useful"}'),
      url: 'https://user:SECRETpass@host/path?sig=SECRETsig&safe=yes',
      binary: Buffer.from('SECRETbinary'),
      stream,
    });
    await logger.close();
    const text = fs.readFileSync(logger.filePath, 'utf8');
    expect(text).not.to.include('SECRET');
    expect(text)
      .to.include('Choose one selector')
      .and.include('missing selector')
      .and.include('safe=yes')
      .and.include('useful')
      .and.include('not consumed');
    expect(consumed).to.equal(false);
    stream.destroy();
  });
  it('reports path failure with intended destination and remains safe to close', async () => {
    fs.writeFileSync(path.join(cwd, 'logs'), 'not a directory');
    const stderr = sinon.spy();
    const logger = createInvocationLogger({ cwd, argv: [], stderr });
    logger.log('error', 'not written');
    await logger.close();
    expect(stderr.calledOnce).to.equal(true);
    expect(stderr.firstCall.args[0])
      .to.include(path.join(cwd, 'logs', 'cms'))
      .and.include('incomplete');
  });
  it('refuses directory junctions and final target links', async () => {
    const outside = await createRunOwnedDirectory(run, 'outside');
    fs.symlinkSync(
      outside,
      path.join(cwd, 'logs'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const stderr = sinon.spy();
    const logger = createInvocationLogger({ cwd, argv: [], stderr });
    await logger.close();
    expect(stderr.calledOnce).to.equal(true);
    expect(fs.readdirSync(outside)).to.deep.equal([]);
    fs.unlinkSync(path.join(cwd, 'logs'));
    await removeRunOwnedPath(run, outside);
  });
  it('reports write and flush failures without throwing or leaking credentials', async () => {
    const stderr = sinon.spy();
    const logger = createInvocationLogger({ cwd, argv: [], stderr });
    const write = sinon.stub(fs, 'writeSync').throws(new Error('disk full Bearer SECRET'));
    logger.log('info', 'later');
    write.restore();
    await logger.close();
    expect(stderr.calledOnce).to.equal(true);
    expect(stderr.firstCall.args[0]).to.include('disk full').and.not.include('SECRET');
    const second = createInvocationLogger({ cwd, argv: [], stderr });
    sinon.stub(fs, 'fsyncSync').throws(new Error('flush failed'));
    await second.close();
    expect(stderr.lastCall.args[0]).to.include('flush failed');
  });
});
