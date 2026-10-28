import { Zip, ZipPassThrough, strFromU8, strToU8, unzipSync } from 'fflate';
import { filename } from './rules';
import type { ExportFile, Media, Runtime, Settings, Work } from './types';

// Bounds are deliberate failures, never implicit resizing or dropped frames.
const MAX_SOURCE = 128 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 32 * 1024 * 1024;
const MAX_FRAMES = 2000;
const MAX_DURATION = 600_000;
const XMP_KEY = 'XML:com.adobe.xmp';
const JPEG_XMP = 'http://ns.adobe.com/xap/1.0/\0';
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const check = (signal?: AbortSignal) => signal?.throwIfAborted();
const xml = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const sourceUrl = (work: Work) => work.kind === 'novel' ? `https://www.pixiv.net/novel/show.php?id=${work.id}` : `https://www.pixiv.net/artworks/${work.id}`;
const extension = (url: string) => /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'jpg';
const mime = (ext: string) => ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' })[ext] || 'application/octet-stream';
const blob = (bytes: Uint8Array, type: string) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });

async function bytes(runtime: Runtime, url: string, signal?: AbortSignal) {
  check(signal);
  const response = await runtime.request(url, { bytes: true, signal });
  check(signal);
  if (response.status < 200 || response.status >= 300) throw new Error(`媒体下载失败：HTTP ${response.status}`);
  if (!(response.body instanceof Uint8Array)) throw new Error('媒体响应不是二进制数据');
  if (response.body.byteLength > MAX_SOURCE) throw new Error('单个媒体超过 128 MiB 下载上限');
  return response.body;
}

function xmpDescription(work: Work) {
  return `<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(work.title)}</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>${xml(work.userName)}</rdf:li></rdf:Seq></dc:creator><dc:subject><rdf:Bag>${work.tags.map(tag => `<rdf:li>${xml(tag)}</rdf:li>`).join('')}</rdf:Bag></dc:subject><dc:source>${xml(sourceUrl(work))}</dc:source><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xml(work.description || '')}</rdf:li></rdf:Alt></dc:description></rdf:Description>`;
}

function xmpPacket(work: Work, existing?: string) {
  const description = xmpDescription(work);
  if (!existing) return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta>`;
  const end = /<\/(?:[\w.-]+:)?RDF\s*>/.exec(existing);
  if (!end) throw new Error('现有 XMP 格式无法安全合并；关闭元数据选项后可保留原图下载');
  return existing.slice(0, end.index) + description + existing.slice(end.index);
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngXmp(packet: string) {
  const payload = strToU8(`${XMP_KEY}\0\0\0\0\0${packet}`);
  const result = new Uint8Array(payload.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, payload.length);
  result.set(strToU8('iTXt'), 4);
  result.set(payload, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}

/** Inserts metadata without decoding the image; preserves other segments and pixel bytes. */
export function embedXmp(data: Uint8Array, work: Work): Blob {
  if (data[0] === 0x89 && strFromU8(data.subarray(1, 4)) === 'PNG') {
    const parts: BlobPart[] = [data.subarray(0, 8) as Uint8Array<ArrayBuffer>];
    let inserted = false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 8; offset < data.length;) {
      if (offset + 12 > data.length) throw new Error('PNG 块被截断');
      const size = view.getUint32(offset);
      const end = offset + size + 12;
      if (end > data.length) throw new Error('PNG 块长度无效');
      const type = strFromU8(data.subarray(offset + 4, offset + 8));
      const payload = data.subarray(offset + 8, end - 4);
      if (type === 'iTXt' && strFromU8(payload.subarray(0, XMP_KEY.length + 1)) === `${XMP_KEY}\0`) {
        if (inserted) throw new Error('PNG 含有重复 XMP 块，无法安全合并');
        let p = XMP_KEY.length + 1;
        if (payload[p++] !== 0 || payload[p++] !== 0) throw new Error('暂不合并压缩 XMP；关闭元数据选项后可保留原图下载');
        for (let n = 0; n < 2; n++) {
          const endText = payload.indexOf(0, p);
          if (endText < 0) throw new Error('PNG XMP 字段被截断');
          p = endText + 1;
        }
        parts.push(pngXmp(xmpPacket(work, strFromU8(payload.subarray(p)))));
        inserted = true;
      } else {
        if (type === 'IEND' && !inserted) { parts.push(pngXmp(xmpPacket(work))); inserted = true; }
        parts.push(data.subarray(offset, end) as Uint8Array<ArrayBuffer>);
      }
      offset = end;
      if (type === 'IEND') {
        parts.push(data.subarray(offset) as Uint8Array<ArrayBuffer>);
        return new Blob(parts, { type: 'image/png' });
      }
    }
    throw new Error('PNG 缺少 IEND');
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    const parts: BlobPart[] = [data.subarray(0, 2) as Uint8Array<ArrayBuffer>];
    let inserted = false;
    const segment = (existing?: string) => {
      const packet = strToU8(JPEG_XMP + xmpPacket(work, existing));
      if (packet.length > 65533) throw new Error('XMP 超过 JPEG APP1 的 64 KiB 上限');
      const result = new Uint8Array(packet.length + 4);
      result.set([0xff, 0xe1, (packet.length + 2) >>> 8, (packet.length + 2) & 255]);
      result.set(packet, 4);
      return result;
    };
    for (let offset = 2; offset < data.length;) {
      const start = offset;
      if (data[offset++] !== 0xff) throw new Error('JPEG 段标记无效');
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) {
        if (!inserted) parts.push(segment());
        parts.push(data.subarray(start) as Uint8Array<ArrayBuffer>);
        return new Blob(parts, { type: 'image/jpeg' });
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(data.subarray(start, offset) as Uint8Array<ArrayBuffer>); continue; }
      if (offset + 2 > data.length) throw new Error('JPEG 段被截断');
      const size = data[offset] * 256 + data[offset + 1];
      const end = offset + size;
      if (size < 2 || end > data.length) throw new Error('JPEG 段长度无效');
      const payload = data.subarray(offset + 2, end);
      if (marker === 0xe1 && strFromU8(payload.subarray(0, JPEG_XMP.length)) === JPEG_XMP) {
        if (inserted) throw new Error('JPEG 含有重复标准 XMP 段，无法安全合并');
        parts.push(segment(strFromU8(payload.subarray(JPEG_XMP.length))));
        inserted = true;
      } else parts.push(data.subarray(start, end) as Uint8Array<ArrayBuffer>);
      offset = end;
    }
    throw new Error('JPEG 缺少图像数据');
  }
  throw new Error('XMP 元数据仅支持 JPEG 和 PNG；请关闭元数据选项下载此格式');
}

async function archive(entries: AsyncIterable<{ name: string; data: Uint8Array | Blob }>, type = 'application/zip', signal?: AbortSignal) {
  const chunks: Blob[] = [];
  let size = 0;
  let failure: Error | undefined;
  const zip = new Zip((error, chunk) => {
    if (error) { failure = error; return; }
    size += chunk.length;
    if (size > MAX_OUTPUT) { failure = new Error('导出文件超过 256 MiB 上限'); return; }
    chunks.push(blob(chunk, 'application/octet-stream'));
  });
  const names = new Set<string>();
  try {
    for await (const entry of entries) {
      check(signal);
      if (names.has(entry.name)) throw new Error(`压缩包内文件名重复：${entry.name}`);
      names.add(entry.name);
      const file = new ZipPassThrough(entry.name);
      zip.add(file);
      file.push(entry.data instanceof Blob ? new Uint8Array(await entry.data.arrayBuffer()) : entry.data, true);
      if (failure) throw failure;
      await pause();
    }
    check(signal);
    zip.end();
    if (failure) throw failure;
    return new Blob(chunks, { type });
  } finally { zip.terminate(); }
}

async function animationFiles(runtime: Runtime, work: Work, signal?: AbortSignal) {
  const animation = work.animation;
  if (!animation?.frames.length) throw new Error('作品缺少动图帧信息');
  if (animation.frames.length > MAX_FRAMES) throw new Error('动图超过 2000 帧上限');
  let duration = 0;
  const names = new Set<string>();
  for (const frame of animation.frames) {
    if (!frame.file || names.has(frame.file) || !Number.isFinite(frame.delay) || frame.delay <= 0) throw new Error('动图帧名称或时序无效');
    names.add(frame.file);
    duration += frame.delay;
  }
  if (duration > MAX_DURATION) throw new Error('动图超过 10 分钟转换上限');
  const packed = await bytes(runtime, animation.src, signal);
  let unpackedSize = 0;
  const files = unzipSync(packed, { filter: file => {
    if (!names.has(file.name)) return false;
    unpackedSize += file.originalSize;
    if (unpackedSize > MAX_SOURCE) throw new Error('动图解压数据超过 128 MiB 上限');
    return true;
  } });
  check(signal);
  for (const frame of animation.frames) if (!files[frame.file]?.length) throw new Error(`动图 ZIP 缺少帧：${frame.file}`);
  return { files, frames: animation.frames };
}

async function decodeFrame(data: Uint8Array, signal?: AbortSignal) {
  check(signal);
  if (typeof createImageBitmap !== 'function') throw new Error('当前浏览器不支持 ImageBitmap 解码');
  const { width, height } = imageDimensions(data);
  if (!width || !height || width * height > MAX_FRAME_PIXELS) throw new Error('动图单帧超过 16 百万像素上限');
  const image = await createImageBitmap(blob(data, 'application/octet-stream'));
  try {
    check(signal);
    if (!image.width || !image.height || image.width * image.height > MAX_FRAME_PIXELS) throw new Error('动图单帧超过 16 百万像素上限');
    return image;
  } catch (error) { image.close(); throw error; }
}

function imageDimensions(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && strFromU8(data.subarray(1, 4)) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let p = 2; p + 4 <= data.length;) {
      if (data[p++] !== 0xff) break;
      while (data[p] === 0xff) p++;
      const marker = data[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > data.length) break;
      const size = view.getUint16(p);
      if (size < 2 || p + size > data.length) break;
      if (size >= 7 && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: view.getUint16(p + 5), height: view.getUint16(p + 3) };
      p += size;
    }
  }
  throw new Error('动图帧必须是完整的 JPEG 或 PNG 图像');
}

async function convertAnimation(runtime: Runtime, work: Work, format: 'gif' | 'mp4' | 'webm', signal?: AbortSignal) {
  if (format !== 'gif' && typeof VideoEncoder === 'undefined') throw new Error(`${format.toUpperCase()} 转换需要支持 WebCodecs 的安全上下文浏览器`);
  const { files, frames } = await animationFiles(runtime, work, signal);
  const first = await decodeFrame(files[frames[0].file], signal);
  const { width, height } = first;
  first.close();
  if (format === 'gif') {
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法创建动图绘图上下文');
    const encoder = GIFEncoder();
    let elapsed = 0;
    let emittedTicks = 0;
    for (const frame of frames) {
      const image = await decodeFrame(files[frame.file], signal);
      try {
        if (image.width !== width || image.height !== height) throw new Error('动图帧尺寸不一致');
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, width, height).data;
        const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true });
        const indices = applyPalette(rgba, palette, 'rgba4444');
        const transparentIndex = palette.findIndex(color => color[3] === 0);
        elapsed += frame.delay;
        const ticks = Math.round(elapsed / 10) - emittedTicks;
        if (ticks <= 0 || ticks > 65535) throw new Error('GIF 无法精确表示该帧时长；请改用 WebM、MP4 或源 ZIP');
        emittedTicks += ticks;
        encoder.writeFrame(indices, width, height, { palette, delay: ticks * 10, repeat: 0, dispose: 2, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex) });
        if (encoder.bytesView().length > MAX_OUTPUT) throw new Error('GIF 超过 256 MiB 输出上限');
      } finally { image.close(); delete files[frame.file]; }
      await pause();
      check(signal);
    }
    encoder.finish();
    return blob(encoder.bytesView(), 'image/gif');
  }
  const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, VideoSample, VideoSampleSource, canEncodeVideo, QUALITY_HIGH } = await import('mediabunny');
  const codec = format === 'mp4' ? 'avc' : 'vp9';
  if (!await canEncodeVideo(codec, { width, height, quality: QUALITY_HIGH })) throw new Error(`浏览器不支持 ${format.toUpperCase()} 所需的 ${codec.toUpperCase()} 编码器或此尺寸；请选择其他格式`);
  const target = new BufferTarget();
  const output = new Output({ format: format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  let encodedSize = 0;
  const source = new VideoSampleSource({ codec, quality: QUALITY_HIGH, latencyMode: 'quality', onEncodedPacket: packet => {
    encodedSize += packet.byteLength;
    if (encodedSize > MAX_OUTPUT - 1024 * 1024) throw new Error('视频超过 256 MiB 输出上限');
  } });
  output.addVideoTrack(source);
  let elapsed = 0;
  try {
    await output.start();
    for (const frame of frames) {
      const image = await decodeFrame(files[frame.file], signal);
      try {
        if (image.width !== width || image.height !== height) throw new Error('动图帧尺寸不一致');
        const sample = new VideoSample(image, { timestamp: elapsed / 1000, duration: frame.delay / 1000 });
        try { await source.add(sample); } finally { sample.close(); }
        elapsed += frame.delay;
      } finally { image.close(); delete files[frame.file]; }
      await pause();
      check(signal);
    }
    source.close();
    await output.finalize();
    check(signal);
    if (!target.buffer || target.buffer.byteLength > MAX_OUTPUT) throw new Error('视频输出为空或超过 256 MiB 上限');
    return new Blob([target.buffer], { type: `video/${format}` });
  } catch (error) { await output.cancel().catch(() => {}); throw error; }
}

function novelChapters(text: string, title: string) {
  const chapters: { title: string; text: string }[] = [];
  const sections = text.split(/\[chapter:([^\]]*)\]/g);
  if (sections[0].trim() || sections.length === 1) chapters.push({ title, text: sections[0] });
  for (let i = 1; i < sections.length; i += 2) chapters.push({ title: sections[i] || `第 ${chapters.length + 1} 章`, text: sections[i + 1] });
  return chapters;
}

async function novelEpub(runtime: Runtime, work: Work, signal?: AbortSignal) {
  const chapters = novelChapters(work.text || '', work.title);
  const files: { name: string; data: Uint8Array }[] = [];
  const illustrations = new Map<string, { path: string; type: string }>();
  const imageUrls = { ...work.novelImages };
  const tokens = [...(work.text || '').matchAll(/\[((?:uploadedimage|pixivimage):[^\]]+)\]/g)];
  if (work.thumb) imageUrls['__cover'] = work.thumb;
  const requested = new Set(tokens.map(match => match[1]));
  if (work.thumb) requested.add('__cover');
  let size = 0;
  for (const id of requested) {
    if (!imageUrls[id]) continue;
    const url = imageUrls[id];
    const ext = extension(url);
    if (!['jpg', 'png', 'gif'].includes(ext)) throw new Error('EPUB 插图需为 JPEG、PNG 或 GIF 格式');
    const data = await bytes(runtime, url, signal);
    size += data.length;
    if (size > MAX_SOURCE) throw new Error('小说插图合计超过 128 MiB 上限');
    const path = `images/${illustrations.size}.${ext}`;
    illustrations.set(id, { path, type: mime(ext) });
    files.push({ name: `OEBPS/${path}`, data });
  }
  const xhtml = (title: string, content: string) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="und"><head><title>${xml(title)}</title><meta charset="utf-8"/></head><body>${content}</body></html>`;
  const body = (text: string) => text.split(/(\[(?:uploadedimage|pixivimage):[^\]]+\]|\[newpage\])/g).map(part => {
    const image = /^\[((?:uploadedimage|pixivimage):[^\]]+)\]$/.exec(part);
    if (image) {
      const item = illustrations.get(image[1]);
      return item ? `<div><img src="${xml(item.path)}" alt="${xml(image[1])}" style="max-width:100%;height:auto"/></div>` : `<p>${xml(part)}（插图链接不可用）</p>`;
    }
    if (part === '[newpage]') return '<hr/>';
    return part.split(/\r?\n/).map(line => `<p>${xml(line) || '<br/>'}</p>`).join('');
  }).join('');
  const navigation = chapters.map((chapter, i) => `<li><a href="chapter-${i + 1}.xhtml">${xml(chapter.title)}</a></li>`).join('');
  const cover = illustrations.get('__cover');
  const coverContent = cover ? `<img src="${xml(cover.path)}" alt="封面" style="max-width:100%;height:auto"/>` : '';
  files.unshift(
    { name: 'mimetype', data: strToU8('application/epub+zip') },
    { name: 'META-INF/container.xml', data: strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OEBPS/title.xhtml', data: strToU8(xhtml(work.title, `<h1>${xml(work.title)}</h1><p>${xml(work.userName)}</p>${coverContent}<p><a href="${xml(sourceUrl(work))}">Pixiv</a></p>`)) },
    { name: 'OEBPS/nav.xhtml', data: strToU8(xhtml('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${navigation}</ol></nav>`)) },
  );
  for (const [i, chapter] of chapters.entries()) files.push({ name: `OEBPS/chapter-${i + 1}.xhtml`, data: strToU8(xhtml(chapter.title, `<h1>${xml(chapter.title)}</h1>${body(chapter.text)}`)) });
  const manifest = chapters.map((_, i) => `<item id="c${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('') + [...illustrations.entries()].map(([id, item], i) => `<item id="img${i}" href="${xml(item.path)}" media-type="${item.type}"${id === '__cover' ? ' properties="cover-image"' : ''}/>`).join('');
  const modified = new Date(work.updated || Date.now());
  const date = Number.isNaN(modified.getTime()) ? new Date() : modified;
  files.push({ name: 'OEBPS/content.opf', data: strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">pixiv-novel-${xml(work.id)}</dc:identifier><dc:title>${xml(work.title)}</dc:title><dc:creator>${xml(work.userName)}</dc:creator><dc:language>ja</dc:language><dc:source>${xml(sourceUrl(work))}</dc:source><meta property="dcterms:modified">${date.toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine><itemref idref="title"/>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`) });
  return archive((async function* () { yield* files; })(), 'application/epub+zip', signal);
}

export function createMedia(runtime: Runtime): Media {
  return {
    async *export(work, settings, options = {}) {
      const { signal, asset } = options;
      check(signal);
      if (asset) {
        const url = asset === 'avatar' ? work.avatar : work.cover || work.pages[0]?.original;
        if (!url) throw new Error(asset === 'avatar' ? '作者头像不可用' : '封面不可用');
        const ext = extension(url);
        const name = filename(work, settings, undefined, ext).replace(/\.[^/.]+$/, `_${asset}.${ext}`);
        yield { name, data: settings.metadata ? embedXmp(await bytes(runtime, url, signal), work) : url };
        return;
      }
      if (work.kind === 'novel') {
        if (work.text === undefined) throw new Error('小说正文不可用');
        if (work.text.length > 4 * 1024 * 1024) throw new Error('小说正文超过 4 百万字符上限');
        const ext = settings.novelFormat;
        const data = ext === 'epub' ? await novelEpub(runtime, work, signal) : new Blob([`\ufeff${work.title}\n${work.userName}\n${sourceUrl(work)}\n\n${work.text}`], { type: 'text/plain;charset=utf-8' });
        yield { name: filename(work, settings, undefined, ext), data };
        return;
      }
      if (work.animation) {
        const ext = settings.animationFormat;
        if (ext === 'zip') {
          yield { name: filename(work, settings, undefined, 'zip'), data: work.animation.src };
          yield { name: filename(work, settings, undefined, 'json'), data: new Blob([JSON.stringify({ source: sourceUrl(work), frames: work.animation.frames }, null, 2)], { type: 'application/json' }) };
        } else yield { name: filename(work, settings, undefined, ext), data: await convertAnimation(runtime, work, ext, signal) };
        return;
      }
      const pages = options.pages === undefined ? work.pages.map((_, i) => i) : [...new Set(options.pages)];
      if (!pages.length) throw new Error('没有选择任何页面');
      for (const page of pages) if (!Number.isInteger(page) || page < 0 || page >= work.pages.length) throw new Error('选择的页码无效');
      const exportPage = async (page: number): Promise<ExportFile> => {
        check(signal);
        const url = work.pages[page].original;
        return { name: filename(work, settings, page, extension(url)), data: settings.metadata ? embedXmp(await bytes(runtime, url, signal), work) : url };
      };
      if (settings.mangaZip && pages.length > 1) {
        const entries = (async function* () {
          for (const page of pages) {
            const file = await exportPage(page);
            yield { name: file.name.split('/').pop()!, data: typeof file.data === 'string' ? await bytes(runtime, file.data, signal) : file.data };
          }
        })();
        yield { name: filename(work, settings, undefined, 'zip'), data: await archive(entries, 'application/zip', signal) };
      } else for (const page of pages) yield await exportPage(page);
    },
    async frames(work, signal) {
      const { files, frames } = await animationFiles(runtime, work, signal);
      const images: ImageBitmap[] = [];
      const dispose = () => { for (const image of images.splice(0)) image.close(); };
      let pixels = 0;
      try {
        for (const frame of frames) {
          const size = imageDimensions(files[frame.file]);
          if (pixels + size.width * size.height > MAX_PREVIEW_PIXELS) throw new Error('动图预览超过 128 MiB 解码预算；仍可下载源 ZIP 或转换文件');
          const image = await decodeFrame(files[frame.file], signal);
          images.push(image);
          delete files[frame.file];
          pixels += image.width * image.height;
          if (pixels > MAX_PREVIEW_PIXELS) throw new Error('动图预览超过 128 MiB 解码预算；仍可下载源 ZIP 或转换文件');
          await pause();
          check(signal);
        }
        return { images, delays: frames.map(frame => frame.delay), dispose };
      } catch (error) { dispose(); throw error; }
    },
  };
}
