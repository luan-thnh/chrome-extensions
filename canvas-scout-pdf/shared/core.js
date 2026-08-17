(() => {
  'use strict';

  const encoder = new TextEncoder();

  function sanitizeFilename(value, fallback = 'canvora-document') {
    const clean = String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 120);
    return clean || fallback;
  }

  function parsePageRange(input, total) {
    total = Math.max(0, Number(total) || 0);
    const text = String(input || '').trim().toLowerCase();
    if (!text || text === 'all' || text === '*') {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    const selected = new Set();
    for (const rawPart of text.split(',')) {
      const part = rawPart.trim();
      if (!part) continue;

      const range = part.match(/^(\d*)\s*-\s*(\d*)$/);
      if (range) {
        let start = range[1] ? Number(range[1]) : 1;
        let end = range[2] ? Number(range[2]) : total;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        start = Math.max(1, Math.min(total, start));
        end = Math.max(1, Math.min(total, end));
        if (start > end) [start, end] = [end, start];
        for (let i = start; i <= end; i += 1) selected.add(i);
        continue;
      }

      const single = Number(part);
      if (Number.isInteger(single) && single >= 1 && single <= total) selected.add(single);
    }

    return [...selected].sort((a, b) => a - b);
  }

  function dataUrlToBytes(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/);
    if (!match) throw new Error('Unsupported data URL');
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1] || 'application/octet-stream', bytes };
  }

  function ascii(value) {
    return encoder.encode(value);
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function fmt(n) {
    return Number(n.toFixed(3)).toString();
  }

  function getPdfPlacement(page, mode) {
    if (mode !== 'a4') {
      // Match jsPDF({ unit: 'px', hotfixes: ['px_scaling'] }).
      // PDF coordinates are points (72/in), CSS pixels are 96/in, so 1 px = 0.75 pt.
      // Using raw pixel counts as points makes PDF viewers upscale a 950px bitmap to
      // ~1267 CSS px at 100%, which is exactly why the previous build looked blurry.
      const pxToPt = 72 / 96;
      return {
        pageW: page.width * pxToPt,
        pageH: page.height * pxToPt,
        x: 0,
        y: 0,
        drawW: page.width * pxToPt,
        drawH: page.height * pxToPt,
      };
    }

    const portrait = page.height >= page.width;
    const pageW = portrait ? 595.28 : 841.89;
    const pageH = portrait ? 841.89 : 595.28;
    const margin = 18;
    const scale = Math.min((pageW - margin * 2) / page.width, (pageH - margin * 2) / page.height);
    const drawW = page.width * scale;
    const drawH = page.height * scale;
    return {
      pageW,
      pageH,
      drawW,
      drawH,
      x: (pageW - drawW) / 2,
      y: (pageH - drawH) / 2,
    };
  }

  async function deflateBytes(bytes) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('Lossless PDF requires CompressionStream support in this Chrome version.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflateBytes(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Lossless PDF requires DecompressionStream support in this Chrome version.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readU32BE(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
  }

  function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  async function decodePngToRgb(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every((v, i) => bytes[i] === v)) {
      throw new Error('Invalid PNG signature');
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette = null;
    let transparency = null;
    const idat = [];

    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = readU32BE(bytes, offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) throw new Error('Corrupt PNG chunk');
      const data = bytes.slice(dataStart, dataEnd);

      if (type === 'IHDR') {
        width = readU32BE(data, 0);
        height = readU32BE(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'tRNS') {
        transparency = data;
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset = dataEnd + 4;
    }

    if (!width || !height || !idat.length) throw new Error('PNG is missing IHDR/IDAT');
    if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
    if (interlace !== 0) throw new Error('Interlaced PNG is not supported in lossless mode');

    const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsByType[colorType];
    if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);
    if (colorType === 3 && !palette) throw new Error('Indexed PNG is missing palette');

    const packed = concatBytes(idat);
    const raw = await inflateBytes(packed);
    const rowBytes = width * channels;
    const expected = height * (rowBytes + 1);
    if (raw.length < expected) throw new Error('PNG scanline data is truncated');

    const recon = new Uint8Array(height * rowBytes);
    let src = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[src++];
      const rowOffset = y * rowBytes;
      const prevOffset = (y - 1) * rowBytes;
      for (let x = 0; x < rowBytes; x += 1) {
        const value = raw[src++];
        const left = x >= channels ? recon[rowOffset + x - channels] : 0;
        const up = y > 0 ? recon[prevOffset + x] : 0;
        const upLeft = y > 0 && x >= channels ? recon[prevOffset + x - channels] : 0;
        let decoded;
        if (filter === 0) decoded = value;
        else if (filter === 1) decoded = value + left;
        else if (filter === 2) decoded = value + up;
        else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
        else if (filter === 4) decoded = value + paethPredictor(left, up, upLeft);
        else throw new Error(`Unsupported PNG filter: ${filter}`);
        recon[rowOffset + x] = decoded & 0xff;
      }
    }

    const rgb = new Uint8Array(width * height * 3);
    const blend = (c, a) => Math.round((c * a + 255 * (255 - a)) / 255);
    for (let p = 0, d = 0; p < width * height; p += 1) {
      const i = p * channels;
      let r, g, b, a = 255;
      if (colorType === 0) {
        r = g = b = recon[i];
      } else if (colorType === 2) {
        r = recon[i]; g = recon[i + 1]; b = recon[i + 2];
      } else if (colorType === 3) {
        const idx = recon[i];
        const pi = idx * 3;
        r = palette[pi] ?? 0; g = palette[pi + 1] ?? 0; b = palette[pi + 2] ?? 0;
        a = transparency?.[idx] ?? 255;
      } else if (colorType === 4) {
        r = g = b = recon[i]; a = recon[i + 1];
      } else {
        r = recon[i]; g = recon[i + 1]; b = recon[i + 2]; a = recon[i + 3];
      }
      rgb[d++] = a === 255 ? r : blend(r, a);
      rgb[d++] = a === 255 ? g : blend(g, a);
      rgb[d++] = a === 255 ? b : blend(b, a);
    }
    return { width, height, rgb };
  }

  async function imagePayload(page) {
    const { mime, bytes } = dataUrlToBytes(page.dataUrl);
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      return {
        bytes,
        dictionary: `/Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      };
    }

    if (mime === 'image/png') {
      const decoded = await decodePngToRgb(bytes);
      const compressed = await deflateBytes(decoded.rgb);
      return {
        bytes: compressed,
        dictionary: `/Width ${decoded.width} /Height ${decoded.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      };
    }

    throw new Error(`Unsupported PDF page image: ${mime}. Use PNG or JPEG.`);
  }

  async function makePdfFromImages(pages, { sizeMode = 'source' } = {}) {
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('No pages to export');
    const objects = new Map();
    const pageRefs = [];

    objects.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const imageId = 3 + index * 3;
      const contentId = imageId + 1;
      const pageId = imageId + 2;
      pageRefs.push(`${pageId} 0 R`);

      const payload = await imagePayload(page);
      const imageHead = ascii(`<< /Type /XObject /Subtype /Image ${payload.dictionary} /Length ${payload.bytes.length} >>\nstream\n`);
      const imageTail = ascii('\nendstream');
      objects.set(imageId, concatBytes([imageHead, payload.bytes, imageTail]));

      const p = getPdfPlacement(page, sizeMode);
      const content = `q\n${fmt(p.drawW)} 0 0 ${fmt(p.drawH)} ${fmt(p.x)} ${fmt(p.y)} cm\n/Im0 Do\nQ\n`;
      const contentBytes = ascii(content);
      objects.set(contentId, concatBytes([
        ascii(`<< /Length ${contentBytes.length} >>\nstream\n`),
        contentBytes,
        ascii('endstream'),
      ]));

      objects.set(pageId, ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.pageW)} ${fmt(p.pageH)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
      ));
    }

    objects.set(2, ascii(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`));

    const maxId = 2 + pages.length * 3;
    const chunks = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    const offsets = new Array(maxId + 1).fill(0);
    let cursor = chunks[0].length;

    for (let id = 1; id <= maxId; id += 1) {
      const body = objects.get(id);
      offsets[id] = cursor;
      const head = ascii(`${id} 0 obj\n`);
      const tail = ascii('\nendobj\n');
      chunks.push(head, body, tail);
      cursor += head.length + body.length + tail.length;
    }

    const xrefOffset = cursor;
    const xrefLines = ['xref', `0 ${maxId + 1}`, '0000000000 65535 f '];
    for (let id = 1; id <= maxId; id += 1) {
      xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n `);
    }
    const trailer = `${xrefLines.join('\n')}\ntrailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(ascii(trailer));

    return new Blob([concatBytes(chunks)], { type: 'application/pdf' });
  }

  // Backward-compatible alias for old tests/callers.
  function makePdfFromJpegs(pages, options) {
    return makePdfFromImages(pages, options);
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, true);
    return b;
  }

  function u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    return b;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = (year - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  function makeStoreZip(files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('No files to zip');
    const locals = [];
    const central = [];
    let offset = 0;
    const stamp = dosDateTime();

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
      const crc = crc32(bytes);
      const localHeader = concatBytes([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.day),
        u32(crc), u32(bytes.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
      ]);
      locals.push(localHeader, bytes);

      central.push(concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.day),
        u32(crc), u32(bytes.length), u32(bytes.length), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), nameBytes,
      ]));
      offset += localHeader.length + bytes.length;
    }

    const centralBytes = concatBytes(central);
    const end = concatBytes([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralBytes.length), u32(offset), u16(0),
    ]);
    return new Blob([...locals, centralBytes, end], { type: 'application/zip' });
  }

  globalThis.CanvoraCore = {
    sanitizeFilename,
    parsePageRange,
    dataUrlToBytes,
    makePdfFromImages,
    makePdfFromJpegs,
    makeStoreZip,
    crc32,
  };
})();
