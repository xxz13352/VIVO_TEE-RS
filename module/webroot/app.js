const CONFIG_DIR = '/data/adb/tricky_store';
const DEFAULT_KEYBOX = 'keybox.xml';
const PATCH_FIELDS = ['system', 'vendor', 'boot', 'all'];
const WRITABLE_PATHS = new Set([
  `${CONFIG_DIR}/target.txt`,
  `${CONFIG_DIR}/security_patch.txt`,
  `${CONFIG_DIR}/boot_props_mode`,
]);

function emptyPatchLevel() {
  return { system: '', vendor: '', boot: '', all: '' };
}

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function requireValidTarget(target) {
  if (!isValidPackageName(target.packageName)) {
    throw new Error(`Invalid package name: ${target.packageName}`);
  }
  if (!['auto', 'generate', 'patch'].includes(target.mode)) {
    throw new Error(`Invalid target mode: ${target.mode}`);
  }
  if (!isValidKeyboxName(target.keybox)) {
    throw new Error(`Invalid keybox name: ${target.keybox}`);
  }
}

export function isValidPackageName(value) {
  return /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

export function isValidKeyboxName(value) {
  return /^[A-Za-z0-9_.-]+\.xml$/.test(value);
}

export function isValidPatchValue(value) {
  return (
    value === '' ||
    ['today', 'prop', 'device_default', 'no'].includes(value) ||
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  );
}

export function parseTargets(text) {
  const targets = [];
  let currentKeybox = DEFAULT_KEYBOX;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const keyboxMatch = line.match(/^\[([A-Za-z0-9_.-]+\.xml)]$/);
    if (keyboxMatch) {
      currentKeybox = keyboxMatch[1];
      continue;
    }

    const suffix = line.at(-1);
    const packageName = suffix === '!' || suffix === '?' ? line.slice(0, -1).trim() : line;
    if (!isValidPackageName(packageName)) continue;

    targets.push({
      packageName,
      mode: suffix === '!' ? 'generate' : suffix === '?' ? 'patch' : 'auto',
      keybox: currentKeybox,
    });
  }

  return targets;
}

export function serializeTargets(targets) {
  const groups = new Map();

  for (const target of targets) {
    requireValidTarget(target);
    const group = groups.get(target.keybox) ?? [];
    group.push(target);
    groups.set(target.keybox, group);
  }

  const orderedKeyboxes = [
    DEFAULT_KEYBOX,
    ...[...groups.keys()].filter((keybox) => keybox !== DEFAULT_KEYBOX).sort(),
  ];
  const sections = [];

  for (const keybox of orderedKeyboxes) {
    const group = groups.get(keybox);
    if (!group?.length) continue;

    const rows = group
      .sort((left, right) => left.packageName.localeCompare(right.packageName))
      .map((target) => {
        const suffix = target.mode === 'generate' ? '!' : target.mode === 'patch' ? '?' : '';
        return `${target.packageName}${suffix}`;
      });

    sections.push(keybox === DEFAULT_KEYBOX ? rows.join('\n') : `[${keybox}]\n${rows.join('\n')}`);
  }

  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

export function parsePatchLevels(text) {
  const config = { global: emptyPatchLevel(), overrides: {} };
  let context = config.global;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([A-Za-z][A-Za-z0-9_.-]*)]$/);
    if (sectionMatch) {
      const packageName = sectionMatch[1];
      context = isValidPackageName(packageName)
        ? (config.overrides[packageName] ??= emptyPatchLevel())
        : config.global;
      continue;
    }

    const [rawKey, ...valueParts] = line.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = valueParts.join('=').trim();
    if (PATCH_FIELDS.includes(key) && isValidPatchValue(value)) {
      context[key] = value;
    }
  }

  return config;
}

export function serializePatchLevels(config) {
  const sections = [];
  const serializeSection = (values) =>
    PATCH_FIELDS.filter((field) => values[field]).map((field) => `${field}=${values[field]}`);

  const globalRows = serializeSection(config.global);
  if (globalRows.length) sections.push(globalRows.join('\n'));

  for (const packageName of Object.keys(config.overrides).sort()) {
    if (!isValidPackageName(packageName)) {
      throw new Error(`Invalid package name: ${packageName}`);
    }
    const rows = serializeSection(config.overrides[packageName]);
    if (rows.length) sections.push(`[${packageName}]\n${rows.join('\n')}`);
  }

  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

export function buildAtomicWriteCommand(path, content) {
  if (!WRITABLE_PATHS.has(path)) {
    throw new Error(`Unsupported configuration path: ${path}`);
  }

  const temporaryPath = `${path}.webui.tmp`;
  const payload = encodeUtf8Base64(content);
  return `printf '%s' '${payload}' | base64 -d > '${temporaryPath}' && chmod 0644 '${temporaryPath}' && mv -f '${temporaryPath}' '${path}'`;
}

export function buildClearPersistedKeysCommand() {
  const directory = `${CONFIG_DIR}/persistent_keys`;
  return `mkdir -p '${directory}' && find '${directory}' -maxdepth 1 -type f \\( -name '*.bin' -o -name '*.tmp' \\) -delete && chmod 0700 '${directory}'`;
}
