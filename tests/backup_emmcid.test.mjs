import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = new URL('../tools/extract_backup_emmcid.sh', import.meta.url);
const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const shellScriptPath = process.platform === 'win32' ? scriptPath.pathname.slice(1) : scriptPath.pathname;

test('extracts the first 01ce marker and reports its candidate payload', async () => {
  if (process.platform === 'win32' && !existsSync(bashPath)) {
    test.skip('Git Bash is required to run the shell fixture on Windows');
  }

  const directory = await mkdtemp(join(tmpdir(), 'teesimulator-backup-'));
  const inputPath = join(directory, 'backup.bin');
  try {
    await writeFile(inputPath, Buffer.from('aabb01ce112233445566778899aabbccddeeff', 'hex'));
    const result = spawnSync(bashPath, [shellScriptPath, inputPath], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /marker_offset=2\b/);
    assert.match(result.stdout, /emmcid_candidate=01ce112233445566778899aabbccddeeff\b/);
    assert.match(result.stdout, /payload_after_marker=112233445566778899aabbccddeeff\b/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('extracts an ASCII 01ce marker when the backup stores the ID as text', async () => {
  if (process.platform === 'win32' && !existsSync(bashPath)) {
    test.skip('Git Bash is required to run the shell fixture on Windows');
  }

  const directory = await mkdtemp(join(tmpdir(), 'teesimulator-backup-ascii-'));
  const inputPath = join(directory, 'backup.bin');
  const payload = '00112233445566778899aabbccddeeff0011223344556677';
  try {
    await writeFile(inputPath, Buffer.from(`aabb01ce${payload}`, 'ascii'));
    const result = spawnSync(bashPath, [shellScriptPath, inputPath, '48'], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /marker_type=ascii\b/);
    assert.match(result.stdout, /marker_offset=4\b/);
    assert.match(result.stdout, new RegExp(`emmcid_candidate=01ce${payload}\\b`));
    assert.match(result.stdout, new RegExp(`payload_after_marker=${payload}\\b`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
