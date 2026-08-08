const CONFIG_DIR = '/data/adb/tricky_store';
const DEFAULT_KEYBOX = 'keybox.xml';
const PATCH_FIELDS = ['system', 'vendor', 'boot', 'all'];
const AUTO_PACKAGE_REFRESH_FILE = `${CONFIG_DIR}/auto_package_refresh`;
const WRITABLE_PATHS = new Set([
  `${CONFIG_DIR}/target.txt`,
  `${CONFIG_DIR}/security_patch.txt`,
  `${CONFIG_DIR}/boot_props_mode`,
  AUTO_PACKAGE_REFRESH_FILE,
  `${CONFIG_DIR}/license.lic`,
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

export function parseIntegrityStatus(value) {
  const status = String(value).trim();
  return ['verified', 'modified'].includes(status) ? status : 'unavailable';
}

export function parseAutoPackageRefresh(value) {
  return String(value).trim() === 'enabled';
}

export function serializeAutoPackageRefresh(enabled) {
  return enabled ? 'enabled\n' : 'disabled\n';
}

export function parseLicenseStatus(value) {
  const status = String(value).trim();
  return ['verified', 'missing', 'expired', 'device_mismatch', 'invalid_signature', 'invalid_format', 'invalid_product', 'invalid_key', 'clock_rollback'].includes(status)
    ? status
    : 'unavailable';
}

export function parseDeviceFingerprint(value) {
  const fingerprint = String(value).trim();
  return /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : '';
}

export function parseLicenseSummary(text) {
  const summary = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const separator = rawLine.indexOf('=');
    if (separator <= 0) continue;
    const key = rawLine.slice(0, separator);
    if (['license_id', 'product', 'fingerprint', 'issued_at', 'expires_at', 'features'].includes(key)) {
      summary[key] = rawLine.slice(separator + 1);
    }
  }
  return summary;
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

export function addTarget(targets, packageName) {
  if (!isValidPackageName(packageName) || targets.some((target) => target.packageName === packageName)) {
    return targets;
  }
  return [...targets, { packageName, mode: 'auto', keybox: DEFAULT_KEYBOX }];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character]);
}

if (typeof document !== 'undefined') {
  void import('./kernelsu.js').then(({ exec, getPackagesInfo, listPackages, moduleInfo, toast }) => {
    const state = {
      activeTab: 'targets',
      busy: false,
      keyboxes: [DEFAULT_KEYBOX],
      packages: [],
      patches: { global: emptyPatchLevel(), overrides: {} },
      targets: [],
      bootPropsMode: 'auto',
      autoPackageRefresh: false,
      licenseText: '',
      licenseStatus: 'unavailable',
      deviceFingerprint: '',
      integrityStatus: 'unavailable',
      query: '',
      overridePackage: '',
    };

    const panel = document.querySelector('#panel');
    const status = document.querySelector('#status');
    const tabs = [...document.querySelectorAll('[data-tab]')];

    function setStatus(message, kind = '') {
      status.textContent = message;
      status.className = kind ? `status ${kind}` : 'status';
    }

    async function readFile(path) {
      const result = await exec(`[ -f '${path}' ] && cat '${path}' || true`);
      if (result.errno !== 0) throw new Error(result.stderr || 'Root command failed');
      return result.stdout;
    }

    async function writeFile(path, content) {
      const result = await exec(buildAtomicWriteCommand(path, content));
      if (result.errno !== 0) throw new Error(result.stderr || 'Could not save configuration');
    }

    async function loadState() {
      state.busy = true;
      render();
      try {
        const [targets, patches, bootMode, autoPackageRefresh, licenseText, licenseStatus, deviceFingerprint, keyboxOutput, integrityStatus] = await Promise.all([
          readFile(`${CONFIG_DIR}/target.txt`),
          readFile(`${CONFIG_DIR}/security_patch.txt`),
          readFile(`${CONFIG_DIR}/boot_props_mode`),
          readFile(AUTO_PACKAGE_REFRESH_FILE),
          readFile(`${CONFIG_DIR}/license.lic`),
          readFile(`${CONFIG_DIR}/license_status`),
          readFile(`${CONFIG_DIR}/license_device_fingerprint`),
          exec(`find '${CONFIG_DIR}' -maxdepth 1 -type f -name '*.xml' -printf '%f\\n'`),
          readFile(`${CONFIG_DIR}/module_integrity_status`),
        ]);
        state.targets = parseTargets(targets);
        state.patches = parsePatchLevels(patches);
        state.bootPropsMode = ['auto', 'force', 'disable'].includes(bootMode.trim()) ? bootMode.trim() : 'auto';
        state.autoPackageRefresh = parseAutoPackageRefresh(autoPackageRefresh);
        state.licenseText = licenseText;
        state.licenseStatus = parseLicenseStatus(licenseStatus);
        state.deviceFingerprint = parseDeviceFingerprint(deviceFingerprint);
        state.integrityStatus = parseIntegrityStatus(integrityStatus);
        if (keyboxOutput.errno !== 0) throw new Error(keyboxOutput.stderr || 'Could not list keyboxes');
        state.keyboxes = [...new Set([DEFAULT_KEYBOX, ...keyboxOutput.stdout.split(/\r?\n/).filter(isValidKeyboxName)])].sort();
        const packageNames = listPackages('user');
        state.packages = getPackagesInfo(packageNames) ?? [];
        setStatus('配置已加载', 'success');
      } catch (error) {
        setStatus(`加载失败: ${error.message}`, 'error');
      } finally {
        state.busy = false;
        render();
      }
    }

    async function saveTargets() {
      await writeFile(`${CONFIG_DIR}/target.txt`, serializeTargets(state.targets));
      toast('目标应用已保存');
      await loadState();
    }

    async function savePatches() {
      await writeFile(`${CONFIG_DIR}/security_patch.txt`, serializePatchLevels(state.patches));
      toast('安全补丁配置已保存');
      await loadState();
    }

    async function saveBootMode() {
      await writeFile(`${CONFIG_DIR}/boot_props_mode`, `${state.bootPropsMode}\n`);
      toast('启动属性模式已保存');
      await loadState();
    }

    async function saveAutoPackageRefresh() {
      await writeFile(AUTO_PACKAGE_REFRESH_FILE, serializeAutoPackageRefresh(state.autoPackageRefresh));
      toast(state.autoPackageRefresh ? '已开启自动更新应用包名' : '已关闭自动更新应用包名');
    }

    async function saveLicense() {
      await writeFile(`${CONFIG_DIR}/license.lic`, state.licenseText.trim() ? `${state.licenseText.trim()}\n` : '');
      toast('离线许可证已保存，重启模块后生效');
      await loadState();
    }

    async function refreshPackageCatalog() {
      state.busy = true;
      render();
      try {
        const packageNames = listPackages('user');
        state.packages = getPackagesInfo(packageNames) ?? [];
        setStatus('应用目录已刷新', 'success');
      } catch (error) {
        setStatus(`刷新应用目录失败: ${error.message}`, 'error');
      } finally {
        state.busy = false;
        render();
      }
    }

    function packageLabel(packageName) {
      return String(state.packages.find((item) => item.packageName === packageName)?.appLabel || packageName);
    }

    function options(selected) {
      return state.keyboxes.map((name) => `<option value="${name}"${name === selected ? ' selected' : ''}>${name}</option>`).join('');
    }

    function renderTargets() {
      const query = state.query.trim().toLowerCase();
      const results = state.packages
        .filter((item) => !state.targets.some((target) => target.packageName === item.packageName))
        .filter((item) => !query || item.packageName.toLowerCase().includes(query) || String(item.appLabel || '').toLowerCase().includes(query))
        .slice(0, 8);
      const rows = state.targets.map((target) => `
        <article class="target-row" data-package="${target.packageName}">
          <img src="ksu://icon/${target.packageName}" alt="" class="app-icon">
          <div class="target-name"><strong>${escapeHtml(packageLabel(target.packageName))}</strong><small>${target.packageName}</small></div>
          <select class="mode-select" data-role="mode"><option value="auto"${target.mode === 'auto' ? ' selected' : ''}>自动</option><option value="generate"${target.mode === 'generate' ? ' selected' : ''}>生成</option><option value="patch"${target.mode === 'patch' ? ' selected' : ''}>修补</option></select>
          <select class="keybox-select" data-role="keybox">${options(target.keybox)}</select>
          <button class="icon-button danger" type="button" data-action="remove" aria-label="移除 ${target.packageName}">Remove</button>
        </article>`).join('');
      const searchRows = results.map((item) => `<button type="button" class="search-result" data-action="add" data-package="${item.packageName}"><span>${escapeHtml(item.appLabel)}</span><small>${item.packageName}</small></button>`).join('');
      return `<section class="panel-section"><div class="section-heading"><div><h2>目标应用</h2><p>选择需要模拟硬件证明的用户应用。</p></div><div class="inline-actions"><button type="button" class="icon-button" data-action="refresh-packages" aria-label="刷新应用目录"${state.busy ? ' disabled' : ''}>Refresh</button><button type="button" class="primary" data-action="save-targets"${state.busy ? ' disabled' : ''}>保存</button></div></div><div class="setting-row"><div><h3>自动更新应用包名</h3><p>开启后，每次打开目标应用页都会刷新已安装应用目录，不会改动已保存的目标列表。</p></div><label class="switch"><input type="checkbox" data-role="auto-package-refresh"${state.autoPackageRefresh ? ' checked' : ''}><span aria-hidden="true"></span><b>${state.autoPackageRefresh ? '已开启' : '已关闭'}</b></label></div><label class="field"><span>搜索并添加应用</span><input id="package-search" value="${escapeHtml(state.query)}" placeholder="应用名称或包名" autocomplete="off"></label><div class="search-results">${searchRows || (query ? '<p class="empty">没有匹配的可添加应用。</p>' : '')}</div><div class="target-list">${rows || '<p class="empty">还没有配置目标应用。</p>'}</div></section>`;
    }

    function renderPatchFields(values, prefix) {
      return PATCH_FIELDS.map((field) => `<label class="field compact"><span>${field}</span><input data-patch="${prefix}:${field}" value="${escapeHtml(values[field] || '')}" placeholder="prop, today 或 YYYY-MM-DD"></label>`).join('');
    }

    function renderPatches() {
      const selected = state.overridePackage || Object.keys(state.patches.overrides)[0] || '';
      return `<section class="panel-section"><div class="section-heading"><div><h2>安全补丁</h2><p>留空即不覆盖对应值。</p></div><button type="button" class="primary" data-action="save-patches"${state.busy ? ' disabled' : ''}>保存</button></div><h3>全局配置</h3><div class="field-grid">${renderPatchFields(state.patches.global, 'global')}</div><div class="override-heading"><h3>应用覆盖</h3><select id="override-package"><option value="">选择已配置应用</option>${state.targets.map((target) => `<option value="${target.packageName}"${target.packageName === selected ? ' selected' : ''}>${target.packageName}</option>`).join('')}</select></div>${selected ? `<div class="field-grid">${renderPatchFields(state.patches.overrides[selected] || emptyPatchLevel(), selected)}</div>` : '<p class="empty">选择应用后可配置独立补丁等级。</p>'}</section>`;
    }

    function renderSystem() {
      const integrity = state.integrityStatus === 'verified'
        ? '<div class="integrity-status verified"><strong>模块完整性已验证</strong><p>当前安装内容与构建清单一致。</p></div>'
        : state.integrityStatus === 'modified'
          ? '<div class="integrity-status modified" role="alert"><strong>检测到模块文件被修改</strong><p>module.prop 或核心运行文件与官方构建清单不一致。</p></div>'
          : '<div class="integrity-status unavailable"><strong>模块完整性未验证</strong><p>尚未读取到启动校验结果。</p></div>';
      return `<section class="panel-section"><div class="section-heading"><div><h2>系统设置</h2><p>修改启动状态属性和持久化证明密钥。</p></div></div>${integrity}<fieldset class="segmented"><legend>Boot props mode</legend>${['auto', 'force', 'disable'].map((mode) => `<label><input type="radio" name="boot-mode" value="${mode}"${state.bootPropsMode === mode ? ' checked' : ''}><span>${mode}</span></label>`).join('')}</fieldset><button type="button" class="primary" data-action="save-boot"${state.busy ? ' disabled' : ''}>保存启动属性模式</button><div class="danger-zone"><div><h3>清理持久化密钥</h3><p>删除缓存的证明密钥。使用这些密钥的应用下次会重新注册。</p></div><button type="button" class="outline-danger" data-action="open-clear">清理</button></div></section>`;
    }

    function renderAbout() {
      const summary = parseLicenseSummary(state.licenseText);
      const statusLabels = { verified: '已验证', missing: '未导入', expired: '已过期', device_mismatch: '设备不匹配', invalid_signature: '签名无效', invalid_format: '格式无效', invalid_product: '产品不匹配', invalid_key: '公钥无效', clock_rollback: '系统时间回退', unavailable: '等待模块验证' };
      const status = statusLabels[state.licenseStatus] || statusLabels.unavailable;
      const statusClass = state.licenseStatus === 'verified' ? 'verified' : state.licenseStatus === 'missing' ? 'unavailable' : 'modified';
      const activationRequest = state.licenseStatus === 'verified' ? '' : `<label class="field"><span>设备指纹（SHA-256）</span><input value="${escapeHtml(state.deviceFingerprint || '模块尚未读取到 backup 身份')}" readonly></label>`;
      return `<section class="panel-section about-panel"><div class="section-heading"><div><h2>设备授权</h2><p>离线验证状态与设备绑定激活码。</p></div></div><div class="integrity-status ${statusClass}"><strong>离线授权：${status}</strong><p>${escapeHtml(summary.license_id ? `许可证 ${summary.license_id}` : '复制设备指纹并导入签发的激活码。')}</p></div>${activationRequest}<label class="field"><span>激活码（完整 license.lic）</span><textarea id="license-input" rows="9" spellcheck="false" placeholder="粘贴签发端生成的激活码">${escapeHtml(state.licenseText)}</textarea></label><button type="button" class="primary" data-action="save-license"${state.busy ? ' disabled' : ''}>保存激活码</button></section>`;
    }

    function render() {
      tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === state.activeTab));
      panel.innerHTML = state.busy ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>' : state.activeTab === 'targets' ? renderTargets() : state.activeTab === 'patches' ? renderPatches() : state.activeTab === 'system' ? renderSystem() : renderAbout();
    }

    document.addEventListener('click', async (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) {
        state.activeTab = tab.dataset.tab;
        render();
        if (state.activeTab === 'targets' && state.autoPackageRefresh) void refreshPackageCatalog();
        return;
      }
      const action = event.target.closest('[data-action]');
      if (!action || state.busy) return;
      try {
        if (action.dataset.action === 'add') { state.targets = addTarget(state.targets, action.dataset.package); render(); }
        if (action.dataset.action === 'remove') { const row = action.closest('[data-package]'); state.targets = state.targets.filter((target) => target.packageName !== row.dataset.package); render(); }
        if (action.dataset.action === 'save-targets') await saveTargets();
        if (action.dataset.action === 'refresh-packages') await refreshPackageCatalog();
        if (action.dataset.action === 'save-license') await saveLicense();
        if (action.dataset.action === 'save-patches') await savePatches();
        if (action.dataset.action === 'save-boot') await saveBootMode();
        if (action.dataset.action === 'open-clear') document.querySelector('#clear-dialog').showModal();
        if (action.dataset.action === 'confirm-clear') { const result = await exec(buildClearPersistedKeysCommand()); if (result.errno !== 0) throw new Error(result.stderr || 'Clear failed'); document.querySelector('#clear-dialog').close(); toast('持久化密钥已清理'); }
        if (action.dataset.action === 'cancel-clear') document.querySelector('#clear-dialog').close();
      } catch (error) { setStatus(`操作失败: ${error.message}`, 'error'); }
    });

    document.addEventListener('input', (event) => {
      if (event.target.id === 'package-search') { state.query = event.target.value; render(); }
      if (event.target.id === 'license-input') state.licenseText = event.target.value;
      if (event.target.dataset.patch) { const [scope, field] = event.target.dataset.patch.split(':'); const target = scope === 'global' ? state.patches.global : (state.patches.overrides[scope] ??= emptyPatchLevel()); if (isValidPatchValue(event.target.value)) target[field] = event.target.value.trim(); }
    });
    document.addEventListener('change', (event) => {
      const row = event.target.closest('[data-package]');
      if (row && event.target.dataset.role) { const target = state.targets.find((item) => item.packageName === row.dataset.package); target[event.target.dataset.role] = event.target.value; }
       if (event.target.name === 'boot-mode') state.bootPropsMode = event.target.value;
       if (event.target.dataset.role === 'auto-package-refresh') {
         const previousValue = state.autoPackageRefresh;
         state.autoPackageRefresh = event.target.checked;
         render();
         void saveAutoPackageRefresh().catch((error) => {
           state.autoPackageRefresh = previousValue;
           render();
           setStatus(`保存自动更新开关失败: ${error.message}`, 'error');
         });
       }
      if (event.target.id === 'override-package') { state.overridePackage = event.target.value; if (event.target.value) state.patches.overrides[event.target.value] ??= emptyPatchLevel(); render(); }
    });

    document.querySelector('#refresh-button').addEventListener('click', loadState);
    document.querySelector('#module-id').textContent = moduleInfo() || 'tricky_store';
    render();
    void loadState();
  });
}
