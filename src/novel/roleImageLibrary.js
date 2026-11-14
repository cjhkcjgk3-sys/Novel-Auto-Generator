import { parseRoleNames } from './roleBatchState.js';
import { canReadZipOnDemand, openZip, openZipWithJSZip } from './zipReader.js';
import {
    compact,
    normalizeRoleImageName,
    parseRoleImageName,
    parseWithWorkKeys,
    uniqueStrings,
    workKeysOf,
} from './roleName.js';

export { normalizeRoleImageName, parseRoleImageName };

export const ROLE_IMAGE_FOLDER = 'novel-auto-generator-role-images';
const MANAGED_IMAGE_PREFIX = `user/images/${ROLE_IMAGE_FOLDER}/`;
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 50000;
const MANIFEST_NAME = '00-清单.md';
export const THUMBNAIL_SIZE = 128;
const EXTENSIONS = new Map([
    ['jpg', 'jpg'],
    ['jpeg', 'jpg'],
    ['png', 'png'],
    ['webp', 'webp'],
]);
const MIME_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function addToIndex(map, key, item) {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(item.path, item);
}

function itemNames(item) {
    return uniqueStrings([item.name, ...(Array.isArray(item.aliases) ? item.aliases : []), item.fileName]);
}

/** Build both lookup tiers once per library. */
export function createRoleImageIndex(library) {
    const workKeys = workKeysOf(library?.workNames);
    // The library's own name (清单标题 or folder) never conflicts; only other work names, such as the
    // games listed in a mixed folder's 作品别名, are compared.
    const ownWork = compact(library?.workName || (Array.isArray(library?.workNames) ? library.workNames[0] : ''));
    const neutralWorks = new Set(ownWork ? [ownWork] : []);
    // Names declared as one work (`最终幻想7=最终幻想7重制版`); anything else must be spelled the same.
    const workGroup = new Map();
    (Array.isArray(library?.workGroups) ? library.workGroups : []).forEach((group, id) => {
        for (const name of Array.isArray(group) ? group : []) if (compact(name)) workGroup.set(compact(name), id);
    });
    const index = {
        exact: new Map(),
        role: new Map(),
        workKeys,
        neutralWorks,
        workGroup,
        itemWorks: new Map(),
        cache: new Map(),
    };
    if (!Array.isArray(library?.items)) return index;
    const items = library.items.filter((item) => item?.path);
    const roleAliases = new Map();
    const parsedItems = items.map((item) => {
        const parsed = itemNames(item).map((name) => parseWithWorkKeys(name, workKeys));
        return { item, parsed };
    });
    // Aliases written on the base image (no 备注) also apply to that role's form images.
    for (const { parsed } of parsedItems) {
        const base = parsed.filter((entry) => entry.notes.length === 0).map((entry) => entry.role);
        if (!base.length) continue;
        for (const role of base) {
            if (!roleAliases.has(role)) roleAliases.set(role, new Set());
            for (const alias of base) roleAliases.get(role).add(alias);
        }
    }
    for (const { item, parsed } of parsedItems) {
        const works = parsed.map((entry) => entry.work).filter((work) => work && !neutralWorks.has(work));
        if (works.length) index.itemWorks.set(item.path, works);
        for (const name of itemNames(item)) addToIndex(index.exact, compact(name), item);
        for (const entry of parsed) {
            addToIndex(index.role, entry.key, item);
            if (!entry.notes.length) continue;
            const note = entry.notes.join('');
            for (const alias of roleAliases.get(entry.role) || []) addToIndex(index.role, alias + note, item);
        }
    }
    return index;
}

const indexCache = new WeakMap();
function cachedIndex(library) {
    if (!library || typeof library !== 'object') return createRoleImageIndex(library);
    let index = indexCache.get(library);
    if (!index) {
        index = createRoleImageIndex(library);
        indexCache.set(library, index);
    }
    return index;
}

/**
 * Same work only when the compact names are equal or the 清单 declares them as one work. A shared
 * prefix is not enough: `最终幻想1` and `最终幻想10` are different works.
 */
function isSameWork(a, b, index) {
    if (a === b) return true;
    const group = index.workGroup?.get(a);
    return group != null && group === index.workGroup.get(b);
}

/** Drop candidates whose file name carries a different work name than the roster name. */
function filterSameWork(matches, work, index) {
    if (!matches?.size || !work || index.neutralWorks?.has(work) || !index.itemWorks) return matches;
    const kept = new Map();
    for (const [key, item] of matches) {
        const works = index.itemWorks.get(item.path);
        if (!works || works.some((itemWork) => isSameWork(itemWork, work, index))) kept.set(key, item);
    }
    return kept;
}

function candidateNames(matches) {
    return [...matches.values()].map((item) => item.name || item.fileName);
}

/**
 * Resolve a roster name. Order: (a) exact full name, (b) 角色名+备注 with the work name removed,
 * which is also (c) role name alone when there is no 备注. Never contains-matching; a 备注
 * without a matching form image gives no image; two or more candidates give no image.
 */
export function matchRoleImage(name, library, index = cachedIndex(library)) {
    const cacheKey = String(name ?? '');
    if (index.cache?.has(cacheKey)) return index.cache.get(cacheKey);
    const result = resolveRoleImage(cacheKey, index);
    index.cache?.set(cacheKey, result);
    return result;
}

function resolveRoleImage(name, index) {
    const exactKey = compact(name);
    if (!exactKey) return { status: 'none', item: null, reason: '角色名为空' };
    const exact = index.exact.get(exactKey);
    if (exact?.size === 1) return { status: 'matched', tier: 'exact', item: exact.values().next().value, reason: '' };
    if (exact?.size > 1) {
        const names = candidateNames(exact);
        return {
            status: 'ambiguous',
            item: null,
            candidates: names,
            reason: `有 ${names.length} 张图片同名（${names.join('、')}），无法确定用哪张`,
        };
    }
    const parsed = parseWithWorkKeys(name, index.workKeys);
    const allRoleMatches = parsed.key ? index.role.get(parsed.key) : null;
    const roleMatches = filterSameWork(allRoleMatches, parsed.work, index);
    if (allRoleMatches?.size && !roleMatches?.size)
        return {
            status: 'none',
            item: null,
            reason: `有「${parsed.key}」的图片，但属于其他作品（${candidateNames(allRoleMatches).join('、')}），作品名不同，不使用`,
        };
    if (roleMatches?.size === 1)
        return {
            status: 'matched',
            tier: parsed.notes.length ? 'role-note' : 'role',
            item: roleMatches.values().next().value,
            reason: '',
        };
    if (roleMatches?.size > 1) {
        const names = candidateNames(roleMatches);
        return {
            status: 'ambiguous',
            item: null,
            candidates: names,
            reason: `有 ${names.length} 张图片都对应「${parsed.key}」（${names.join('、')}），无法确定用哪张`,
        };
    }
    if (parsed.notes.length && index.role.get(parsed.role)?.size)
        return {
            status: 'none',
            item: null,
            reason: `有「${parsed.role}」的图片，但没有「${parsed.key}」这个备注/形态的图片，不使用本体图`,
        };
    const characters = [...parsed.key];
    for (let length = characters.length - 1; length > 0; length--) {
        const prefix = characters.slice(0, length).join('');
        if (index.role.get(prefix)?.size)
            return {
                status: 'none',
                item: null,
                reason: `未匹配到图片（只有「${prefix}」的图片，名称不完全相同，不会自动使用）`,
            };
    }
    return { status: 'none', item: null, reason: '未匹配到图片' };
}

export function findRoleImageMatch(name, library, index) {
    return matchRoleImage(name, library, index).item;
}

export function isRoleImageDisabled(name, library) {
    const key = normalizeRoleImageName(name);
    return !!key && Array.isArray(library?.noImageNames) && library.noImageNames.includes(key);
}

export function setRoleImageDisabled(name, disabled, library) {
    if (!library) return library;
    const key = normalizeRoleImageName(name);
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

// ============================================
// ZIP 导入
// ============================================

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
    return directory ? `${directory}/${relative}` : relative;
}

function parseAliases(value) {
    return uniqueStrings(String(value || '').split(/[、，,/;；]+/));
}

const WORK_GROUP_SEPARATOR = /[=＝]/;

function workAliasEntries(text) {
    return parseAliases(String(text || '').match(/^\s*作品别名[:：]\s*(.*?)\s*$/m)?.[1] || '');
}

/**
 * Work name from `# X角色图片清单`, `作品别名：` or the folder name. In a mixed folder,
 * `作品别名：最终幻想7=最终幻想7重制版、最终幻想8` lists 最终幻想7 and its remake as one work.
 */
export function parseChecklistWorkNames(text, folderName = '') {
    const source = String(text || '');
    const title = source.match(/^\s*#\s+(.+?)\s*$/m)?.[1] || '';
    const titleName = title.replace(/\s*(?:角色)?(?:图片)?(?:清单|名单|目录)\s*$/u, '').trim();
    const aliases = workAliasEntries(source).flatMap((entry) => entry.split(WORK_GROUP_SEPARATOR));
    return uniqueStrings([titleName, folderName, ...aliases]);
}

/** Groups of names declared as one work with `=` in `作品别名：`. */
export function parseChecklistWorkGroups(text) {
    return workAliasEntries(text)
        .filter((entry) => WORK_GROUP_SEPARATOR.test(entry))
        .map((entry) => uniqueStrings(entry.split(WORK_GROUP_SEPARATOR)))
        .filter((group) => group.length > 1);
}

/** One row per image path: an image listed twice (e.g. also under 「## 皮肤」) is imported once. */
function parseChecklist(text, directory) {
    const rows = [];
    const byPath = new Map();
    for (const line of String(text).split(/\r?\n/)) {
        const match = line.match(/^\s*-\s*\[[ xX]\]\s*\[([^\]]+)\]\((<[^>]+>|[^)]*)\)(.*)$/);
        if (!match) continue;
        const name = match[1].trim();
        const target = match[2].replace(/^<|>$/g, '').trim();
        if (!name || !target || /^(?:https?:)?\/\//i.test(target)) continue;
        const path = resolveZipPath(directory, target);
        if (!path) throw new Error('清单包含不安全的图片路径');
        const extension = path.split('.').at(-1)?.toLowerCase();
        if (!EXTENSIONS.has(extension)) continue;
        const aliasText = match[3].match(/(?:^|\s)别名[:：]\s*([^;；]*?)(?:\s+备注[:：].*)?\s*$/)?.[1] || '';
        const existing = byPath.get(path);
        if (existing) {
            existing.aliases = uniqueStrings([...existing.aliases, ...parseAliases(aliasText), name]).filter(
                (alias) => alias !== existing.name,
            );
            continue;
        }
        const row = {
            name,
            aliases: parseAliases(aliasText),
            path,
            fileName: path
                .split('/')
                .at(-1)
                .replace(/\.[^.]+$/, ''),
        };
        byPath.set(path, row);
        rows.push(row);
    }
    return rows;
}

const TASK_LINE = /^\s*-\s*\[[ xX]\]\s+(.*)$/;
const LINKED_NAME = /^\[([^\]]+)\]\((?:<[^>]+>|[^)]*)\)/;
const HEADING = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Every role name listed in the 清单, linked (has an image path) or not, checked or not.
 * Entries under a 「## 皮肤」 heading (and its sub-headings) go to `skins`; the rest to `roles`.
 * Names keep the 清单 spelling exactly, e.g. `拉菲（泳装）`; trailing 别名：/备注： text is dropped.
 */
export function parseChecklistRoles(text) {
    const roles = [];
    const skins = [];
    let skinLevel = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
        const heading = line.match(HEADING);
        if (heading) {
            const level = heading[1].length;
            if (skinLevel && level <= skinLevel) skinLevel = 0;
            if (!skinLevel && level >= 2 && /^皮肤/u.test(heading[2].trim())) skinLevel = level;
            continue;
        }
        const task = line.match(TASK_LINE);
        if (!task) continue;
        const body = task[1].trim();
        const linked = body.match(LINKED_NAME);
        const name = (linked ? linked[1] : body.replace(/(?:^|\s+)(?:别名|备注)[:：].*$/u, '')).trim();
        if (name) (skinLevel ? skins : roles).push(name);
    }
    const roleList = parseRoleNames(roles.join('\n'));
    const roleSet = new Set(roleList);
    return { roles: roleList, skins: parseRoleNames(skins.join('\n')).filter((name) => !roleSet.has(name)) };
}

/** Whether this library was imported with its 清单 names (1.15.0+). */
export function hasChecklistRoles(library) {
    return Array.isArray(library?.checklist?.roles) && Array.isArray(library?.checklist?.skins);
}

function matchesQuery(name, query) {
    if (!query) return true;
    if (name.includes(query)) return true;
    const key = compact(query);
    return !!key && compact(name).includes(key);
}

/**
 * Rows for the “从清单添加” picker: each 清单 name with whether it is already in the roster
 * (exact full name) and whether the library has an image for it. Null for libraries without names.
 */
export function listChecklistRoles(library, rosterText = '', query = '') {
    if (!hasChecklistRoles(library)) return null;
    const roster = new Set(parseRoleNames(rosterText));
    const needle = String(query || '').trim();
    const index = cachedIndex(library);
    const rows = (names) =>
        names
            .filter((name) => matchesQuery(name, needle))
            .map((name) => ({
                name,
                inRoster: roster.has(name),
                hasImage: !!matchRoleImage(name, library, index).item,
            }));
    return {
        roles: rows(library.checklist.roles),
        skins: rows(library.checklist.skins),
        total: library.checklist.roles.length + library.checklist.skins.length,
    };
}

/** Append names to the roster text, one per line, skipping exact full names already present. */
export function addNamesToRoster(rosterText, names) {
    const current = parseRoleNames(rosterText);
    const seen = new Set(current);
    const added = [];
    let skipped = 0;
    for (const name of parseRoleNames((Array.isArray(names) ? names : []).join('\n'))) {
        if (seen.has(name)) skipped++;
        else {
            seen.add(name);
            added.push(name);
        }
    }
    return { text: [...current, ...added].join('\n'), added, skipped };
}

function isJunkEntry(name) {
    const parts = name.split('/');
    return parts.includes('__MACOSX') || parts.at(-1).startsWith('._');
}

function makeFileId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function canvasToBlob(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Decode once to validate the image and draw a small thumbnail (longest side ≤ 128, top kept for
 * tall art). Returns null for the thumbnail when the browser cannot encode one.
 */
export async function createBrowserThumbnail(blob, size = THUMBNAIL_SIZE) {
    if (typeof createImageBitmap !== 'function') return { ok: await decodeWithImage(blob), thumbnail: null };
    const bitmap = await createImageBitmap(blob);
    try {
        const width = bitmap.width || 1;
        const height = bitmap.height || 1;
        // Tall full-body art: keep a top 1:1.5 window so the face stays visible in a square slot.
        const sourceHeight = Math.min(height, Math.round(width * 1.5));
        const scale = Math.min(1, size / Math.max(width, sourceHeight));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
        let canvas;
        if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(targetWidth, targetHeight);
        else if (globalThis.document?.createElement) {
            canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        } else return { ok: true, thumbnail: null };
        const context = canvas.getContext('2d');
        if (!context) return { ok: true, thumbnail: null };
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, sourceHeight, 0, 0, targetWidth, targetHeight);
        let thumbnail = await canvasToBlob(canvas, 'image/webp', 0.82);
        // Safari may ignore webp and return PNG; both keep transparency.
        if (!thumbnail || !/^image\/(webp|png)$/.test(thumbnail.type))
            thumbnail = await canvasToBlob(canvas, 'image/png');
        return { ok: true, thumbnail: thumbnail?.size ? thumbnail : null };
    } finally {
        bitmap.close?.();
    }
}

async function decodeWithImage(blob) {
    if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return true;
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        if (typeof image.decode === 'function') await image.decode();
        else
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
            });
        return true;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function isManagedPath(path) {
    return String(path || '')
        .replace(/^\/+/, '')
        .startsWith(MANAGED_IMAGE_PREFIX);
}

async function deleteManagedImage(path, host) {
    if (!isManagedPath(path)) throw new Error('图片路径不属于插件图库');
    await host.deleteRoleImage(path);
}

async function openArchive(file, host) {
    if (canReadZipOnDemand()) return openZip(file);
    const JSZip = await host.loadRoleImageZip?.();
    if (!JSZip?.loadAsync) throw new Error('当前酒馆没有可用的 ZIP 解析器');
    return openZipWithJSZip(file, JSZip);
}

function formatSize(bytes) {
    return bytes >= 1024 * 1024 * 1024 ? `${bytes / 1024 / 1024 / 1024} GB` : `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Import one work ZIP. Only the ZIP directory is read up front; each image is then read, checked,
 * thumbnailed and uploaded one at a time and released before the next.
 */
export async function importRoleImageZip(
    file,
    host,
    { makeThumbnail = createBrowserThumbnail, onProgress = () => {}, open = openArchive } = {},
) {
    if (!file?.name?.toLowerCase().endsWith('.zip')) throw new Error('请选择作品 ZIP 文件');
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error(`ZIP 文件超过导入上限（${formatSize(MAX_ARCHIVE_BYTES)}）`);
    if (typeof host?.uploadRoleImage !== 'function' || typeof host?.deleteRoleImage !== 'function')
        throw new Error('当前酒馆没有可用的图片库接口');

    let archive;
    try {
        archive = await open(file, host);
    } catch (error) {
        throw new Error(`无法读取 ZIP：${error?.message || error}`);
    }
    if (archive.entries.length > MAX_ENTRIES) throw new Error('ZIP 里的文件太多');
    const files = new Map();
    for (const entry of archive.entries) {
        if (entry.dir || isJunkEntry(entry.name)) continue;
        const path = normalizeZipPath(entry.name);
        if (path) files.set(path, entry);
    }
    const manifests = [...files.keys()].filter((path) => path.split('/').at(-1) === MANIFEST_NAME);
    if (!manifests.length) throw new Error('ZIP 里没有找到 00-清单.md');
    if (manifests.length > 1) throw new Error('ZIP 只能包含一个作品（发现多个 00-清单.md）');
    const manifestPath = manifests[0];
    const directory = manifestPath.split('/').slice(0, -1).join('/');
    const manifestBlob = await archive.readEntry(files.get(manifestPath), { maxBytes: MAX_MANIFEST_BYTES });
    const manifest = await manifestBlob.text();
    const folderName = directory.split('/').at(-1) || '';
    const zipName = file.name.replace(/\.zip$/i, '').trim();
    const workNames = parseChecklistWorkNames(manifest, folderName);
    const workName = workNames[0] || zipName;
    if (!workNames.length && workName) workNames.push(workName);
    const rows = parseChecklist(manifest, directory);
    if (!rows.length) throw new Error('清单里没有可导入的角色图片');

    const items = [];
    let skipped = 0;
    let saveFailures = 0;
    const uploadedPaths = [];
    try {
        for (const [position, row] of rows.entries()) {
            onProgress({ done: position, total: rows.length });
            const source = files.get(row.path);
            if (!source) {
                skipped++;
                continue;
            }
            const extension = EXTENSIONS.get(row.path.split('.').at(-1).toLowerCase());
            let blob;
            let thumbnail = null;
            try {
                blob = await archive.readEntry(source, { maxBytes: MAX_IMAGE_BYTES, type: MIME_TYPES[extension] });
                if (!blob.size) throw new Error('empty');
                const prepared = await makeThumbnail(blob);
                if (!prepared?.ok) throw new Error('unreadable');
                thumbnail = prepared.thumbnail || null;
            } catch {
                skipped++;
                continue;
            }
            const id = makeFileId();
            let path;
            try {
                path = await host.uploadRoleImage(blob, id, extension);
                if (!isManagedPath(path)) throw new Error('酒馆返回的图片路径不在插件图片库中');
                uploadedPaths.push(path);
            } catch {
                skipped++;
                saveFailures++;
                continue;
            }
            let thumbPath = '';
            if (thumbnail) {
                try {
                    const thumbExtension = thumbnail.type === 'image/png' ? 'png' : 'webp';
                    const saved = await host.uploadRoleImage(thumbnail, `${id}-thumb`, thumbExtension);
                    if (isManagedPath(saved)) {
                        uploadedPaths.push(saved);
                        thumbPath = saved;
                    }
                } catch {
                    // The list falls back to the original image when no thumbnail was saved.
                }
            }
            items.push({ ...row, id, path, extension, ...(thumbPath ? { thumbPath } : {}) });
        }
        onProgress({ done: rows.length, total: rows.length });
        if (!items.length) {
            throw new Error(saveFailures ? '酒馆未能保存图片，请检查酒馆图片接口后重试' : 'ZIP 中没有可读取的角色图片');
        }
        return {
            library: {
                workName,
                workNames,
                workGroups: parseChecklistWorkGroups(manifest),
                items,
                noImageNames: [],
                checklist: parseChecklistRoles(manifest),
            },
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
            if (item.thumbPath) await deleteManagedImage(item.thumbPath, host).catch(() => {});
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
