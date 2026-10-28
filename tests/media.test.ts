import { describe, expect, it, vi, afterEach } from 'vitest';
import { crc32 } from 'node:zlib';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { createMedia, embedXmp } from '../src/media';
import * as rules from '../src/rules';
import type { Runtime, Settings, Work } from '../src/types';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64'));
const work: Work = { id: '42', kind: 'illust', title: 'A < B & C', userId: '7', userName: '作者', thumb: '', pages: [{ original: 'https://i.pximg.net/test_p0.png', regular: '', width: 1, height: 1 }], tags: ['safe', '<tag>'], bookmarkCount: 0, bookmarked: false, following: false, restricted: 0, ai: false, updated: '2026-01-01T00:00:00Z' };
const settings: Settings = { hover: true, hoverRatio: 0.5, theme: 'auto', preload: 1, hideAds: false, filename: '{id}_{title}', folder: '', metadata: false, animationFormat: 'zip', novelFormat: 'epub', mangaZip: false, concurrency: 1, filter: { minBookmarks: 0, hideBookmarked: false, hideFollowing: false, hideRead: false, hideAdult: false, hideAI: false, users: [], tags: [] } };
const runtime = (data = png) => ({ mode: 'extension', request: vi.fn(async () => ({ status: 200, headers: {}, body: data })) }) as unknown as Runtime;
async function collect(source: AsyncIterable<unknown>) { const result = []; for await (const item of source) result.push(item); return result; }
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
function chunks(data: Uint8Array) {
  const result: { type: string; data: Uint8Array; all: Uint8Array; crc: number }[] = [];
  for (let offset = 8; offset < data.length;) {
    const size = view(data).getUint32(offset);
    result.push({ type: strFromU8(data.subarray(offset + 4, offset + 8)), data: data.subarray(offset + 8, offset + 8 + size), all: data.subarray(offset, offset + 12 + size), crc: view(data).getUint32(offset + 8 + size) });
    offset += size + 12;
  }
  return result;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('image metadata', () => {
  it('adds valid PNG XMP and preserves every existing chunk byte-for-byte', async () => {
    const original = chunks(png);
    const output = new Uint8Array(await embedXmp(png, work).arrayBuffer());
    const written = chunks(output);
    const xmp = written.find(chunk => chunk.type === 'iTXt')!;
    expect(xmp).toBeDefined();
    expect(xmp.crc).toBe(crc32(xmp.all.subarray(4, xmp.all.length - 4)));
    expect(strFromU8(xmp.data)).toContain('A &lt; B &amp; C');
    expect(strFromU8(xmp.data)).toContain('作者');
    expect(written.filter(chunk => chunk.type !== 'iTXt').map(chunk => chunk.all)).toEqual(original.map(chunk => chunk.all));
    expect(written.at(-1)?.type).toBe('IEND');
  });

  it('preserves JPEG EXIF, unknown segments, and entropy-coded scan bytes', async () => {
    const headers = [0xff, 0xd8, 0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0, 0xff, 0xee, 0, 5, 17, 23, 42];
    const scan = Uint8Array.from([0xff, 0xda, 0, 2, 13, 0xff, 0, 19, 0xff, 0xd0, 27, 0xff, 0xd9]);
    const input = Uint8Array.from([...headers, ...scan]);
    const output = new Uint8Array(await embedXmp(input, work).arrayBuffer());
    expect(output.subarray(0, headers.length)).toEqual(Uint8Array.from(headers));
    expect(output.subarray(-scan.length)).toEqual(scan);
    expect(strFromU8(output)).toContain('http://ns.adobe.com/xap/1.0/');
    expect(strFromU8(output)).toContain('https://www.pixiv.net/artworks/42');
    expect(input).toEqual(Uint8Array.from([...headers, ...scan]));
  });

  it('merges existing XMP without discarding unknown metadata', async () => {
    const old = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:custom="urn:test" custom:keep="unchanged"/></rdf:RDF></x:xmpmeta>';
    const packet = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0${old}`);
    const input = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (packet.length + 2) >> 8, (packet.length + 2) & 255, ...packet, 0xff, 0xda, 0, 2, 12, 0xff, 0xd9]);
    const result = strFromU8(new Uint8Array(await embedXmp(input, work).arrayBuffer()));
    expect(result).toContain('custom:keep="unchanged"');
    expect(result).toContain('A &lt; B &amp; C');
    expect(result.match(/http:\/\/ns\.adobe\.com\/xap\/1\.0\//g)).toHaveLength(2); // One packet prefix and one namespace.
  });
});

describe('exports', () => {
  it('uses the shared naming rules and passes through original URLs without fetching', async () => {
    const host = runtime();
    const naming = vi.spyOn(rules, 'filename');
    const file = await createMedia(host).export(work, settings).next();
    expect(file.value?.data).toBe(work.pages[0].original);
    expect(naming).toHaveBeenCalledWith(work, settings, 0, 'png');
    expect(host.request).not.toHaveBeenCalled();
  });

  it('keeps the ugoira source ZIP and exact per-frame timing', async () => {
    const animation = { src: 'https://i.pximg.net/ugoira.zip', frames: [{ file: '000000.jpg', delay: 37 }, { file: '000001.jpg', delay: 113 }] };
    const host = runtime();
    const files = [];
    for await (const file of createMedia(host).export({ ...work, animation }, settings)) files.push(file);
    expect(files).toHaveLength(2);
    expect(files[0].data).toBe(animation.src);
    expect(files[0].name).toMatch(/\.zip$/);
    expect(files[1].name).toMatch(/\.json$/);
    expect(JSON.parse(await (files[1].data as Blob).text()).frames).toEqual(animation.frames);
    expect(host.request).not.toHaveBeenCalled();
  });

  it('creates an EPUB with stored first mimetype, escaped chapters, navigation, and embedded illustrations', async () => {
    const novel: Work = { ...work, kind: 'novel', pages: [], text: 'Preface <script>alert(1)</script>\n[chapter:One & Two]Hello[uploadedimage:8]\n[newpage]next[chapter:End]完', novelImages: { 'uploadedimage:8': 'https://i.pximg.net/8.png' } };
    const item = (await createMedia(runtime()).export(novel, settings).next()).value!;
    const data = new Uint8Array(await (item.data as Blob).arrayBuffer());
    expect(view(data).getUint32(0, true)).toBe(0x04034b50);
    expect(view(data).getUint16(8, true)).toBe(0); // stored, as EPUB requires
    const nameLength = view(data).getUint16(26, true);
    expect(strFromU8(data.subarray(30, 30 + nameLength))).toBe('mimetype');
    expect(view(data).getUint16(28, true)).toBe(0); // no mimetype extra field
    const files = unzipSync(data);
    expect(strFromU8(files.mimetype)).toBe('application/epub+zip');
    expect(strFromU8(files['META-INF/container.xml'])).toContain('OEBPS/content.opf');
    expect(strFromU8(files['OEBPS/content.opf'])).toContain('media-type="image/png"');
    expect(strFromU8(files['OEBPS/nav.xhtml'])).toContain('One &amp; Two');
    expect(strFromU8(files['OEBPS/chapter-1.xhtml'])).toContain('&lt;script&gt;');
    expect(strFromU8(files['OEBPS/chapter-1.xhtml'])).not.toContain('<script>');
    expect(strFromU8(files['OEBPS/chapter-2.xhtml'])).toContain('src="images/0.png"');
    expect(files['OEBPS/images/0.png']).toEqual(png);
    expect(novel.novelImages).toEqual({ 'uploadedimage:8': 'https://i.pximg.net/8.png' });
  });

  it('exports selected manga pages in the requested order and rejects invalid selections', async () => {
    const host = runtime();
    const manga = { ...work, pages: [...work.pages, { ...work.pages[0], original: 'https://i.pximg.net/test_p1.png' }] };
    const config = { ...settings, mangaZip: true };
    const file = (await createMedia(host).export(manga, config, { pages: [1, 0] }).next()).value!;
    const files = unzipSync(new Uint8Array(await (file.data as Blob).arrayBuffer()));
    expect(Object.keys(files)).toEqual([rules.filename(manga, config, 1, 'png'), rules.filename(manga, config, 0, 'png')]);
    expect(host.request).toHaveBeenNthCalledWith(1, manga.pages[1].original, expect.anything());
    await expect(collect(createMedia(host).export(manga, config, { pages: [2] }))).rejects.toThrow('页码');
  });
});

describe('frame lifecycle', () => {
  const animation = { src: 'https://i.pximg.net/ugoira.zip', frames: [{ file: '0.png', delay: 40 }, { file: '1.png', delay: 90 }] };
  const zip = zipSync({ '0.png': png, '1.png': png });

  it('returns exact delays and releases all bitmaps with idempotent disposal', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    const result = await createMedia(runtime(zip)).frames({ ...work, animation });
    expect(result.images).toHaveLength(2);
    expect(result.delays).toEqual([40, 90]);
    result.dispose();
    result.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('releases an already-decoded image when cancellation arrives during decoding', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { controller.abort(); return { width: 1, height: 1, close }; }));
    await expect(createMedia(runtime(zip)).frames({ ...work, animation }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects oversized image headers before allocating a bitmap', async () => {
    const huge = png.slice();
    view(huge).setUint32(16, 100_000);
    view(huge).setUint32(20, 100_000);
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(createMedia(runtime(zipSync({ '0.png': huge, '1.png': png }))).frames({ ...work, animation })).rejects.toThrow('预算');
    expect(decode).not.toHaveBeenCalled();
  });
});
