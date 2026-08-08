import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import {
  buildAtomicWriteCommand,
  buildClearPersistedKeysCommand,
  addTarget,
  isValidKeyboxName,
  isValidPackageName,
  isValidPatchValue,
  parsePatchLevels,
  parseTargets,
  serializePatchLevels,
  serializeTargets,
} from '../../module/webroot/app.js';

test('parses target modes and active keybox context', () => {
  assert.deepEqual(
    parseTargets('com.example.auto\n[alt.xml]\ncom.example.make!\ncom.example.patch?\n'),
    [
      { packageName: 'com.example.auto', mode: 'auto', keybox: 'keybox.xml' },
      { packageName: 'com.example.make', mode: 'generate', keybox: 'alt.xml' },
      { packageName: 'com.example.patch', mode: 'patch', keybox: 'alt.xml' },
    ],
  );
});

test('serializes targets grouped by keybox and mode', () => {
  assert.equal(
    serializeTargets([
      { packageName: 'com.example.auto', mode: 'auto', keybox: 'keybox.xml' },
      { packageName: 'com.example.patch', mode: 'patch', keybox: 'alt.xml' },
    ]),
    'com.example.auto\n\n[alt.xml]\ncom.example.patch?\n',
  );
});

test('parses and serializes global and package patch levels', () => {
  const config = parsePatchLevels(
    'system=prop\nboot=no\n\n[com.example.app]\nall=2025-01-05\n',
  );

  assert.deepEqual(config.global, { system: 'prop', vendor: '', boot: 'no', all: '' });
  assert.deepEqual(config.overrides['com.example.app'], {
    system: '',
    vendor: '',
    boot: '',
    all: '2025-01-05',
  });
  assert.equal(
    serializePatchLevels(config),
    'system=prop\nboot=no\n\n[com.example.app]\nall=2025-01-05\n',
  );
});

test('encodes atomic writes rather than interpolating raw content', () => {
  const command = buildAtomicWriteCommand(
    '/data/adb/tricky_store/target.txt',
    'bad; reboot',
  );

  assert.match(command, /base64 -d/);
  assert.doesNotMatch(command, /bad; reboot/);
  assert.match(command, /mv -f/);
});

test('constrains persisted-key cleanup to state files', () => {
  const command = buildClearPersistedKeysCommand();

  assert.match(command, /persistent_keys/);
  assert.match(command, /-name '\*\.bin'/);
  assert.match(command, /-name '\*\.tmp'/);
  assert.doesNotMatch(command, /rm -rf/);
});

test('rejects shell-sensitive configuration values', () => {
  assert.equal(isValidPackageName('com.example.app'), true);
  assert.equal(isValidPackageName('com.example.app;id'), false);
  assert.equal(isValidKeyboxName('alternate.xml'), true);
  assert.equal(isValidKeyboxName('../alternate.xml'), false);
  assert.equal(isValidPatchValue('2025-01-05'), true);
  assert.equal(isValidPatchValue('$(reboot)'), false);
});

test('adding an existing package leaves targets unchanged', () => {
  const current = [{ packageName: 'com.example.app', mode: 'patch', keybox: 'keybox.xml' }];
  assert.deepEqual(addTarget(current, 'com.example.app'), current);
});

test('module contains every KernelSU WebUI runtime asset', async () => {
  for (const file of ['index.html', 'app.css', 'app.js', 'kernelsu.js']) {
    await access(new URL(`../../module/webroot/${file}`, import.meta.url));
  }
});
