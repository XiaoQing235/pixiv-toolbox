import { defaults, refKey } from './rules';
import { checkedSettings } from './settings';
import type { CloudConfig, Reading, Runtime, Settings } from './types';

const manifestLimit = 16 * 1024 * 1024;
const fileLimit = 256 * 1024 * 1024;
const settingFields = new Set(Object.keys(defaults).filter(field => field !== 'directory'));
interface Snapshot { schema: 1; records: Record<string, unknown> }

function headers(config: CloudConfig): Record<string, string> {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  return { Authorization: `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}` };
}
function cloudRoot(config: CloudConfig): string {
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('WebDAV 地址必须是不含查询参数及登录信息的 HTTPS 目录');
  return url.href.replace(/\/?$/, '/');
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => same(item, b[index]));
  return plain(a) && plain(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function validateReading(id: string, value: unknown) {
  if (!plain(value) || Object.keys(value).some(key => !['account', 'ref', 'title', 'thumb', 'page', 'position', 'at'].includes(key))) throw new Error('同步阅读记录格式不正确');
  const reading = value as unknown as Reading;
  if (!plain(reading.ref) || Object.keys(reading.ref).some(key => !['id', 'kind'].includes(key))
    || typeof reading.account !== 'string' || !/^(guest|[1-9]\d*)$/.test(reading.account)
    || typeof reading.ref.id !== 'string' || !/^[1-9]\d*$/.test(reading.ref.id) || !['illust', 'novel'].includes(reading.ref.kind)
    || id !== `read:${reading.account}:${refKey(reading.ref)}`
    || !Number.isSafeInteger(reading.page) || reading.page < 0 || reading.page > 1_000_000
    || !Number.isFinite(reading.position) || reading.position < 0 || reading.position > 1
    || !Number.isSafeInteger(reading.at) || reading.at < 0 || reading.at > 8.64e15
    || typeof reading.title !== 'string' || reading.title.length > 10000 || typeof reading.thumb !== 'string' || reading.thumb.length > 8192) throw new Error('同步阅读记录的编号或数值不正确');
  if (reading.thumb) {
    const url = new URL(reading.thumb);
    if (url.protocol !== 'https:' || !/(^|\.)pximg\.net$/.test(url.hostname) || url.username || url.password) throw new Error('同步缩略图地址不正确');
  }
}

function validateSnapshot(value: unknown): Snapshot {
  if (!plain(value) || value.schema !== 1 || Object.keys(value).some(key => !['schema', 'records'].includes(key)) || !plain(value.records)) throw new Error('云端数据版本或格式不支持');
  const entries = Object.entries(value.records);
  if (entries.length > 100000) throw new Error('同步记录超过 100000 条');
  const settings: Record<string, unknown> = {};
  for (const [id, record] of entries) {
    if (id.startsWith('setting:') && settingFields.has(id.slice(8))) settings[id.slice(8)] = record;
    else if (id.startsWith('read:')) validateReading(id, record);
    else throw new Error(`同步数据含不支持的记录类型：${id.split(':')[0]}`);
  }
  const checked = checkedSettings({ ...defaults, ...settings });
  for (const [field, original] of Object.entries(settings)) {
    if (!same(original, checked[field as keyof Settings])) throw new Error(`云端设置 ${field} 不符合要求，未作任何修改`);
    if ((field === 'folder' || field === 'filename') && typeof original === 'string') {
      const path = original.replaceAll('\\', '/');
      if (path.length > 1024 || /^(?:\/|[a-z]:)/i.test(path) || path.split('/').includes('..') || /[\u0000-\u001f]/.test(path)) throw new Error('云端保存路径不符合要求');
    }
  }
  return value as unknown as Snapshot;
}

function manifestText(value: Snapshot): string {
  const text = JSON.stringify(value);
  if (text.length > manifestLimit || new TextEncoder().encode(text).byteLength > manifestLimit) throw new Error('同步清单超过 16 MiB');
  return text;
}
const digest = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

export async function uploadFile(runtime: Runtime, config: CloudConfig, name: string, data: Blob | string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const root = cloudRoot(config);
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '..' || part === '.' || /[\u0000-\u001f]/.test(part))) throw new Error('上传文件名不正确');
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof data === 'string') {
    const response = await runtime.request(data, { bytes: true, signal });
    signal?.throwIfAborted();
    if (response.status !== 200 || !(response.body instanceof Uint8Array)) throw new Error(`上传原文件读取失败 (${response.status})`);
    if (response.body.byteLength > fileLimit) throw new Error('文件超过 256 MiB 内存处理上限');
    bytes = new Uint8Array(response.body);
  } else {
    if (data.size > fileLimit) throw new Error('文件超过 256 MiB 内存处理上限');
    bytes = new Uint8Array(await data.arrayBuffer());
  }
  signal?.throwIfAborted();
  const expected = { size: bytes.byteLength, hash: await digest(bytes) };
  signal?.throwIfAborted();
  for (let index = 1; index < parts.length; index++) {
    const response = await runtime.request(root + parts.slice(0, index).map(encodeURIComponent).join('/') + '/', { method: 'MKCOL', headers: headers(config), signal });
    signal?.throwIfAborted();
    if (![201, 405].includes(response.status)) throw new Error(`云目录创建失败 (${response.status})`);
  }
  const endpoint = root + parts.map(encodeURIComponent).join('/');
  const response = await runtime.request(endpoint, { method: 'PUT', headers: { ...headers(config), 'If-None-Match': '*' }, body: bytes, signal });
  signal?.throwIfAborted();
  if ([200, 201, 204].includes(response.status)) return;
  if (response.status !== 412) throw new Error(`上传失败 (${response.status})`);
  let existing: Uint8Array<ArrayBuffer>;
  try {
    const verification = await runtime.request(endpoint, { headers: headers(config), bytes: true, signal });
    signal?.throwIfAborted();
    if (verification.status !== 200 || !(verification.body instanceof Uint8Array) || verification.body.byteLength > fileLimit) throw new Error('远端文件无法读取');
    existing = new Uint8Array(verification.body);
  } catch {
    signal?.throwIfAborted();
    throw new Error('上传结果待核实：无法读取远端同名文件，请稍后重试核实');
  }
  if (existing.byteLength !== expected.size) throw new Error('云端同名文件内容不同，未覆盖，请调整目录或文件名');
  const actual = await digest(existing);
  signal?.throwIfAborted();
  if (!actual.every((byte, index) => byte === expected.hash[index])) throw new Error('云端同名文件内容不同，未覆盖，请调整目录或文件名');
}
export function mergeSnapshots(local: Snapshot, remote: Snapshot, base?: Snapshot, choice?: 'local' | 'remote'): Snapshot {
  const records: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(local.records), ...Object.keys(remote.records)])) {
    const a = local.records[id], b = remote.records[id], previous = base?.records[id];
    let value: unknown;
    if (same(a, b) || same(b, previous)) value = a;
    else if (same(a, previous)) value = b;
    else if (id.startsWith('read:')) value = Number((a as { at?: number })?.at || 0) >= Number((b as { at?: number })?.at || 0) ? a : b;
    else if (choice) value = choice === 'local' ? a : b;
    else throw new Error('同步设置存在冲突。请明确选择使用本机或云端设置，再次同步。');
    if (value !== undefined) records[id] = value;
  }
  return { schema: 1, records };
}
export async function syncData(runtime: Runtime, choice?: 'local' | 'remote'): Promise<void> {
  const config = await runtime.store.get<CloudConfig>('cloud');
  if (!config?.url) throw new Error('请先配置 WebDAV 连接');
  const endpoint = `${cloudRoot(config)}pixiv-toolbox.json`;
  const response = await runtime.request(endpoint, { headers: headers(config) });
  if (![200, 404].includes(response.status)) throw new Error(`读取云端数据失败 (${response.status})`);
  let remote: Snapshot = { schema: 1, records: {} };
  if (response.status === 200) {
    if (typeof response.body !== 'string') throw new Error('云端清单不是文本');
    if (response.body.length > manifestLimit || new TextEncoder().encode(response.body).byteLength > manifestLimit) throw new Error('同步清单超过 16 MiB');
    remote = validateSnapshot(JSON.parse(response.body));
  }
  const records: Record<string, unknown> = {};
  const settings = checkedSettings(await runtime.store.get('settings') || defaults);
  for (const field of settingFields) records[`setting:${field}`] = settings[field as keyof Settings];
  for (const row of await runtime.store.list('read:')) records[row.id] = row.value;
  const local = validateSnapshot({ schema: 1, records });
  const previous = await runtime.store.get('sync-base');
  const base = previous === undefined ? undefined : validateSnapshot(previous);
  const merged = validateSnapshot(mergeSnapshots(local, remote, base, choice));
  const payload = manifestText(merged);
  const mergedSettings = checkedSettings({ ...defaults, ...Object.fromEntries(Object.entries(merged.records).filter(([id]) => id.startsWith('setting:')).map(([id, value]) => [id.slice(8), value])), directory: settings.directory });
  const etag = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'etag')?.[1];
  if (response.status === 200 && !etag) throw new Error('此服务未提供 ETag，不能安全进行双向同步；可使用本地备份');
  const result = await runtime.request(endpoint, { method: 'PUT', headers: { ...headers(config), 'Content-Type': 'application/json', ...(response.status === 200 ? { 'If-Match': etag! } : { 'If-None-Match': '*' }) }, body: payload });
  if (![200, 201, 204].includes(result.status)) throw new Error([409, 412].includes(result.status) ? '云端刚被其他设备更新，请重新同步' : `同步写入失败 (${result.status})`);
  await runtime.store.set('sync-recovery', { records });
  for (const id of Object.keys(records)) if (id.startsWith('read:') && !Object.hasOwn(merged.records, id)) await runtime.store.remove(id);
  for (const [id, value] of Object.entries(merged.records)) if (id.startsWith('read:')) await runtime.store.set(id, value);
  await runtime.store.set('settings', mergedSettings);
  await runtime.store.set('sync-base', merged);
}
