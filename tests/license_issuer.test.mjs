import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const python = process.env.PYTHON ?? 'python';
const issuer = new URL('../tools/license_issuer.py', import.meta.url).pathname.slice(1);
const activationIssuer = new URL('../tools/activation_code_issuer.sh', import.meta.url);
const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const shellScriptPath = process.platform === 'win32' ? activationIssuer.pathname.slice(1) : activationIssuer.pathname;
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

test('activation issuer signs a WebUI fingerprint without network access', async (t) => {
  if (process.platform === 'win32' && !existsSync(bashPath)) {
    t.skip('Git Bash is required to run the shell fixture on Windows');
  }

  const directory = await mkdtemp(join(tmpdir(), 'teesimulator-activation-'));
  const privateKey = join(directory, 'license-private.pem');
  const publicKey = join(directory, 'license-public.hex');
  const license = join(directory, 'activation.lic');
  const fingerprint = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  try {
    const script = await readFile(new URL('../tools/activation_code_issuer.sh', import.meta.url), 'utf8');
    assert.doesNotMatch(script, /\r/);
    assert.doesNotMatch(script, /grep -Eq/);
    assert.equal(run(['init', '--private-key', privateKey, '--public-key', publicKey]).status, 0);
    const issued = spawnSync(bashPath, [shellScriptPath, fingerprint, license, 'offline-test', '30'], {
      encoding: 'utf8',
      env: { ...process.env, LICENSE_PRIVATE_KEY: privateKey, PYTHON: python },
    });
    assert.equal(issued.status, 0, issued.stderr);
    assert.equal(
      run([
        'verify',
        '--public-key',
        publicKey,
        '--license',
        license,
      ]).status,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
