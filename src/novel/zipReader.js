// Minimal on-demand ZIP reader: reads the central directory from the end of the File and
// slices one entry at a time, so a large archive is never loaded into memory as a whole.
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 22 + 0xffff;
const UINT32_MAX = 0xffffffff;

export class ZipFormatError extends Error {}

async function readBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readUint64(data, offset) {
    const value = data.getUint32(offset, true) + data.getUint32(offset + 4, true) * 2 ** 32;
    if (!Number.isSafeInteger(value)) throw new ZipFormatError('ZIP 文件过大，无法读取');
    return value;
}

let gbkDecoder;
function getGbkDecoder() {
    if (gbkDecoder === undefined) {
        try {
            gbkDecoder = new TextDecoder('gbk');
        } catch {
            gbkDecoder = null;
        }
    }
    return gbkDecoder;
}

/**
 * Decode a ZIP entry name. The UTF-8 flag (bit 11) is authoritative; otherwise try strict UTF-8
 * (most phone and macOS tools omit the flag) and fall back to GBK used by Chinese Windows tools.
 */
export function decodeFileName(bytes, utf8Flag = false) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (utf8Flag) return new TextDecoder('utf-8').decode(data);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        const gbk = getGbkDecoder();
        if (gbk) return gbk.decode(data);
        return new TextDecoder('utf-8').decode(data);
    }
}

function findEndOfCentralDirectory(tail) {
    const data = view(tail);
    for (let offset = tail.length - 22; offset >= 0; offset--) {
        if (data.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
        const commentLength = data.getUint16(offset + 20, true);
        if (offset + 22 + commentLength <= tail.length) return offset;
    }
    return -1;
}

function parseExtraFields(extra) {
    const fields = new Map();
    const data = view(extra);
    let offset = 0;
    while (offset + 4 <= extra.length) {
        const id = data.getUint16(offset, true);
        const size = data.getUint16(offset + 2, true);
        if (offset + 4 + size > extra.length) break;
        fields.set(id, extra.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
    }
    return fields;
}

function parseCentralDirectory(bytes, count) {
    const data = view(bytes);
    const entries = [];
    let offset = 0;
    for (let index = 0; index < count; index++) {
        if (offset + 46 > bytes.length || data.getUint32(offset, true) !== CENTRAL_SIGNATURE)
            throw new ZipFormatError('ZIP 目录已损坏');
        const flags = data.getUint16(offset + 8, true);
        const method = data.getUint16(offset + 10, true);
        let compressedSize = data.getUint32(offset + 20, true);
        let uncompressedSize = data.getUint32(offset + 24, true);
        const nameLength = data.getUint16(offset + 28, true);
        const extraLength = data.getUint16(offset + 30, true);
        const commentLength = data.getUint16(offset + 32, true);
        const externalAttributes = data.getUint32(offset + 38, true);
        let localHeaderOffset = data.getUint32(offset + 42, true);
        const nameStart = offset + 46;
        const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
        const extra = parseExtraFields(bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength));
        const zip64 = extra.get(0x0001);
        if (zip64) {
            const zipData = view(zip64);
            let cursor = 0;
            const next = () => {
                if (cursor + 8 > zip64.length) throw new ZipFormatError('ZIP64 信息已损坏');
                const value = readUint64(zipData, cursor);
                cursor += 8;
                return value;
            };
            if (uncompressedSize === UINT32_MAX) uncompressedSize = next();
            if (compressedSize === UINT32_MAX) compressedSize = next();
            if (localHeaderOffset === UINT32_MAX) localHeaderOffset = next();
        }
        let name = decodeFileName(nameBytes, (flags & 0x0800) !== 0);
        const unicodePath = extra.get(0x7075);
        if (unicodePath && unicodePath.length > 5 && unicodePath[0] === 1)
            name = new TextDecoder('utf-8').decode(unicodePath.subarray(5));
        name = name.replace(/\\/g, '/');
        entries.push({
            name,
            dir: name.endsWith('/') || (externalAttributes & 0x10) !== 0,
            encrypted: (flags & 0x0001) !== 0,
            method,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
        });
        offset = nameStart + nameLength + extraLength + commentLength;
    }
    return entries;
}

function limitStream(maxBytes) {
    let total = 0;
    return new TransformStream({
        transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > maxBytes) controller.error(new ZipFormatError('ZIP 中的文件超过大小上限'));
            else controller.enqueue(chunk);
        },
    });
}

export function canReadZipOnDemand() {
    if (typeof Blob !== 'function' || typeof Blob.prototype.slice !== 'function') return false;
    if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') return false;
    try {
        new DecompressionStream('deflate-raw');
        return true;
    } catch {
        return false;
    }
}

/** Fallback for browsers without DecompressionStream: same interface backed by JSZip (loads the ZIP in memory). */
export async function openZipWithJSZip(file, JSZip) {
    const archive = await JSZip.loadAsync(file, { decodeFileName: (bytes) => decodeFileName(bytes, false) });
    const entries = Object.values(archive.files).map((entry) => ({
        name: String(entry.name).replace(/\\/g, '/'),
        dir: !!entry.dir,
        encrypted: false,
        method: -1,
        compressedSize: Number(entry._data?.compressedSize) || 0,
        uncompressedSize: Number(entry._data?.uncompressedSize) || 0,
        source: entry,
    }));
    async function readEntry(entry, { maxBytes = Infinity, type = '' } = {}) {
        if (entry.uncompressedSize > maxBytes) throw new ZipFormatError('ZIP 中的文件超过大小上限');
        const blob = await entry.source.async('blob');
        if (blob.size > maxBytes) throw new ZipFormatError('ZIP 中的文件超过大小上限');
        return type ? blob.slice(0, blob.size, type) : blob;
    }
    return { entries, readEntry };
}

/** Open a ZIP File/Blob without reading its contents. Each entry is read later via readEntry. */
export async function openZip(file) {
    const size = Number(file?.size) || 0;
    if (size < 22) throw new ZipFormatError('不是有效的 ZIP 文件');
    const tailStart = Math.max(0, size - MAX_EOCD_SEARCH);
    const tail = await readBytes(file, tailStart, size);
    const eocd = findEndOfCentralDirectory(tail);
    if (eocd < 0) throw new ZipFormatError('不是有效的 ZIP 文件');
    const eocdData = view(tail.subarray(eocd));
    let count = eocdData.getUint16(10, true);
    let directorySize = eocdData.getUint32(12, true);
    let directoryOffset = eocdData.getUint32(16, true);
    if (count === 0xffff || directorySize === UINT32_MAX || directoryOffset === UINT32_MAX) {
        const locatorOffset = tailStart + eocd - 20;
        if (locatorOffset < 0) throw new ZipFormatError('ZIP64 目录已损坏');
        const locator = view(await readBytes(file, locatorOffset, locatorOffset + 20));
        if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) throw new ZipFormatError('ZIP64 目录已损坏');
        const recordOffset = readUint64(locator, 8);
        const record = view(await readBytes(file, recordOffset, recordOffset + 56));
        if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw new ZipFormatError('ZIP64 目录已损坏');
        count = readUint64(record, 32);
        directorySize = readUint64(record, 40);
        directoryOffset = readUint64(record, 48);
    }
    if (directoryOffset + directorySize > size) throw new ZipFormatError('ZIP 文件不完整');
    const entries = parseCentralDirectory(
        await readBytes(file, directoryOffset, directoryOffset + directorySize),
        count,
    );

    /** Read one entry as a Blob. Stored entries stay a lazy slice of the original File. */
    async function readEntry(entry, { maxBytes = Infinity, type = '' } = {}) {
        if (entry.encrypted) throw new ZipFormatError('不支持加密的 ZIP');
        if (entry.uncompressedSize > maxBytes) throw new ZipFormatError('ZIP 中的文件超过大小上限');
        const header = view(await readBytes(file, entry.localHeaderOffset, entry.localHeaderOffset + 30));
        if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_SIGNATURE)
            throw new ZipFormatError('ZIP 文件已损坏');
        const dataStart = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const raw = file.slice(dataStart, dataStart + entry.compressedSize);
        if (entry.method === 0) return type ? raw.slice(0, raw.size, type) : raw;
        if (entry.method !== 8) throw new ZipFormatError('不支持的 ZIP 压缩方式');
        if (typeof DecompressionStream !== 'function') throw new ZipFormatError('当前浏览器不支持解压 ZIP');
        const stream = raw
            .stream()
            .pipeThrough(new DecompressionStream('deflate-raw'))
            .pipeThrough(limitStream(maxBytes));
        const blob = await new Response(stream).blob();
        return type ? blob.slice(0, blob.size, type) : blob;
    }
    return { entries, readEntry };
}
