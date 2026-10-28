import { build } from 'vite';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(projectRoot);
const output = resolve(projectRoot, 'dist');
if (dirname(output) !== projectRoot) throw new Error('无效构建输出目录');
let cloudOrigins = [];
try { cloudOrigins = JSON.parse(await readFile('.local/allowed-origins.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!Array.isArray(cloudOrigins) || cloudOrigins.some(origin => {
  try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin || origin.includes('*') || url.username || url.password; } catch { return true; }
})) throw new Error('云端主机必须是明确的 HTTPS origin，不允许通配地址');

function scan() {
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
  if (files.status) throw new Error('无法列出工作树扫描范围');
  const paths = [...new Set(files.stdout.split('\0').filter(Boolean))];
  let result = spawnSync('betterleaks', ['dir', '--redact', '--no-banner', ...paths], { encoding: 'utf8' });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.status && /rename|cross.device|different disk/i.test(result.stderr || '')) {
    result = spawnSync('betterleaks', ['dir', '--redact', '--no-banner', '--regex-engine', 'stdlib', ...paths], { stdio: 'inherit' });
  }
  if (result.error || result.status !== 0) throw new Error('BetterLeaks 未通过；停止发布');
}
await rm(output, { recursive: true, force: true });
for (const mode of ['background', 'content', 'pages']) { await build({ configFile: 'vite.extension.config.ts', mode }); scan(); }
await build({ configFile: 'vite.userscript.config.ts' }); scan();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/extension', { recursive: true });
await writeFile('dist/extension/manifest.json', JSON.stringify({
  manifest_version: 3, name: 'Pixiv Toolbox', version,
  description: '预览、阅读、整理和下载 Pixiv 作品', minimum_chrome_version: '120',
  permissions: ['storage', 'downloads', 'alarms', 'offscreen', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['https://www.pixiv.net/*', 'https://*.pximg.net/*'],
  optional_host_permissions: cloudOrigins.map(origin => `${origin}/*`),
  background: { service_worker: 'background.js', type: 'module' },
  content_scripts: [{ matches: ['https://www.pixiv.net/*'], js: ['content.js'], run_at: 'document_idle' }],
  options_page: 'options.html', action: { default_title: 'Pixiv Toolbox', default_popup: 'options.html' },
  declarative_net_request: { rule_resources: [{ id: 'images', enabled: true, path: 'rules.json' }] },
}, null, 2));
await writeFile('dist/extension/rules.json', JSON.stringify([{ id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.pixiv.net/' }] }, condition: { requestDomains: ['pximg.net'], resourceTypes: ['xmlhttprequest', 'image', 'media', 'other'] } }]));
async function entries(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(files, await entries(join(directory, entry.name), prefix + entry.name + '/'));
    else files[prefix + entry.name] = new Uint8Array(await readFile(join(directory, entry.name)));
  }
  return files;
}
await writeFile(`dist/pixiv-toolbox-${version}-mv3.zip`, zipSync(await entries('dist/extension')));
console.log('两种产物已生成，工作树 BetterLeaks 扫描通过。');
