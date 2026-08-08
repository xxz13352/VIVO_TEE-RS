import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAtomicWriteCommand,
  buildClearPersistedKeysCommand,
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
