import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON ?? 'python';
const issuer = new URL('../tools/license_issuer.py', import.meta.url).pathname.slice(1);
const emmcid = '01ce003800350063003000300063003200640065003300340032';

function run(args) {
  return spawnSync(python, [issuer, ...args], { encoding: 'utf8' });
}

test('issues and verifies an offline device-bound Ed25519 license', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teesimulator-license-'));
  const privateKey = join(directory, 'license-private.pem');
  const publicKey = join(directory, 'license-public.hex');
  const license = join(directory, 'license.lic');
  try {
    const initialized = run(['init', '--private-key', privateKey, '--public-key', publicKey]);
    assert.equal(initialized.status, 0, initialized.stderr);

    const issued = run([
      'issue',
      '--private-key',
      privateKey,
      '--emmcid',
      emmcid,
      '--out',
      license,
      '--license-id',
      'test-license-001',
      '--issued-at',
      '1700000000',
      '--days',
      '30',
    ]);
    assert.equal(issued.status, 0, issued.stderr);
    const text = await readFile(license, 'utf8');
    assert.match(text, /^TEERS-LICENSE-1\n/m);
    assert.match(text, /fingerprint=[0-9a-f]{64}/);
    assert.match(text, /signature=[A-Za-z0-9_-]+/);

    const verified = run([
      'verify',
      '--public-key',
      publicKey,
      '--license',
      license,
      '--emmcid',
      emmcid,
      '--now',
      '1700000001',
    ]);
    assert.equal(verified.status, 0, verified.stderr);

    const wrongDevice = run([
      'verify',
      '--public-key',
      publicKey,
      '--license',
      license,
      '--emmcid',
      `${emmcid}00`,
      '--now',
      '1700000001',
    ]);
    assert.notEqual(wrongDevice.status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
