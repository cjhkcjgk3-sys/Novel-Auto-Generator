export const ROLE_IMAGE_FOLDER = 'novel-auto-generator-role-images';
const MANAGED_IMAGE_PREFIX = `user/images/${ROLE_IMAGE_FOLDER}/`;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const EXTENSIONS = new Map([
    ['jpg', 'jpg'],
    ['jpeg', 'jpg'],
    ['png', 'png'],
    ['webp', 'webp'],
]);

function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeSymbols(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\p{P}\p{S}\p{Cf}\s]+/gu, '');
}

export function normalizeRoleImageName(value, workNames = []) {
    const name = normalizeSymbols(value);
    if (!name) return '';
    const titles = uniqueStrings(workNames.map(normalizeSymbols).filter(Boolean)).sort((a, b) => b.length - a.length);
    for (const title of titles) {
        if (name.length <= title.length) continue;
        if (name.startsWith(title)) return name.slice(title.length);
        if (name.endsWith(title)) return name.slice(0, -title.length);
    }
    return name;
}

export function createRoleImageIndex(library) {
    const index = new Map();
    if (!Array.isArray(library?.items)) return index;
    for (const item of library.items) {
        if (!item?.path) continue;
        const aliases = Array.isArray(item.aliases) ? item.aliases : [];
        const names = [item.name, ...aliases, item.fileName];
        for (const name of names) {
            const key = normalizeRoleImageName(name, library.workNames);
            if (!key) continue;
            if (!index.has(key)) index.set(key, new Map());
            index.get(key).set(item.path, item);
        }
    }
    return index;
}

export function findRoleImageMatch(name, library, index = createRoleImageIndex(library)) {
    const key = normalizeRoleImageName(name, library?.workNames);
    const matches = index.get(key);
    return matches?.size === 1 ? matches.values().next().value : null;
}

export function isRoleImageDisabled(name, library) {
    const key = normalizeRoleImageName(name, library?.workNames);
    return !!key && Array.isArray(library?.noImageNames) && library.noImageNames.includes(key);
}

export function setRoleImageDisabled(name, disabled, library) {
    if (!library) return library;
    const key = normalizeRoleImageName(name, library.workNames);
    if (!key) return library;
    const names = new Set(Array.isArray(library.noImageNames) ? library.noImageNames : []);
    if (disabled) names.add(key);
    else names.delete(key);
    return { ...library, noImageNames: [...names] };
}

export function getRoleImageForRequest(name, library) {
    if (isRoleImageDisabled(name, library)) return null;
    return findRoleImageMatch(name, library);
}

function normalizeZipPath(value) {
    const path = String(value || '').replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path)) return null;
    const parts = path.split('/').filter((part) => part && part !== '.');
    if (parts.some((part) => part === '..')) return null;
    return parts.join('/');
}

function resolveZipPath(directory, relativePath) {
    let decoded;
    try {
        decoded = decodeURIComponent(relativePath);
    } catch {
        decoded = relativePath;
    }
    const relative = normalizeZipPath(decoded);
    if (!relative) return null;
    const result = [...directory.split('/').filter(Boolean)];
    result.push(...relative.split('/'));
    const path = result.join('/');
    return path.startsWith(`${directory}/`) ? path : null;
}

function parseAliases(value) {
    return uniqueStrings(String(value || '').split(/[、，,/;；]+/));
}

function parseChecklist(text, directory, workName) {
    const aliasesLine = String(text).match(/^\s*作品别名[:：]\s*(.*?)\s*$/m)?.[1] || '';
    const workNames = uniqueStrings([workName, ...parseAliases(aliasesLine)]);
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
        const match = line.match(/^\s*-\s*\[[ xX]\]\s*\[([^\]]+)\]\((<[^>]+>|[^)]*)\)(.*)$/);
        if (!match) continue;
        const name = match[1].trim();
        const target = match[2].replace(/^<|>$/g, '').trim();
        if (!name || !target || /^(?:https?:)?\/\//i.test(target)) continue;
        const path = resolveZipPath(directory, target);
        if (!path) throw new Error('清单包含不安全的图片路径');
        if (!path.startsWith(`${directory}/`)) throw new Error('清单中的图片必须位于作品目录内');
        const extension = path.split('.').at(-1)?.toLowerCase();
        if (!EXTENSIONS.has(extension)) continue;
        const aliasText = match[3].match(/(?:^|\s)别名[:：]\s*([^;；]*?)(?:\s+备注[:：].*)?\s*$/)?.[1] || '';
        rows.push({
            name,
            aliases: parseAliases(aliasText),
            path,
            fileName: path.split('/').at(-1).replace(/\.[^.]+$/, ''),
        });
    }
    return { workNames, rows };
}

function makeFileId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function isReadableImage(blob) {
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        bitmap.close?.();
        return true;
    }
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        if (typeof image.decode === 'function') await image.decode();
        else await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
        });
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function isManagedPath(path) {
    return String(path || '').replace(/^\/+/, '').startsWith(MANAGED_IMAGE_PREFIX);
}

async function deleteManagedImage(path, host) {
    if (!isManagedPath(path)) throw new Error('图片路径不属于插件图库');
    await host.deleteRoleImage(path);
}

export async function importRoleImageZip(file, host) {
    if (!file?.name?.toLowerCase().endsWith('.zip')) throw new Error('请选择作品 ZIP 文件');
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件超过手机导入上限（200 MB）');
    if (
        typeof host?.uploadRoleImage !== 'function' ||
        typeof host?.loadRoleImageZip !== 'function' ||
        typeof host?.deleteRoleImage !== 'function'
    )
        throw new Error('当前酒馆没有可用的图片库接口');

    const JSZip = await host.loadRoleImageZip();
    if (!JSZip?.loadAsync) throw new Error('当前酒馆没有可用的 ZIP 解析器');
    const archive = await JSZip.loadAsync(file);
    const entries = Object.values(archive.files);
    const expandedBytes = entries.reduce((total, entry) => total + (Number(entry._data?.uncompressedSize) || 0), 0);
    if (expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES)
        throw new Error('ZIP 解压后超过手机导入上限（512 MB）');
    const manifestEntries = entries.filter((entry) => !entry.dir && entry.name.split('/').at(-1) === '00-清单.md');
    if (manifestEntries.length !== 1) throw new Error('ZIP 需要且只能包含一个作品的 00-清单.md');

    const manifestPath = normalizeZipPath(manifestEntries[0].name);
    if (!manifestPath) throw new Error('ZIP 中包含不安全的文件路径');
    const directory = manifestPath.split('/').slice(0, -1).join('/');
    if (!directory) throw new Error('请导入包含作品目录和 00-清单.md 的标准 ZIP');
    const workName = directory.split('/').at(-1);
    const manifest = await manifestEntries[0].async('string');
    const { workNames, rows } = parseChecklist(manifest, directory, workName);
    if (!rows.length) throw new Error('清单里没有可导入的角色图片');

    const items = [];
    let skipped = 0;
    let saveFailures = 0;
    const uploadedPaths = [];
    try {
        for (const row of rows) {
            const source = archive.file(row.path);
            if (!source || source.dir) {
                skipped++;
                continue;
            }
            let blob;
            try {
                if (Number(source._data?.uncompressedSize) > MAX_IMAGE_BYTES) {
                    skipped++;
                    continue;
                }
                blob = await source.async('blob');
                if (!blob.size || blob.size > MAX_IMAGE_BYTES || !(await isReadableImage(blob))) {
                    skipped++;
                    continue;
                }
            } catch {
                skipped++;
                continue;
            }
            const originalExtension = row.path.split('.').at(-1).toLowerCase();
            const extension = EXTENSIONS.get(originalExtension);
            const id = makeFileId();
            try {
                const path = await host.uploadRoleImage(blob, id, extension);
                if (!isManagedPath(path)) throw new Error('酒馆返回的图片路径不在插件图片库中');
                uploadedPaths.push(path);
                items.push({ ...row, id, path, extension });
            } catch {
                skipped++;
                saveFailures++;
            }
        }
        if (!items.length) {
            throw new Error(
                saveFailures ? '酒馆未能保存图片，请检查酒馆图片接口后重试' : 'ZIP 中没有可读取的角色图片',
            );
        }
        return {
            library: { workName, workNames, items, noImageNames: [] },
            imported: items.length,
            skipped,
        };
    } catch (error) {
        await Promise.allSettled(uploadedPaths.map((path) => deleteManagedImage(path, host)));
        throw error;
    }
}

export async function clearRoleImageLibrary(library, host) {
    const failedItems = [];
    let deleted = 0;
    for (const item of library?.items || []) {
        try {
            await deleteManagedImage(item.path, host);
            deleted++;
        } catch {
            failedItems.push(item);
        }
    }
    return {
        library: failedItems.length ? { ...library, items: failedItems } : null,
        deleted,
        failed: failedItems.length,
    };
}
