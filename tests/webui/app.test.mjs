import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import {
  buildAtomicWriteCommand,
  buildClearPersistedKeysCommand,
  addTarget,
  isValidKeyboxName,
  isValidPackageName,
  isValidPatchValue,
  parseAutoPackageRefresh,
  parseIntegrityStatus,
  parsePatchLevels,
  parseTargets,
  serializeAutoPackageRefresh,
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

test('persists the automatic package catalog refresh setting with a safe disabled fallback', () => {
  assert.equal(parseAutoPackageRefresh('enabled\n'), true);
  assert.equal(parseAutoPackageRefresh('disabled'), false);
  assert.equal(parseAutoPackageRefresh('unexpected value'), false);
  assert.equal(serializeAutoPackageRefresh(true), 'enabled\n');
  assert.equal(serializeAutoPackageRefresh(false), 'disabled\n');
  assert.match(
    buildAtomicWriteCommand('/data/adb/tricky_store/auto_package_refresh', 'enabled\n'),
    /base64 -d/,
  );
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

test('installer preserves KernelSU WebUI files when SKIPUNZIP is enabled', async () => {
  const installer = await readFile(new URL('../../module/customize.sh', import.meta.url), 'utf8');

  assert.match(installer, /unzip -oq "\$ZIPFILE" "webroot\/\*" -d "\$MODPATH"/);
  assert.match(installer, /\[ ! -f "\$MODPATH\/webroot\/index\.html" \]/);
  assert.match(installer, /install_file "integrity\.sha256" "\$MODPATH"/);
});

test('normalizes module integrity status from the boot verifier', () => {
  assert.equal(parseIntegrityStatus('verified\n'), 'verified');
  assert.equal(parseIntegrityStatus('modified'), 'modified');
  assert.equal(parseIntegrityStatus('missing'), 'unavailable');
});

test('packaging defines an integrity manifest for module metadata and WebUI assets', async () => {
  const buildScript = await readFile(new URL('../../app/build.gradle.kts', import.meta.url), 'utf8');

  assert.match(buildScript, /integrity\.sha256/);
  for (const path of ['module.prop', 'service.sh', 'customize.sh', 'webroot/index.html', 'webroot/app.css', 'webroot/app.js', 'webroot/kernelsu.js']) {
    assert.match(buildScript, new RegExp(`"${path.replace('.', '\\.')}"`));
  }
});

test('integrity verifier accepts safe relative manifest paths', async () => {
  const verifier = await readFile(new URL('../../module/verify_integrity.sh', import.meta.url), 'utf8');

  assert.match(verifier, /case "\$relative_path" in\s+""\|\/\*|\.\.\/\*|\*\/\.\.\/\*|\*\/\.\.\)/);
});
