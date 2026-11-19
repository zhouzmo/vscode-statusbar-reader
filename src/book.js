'use strict';

const path = require('path').posix;
const { TextDecoder } = require('util');
const { unzipSync } = require('../vendor/fflate.cjs');
const sax = require('../vendor/sax');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

function decode(bytes, encoding = 'auto') {
    if (encoding === 'auto') {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
        else {
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch (_) {
                encoding = 'gb18030';
            }
        }
    }
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function normalize(text, positions = []) {
    // Move only the requested anchors through the same replacements as the text.
    // This keeps existing UTF-16 progress offsets and avoids a per-character map.
    const sorted = positions.slice().sort((a, b) => a.offset - b.offset);
    const replace = (pattern, replacement) => {
        if (!sorted.length) {
            text = text.replace(pattern, replacement);
            return;
        }
        let index = 0;
        let delta = 0;
        const result = text.replace(pattern, (match, start) => {
            while (index < sorted.length && sorted[index].offset < start) sorted[index++].offset += delta;
            while (index < sorted.length && sorted[index].offset <= start + match.length) {
                const point = sorted[index++];
                point.offset = start + delta + Math.min(point.offset - start, replacement.length);
            }
            delta += replacement.length - match.length;
            return replacement;
        });
        while (index < sorted.length) sorted[index++].offset += delta;
        text = result;
    };
    replace(/^\uFEFF/, '');
    replace(/\r\n?/g, '\n');
    replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    replace(/[^\S\n]+/gu, ' ');
    replace(/ *\n */g, '\n');
    replace(/\n{3,}/g, '\n\n');
    replace(/^\s+|\s+$/gu, '');
    return text;
}

function textChapters(text) {
    const chapters = [];
    const chinese = /^第[零〇一二三四五六七八九十百千万两\d０-９]+[章节回卷部篇集]/u;
    const english = /^(?:lesson|chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+)(?=$|[\s:：.．、—-])/i;
    for (const match of text.matchAll(/^.+$/gm)) {
        const title = match[0];
        if (title.length <= 100 && (chinese.test(title) || english.test(title))) {
            chapters.push({ title, offset: match.index });
        }
    }
    return chapters;
}

function chapterAt(chapters, offset) {
    let low = -1;
    let high = chapters.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (chapters[middle].offset <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

// Track UTF-16 offsets for persistence, but count Unicode code points for page length.
function paginate(text, length) {
    const pages = [];
    let start = 0;
    let cursor = 0;
    let count = 0;
    let boundary = 0;
    while (cursor < text.length) {
        const character = String.fromCodePoint(text.codePointAt(cursor));
        cursor += character.length;
        count++;
        if (character === '\n' || (count >= Math.ceil(length * 0.6) && /[。！？!?；;，,、.]/u.test(character))) {
            boundary = cursor;
        }
        if (count >= length || character === '\n' || cursor === text.length) {
            const end = boundary > start ? boundary : cursor;
            const content = text.slice(start, end).trim();
            if (content) pages.push({ start, end, text: content });
            cursor = end;
            start = end;
            count = 0;
            boundary = 0;
        }
    }
    return pages;
}

function pageAt(pages, offset) {
    let low = 0;
    let high = pages.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (pages[middle].start <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

function localName(name) {
    return name.split(':').pop().toLowerCase();
}

function parseXml(xml, onOpen, onText, onClose) {
    const parser = sax.parser(true, { lowercase: true });
    parser.onopentag = tag => onOpen(localName(tag.name), tag.attributes);
    parser.ontext = parser.oncdata = text => { if (onText) onText(text); };
    parser.onclosetag = name => { if (onClose) onClose(localName(name)); };
    // SAX never fetches external DTDs or resolves external entities.
    parser.write(xml).close();
}

function archivePath(base, href) {
    const raw = href.split(/[?#]/, 1)[0];
    if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('/')) {
        throw new Error('EPUB 包含不支持的正文路径。');
    }
    const resolved = path.normalize(path.join(base, decodeURIComponent(raw)));
    if (resolved === '..' || resolved.startsWith('../') || resolved.includes('\\')) {
        throw new Error('EPUB 正文路径无效。');
    }
    return resolved;
}

function xhtmlText(xml) {
    const blocks = new Set(['p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'section', 'article', 'tr', 'blockquote']);
    const parts = [];
    const anchors = new Map();
    const headings = [];
    let heading;
    let length = 0;
    const append = text => { parts.push(text); length += text.length; };
    let body = false;
    let ignored = 0;
    parseXml(xml, (name, attributes) => {
        if (name === 'body') body = true;
        if (ignored || ['script', 'style', 'nav'].includes(name) || attributes.hidden !== undefined || attributes['aria-hidden'] === 'true') {
            ignored++;
        }
        if (body && !ignored) {
            if (blocks.has(name)) append('\n');
            const id = attributes.id || attributes['xml:id'] || (name === 'a' && attributes.name);
            if (id && !anchors.has(id)) anchors.set(id, { offset: length });
            if (/^h[1-6]$/.test(name)) {
                heading = { offset: length, title: '', level: Number(name[1]) - 1 };
                headings.push(heading);
            }
        }
    }, text => {
        if (body && !ignored) {
            append(text);
            if (heading) heading.title += text;
        }
    }, name => {
        if (ignored) ignored--;
        else if (body && blocks.has(name)) {
            append('\n');
            if (/^h[1-6]$/.test(name)) heading = undefined;
        }
        if (name === 'body') body = false;
    });
    const positions = [...anchors.values(), ...headings];
    const text = normalize(parts.join(''), positions);
    for (const point of positions) {
        while (point.offset < text.length && /\s/u.test(text[point.offset])) point.offset++;
    }
    for (const item of headings) item.title = normalize(item.title).replace(/\s+/gu, ' ');
    return { text, anchors, headings: headings.filter(item => item.title && item.offset < text.length) };
}

function navigationEntries(xml, ncx) {
    let entries = [];
    if (ncx) {
        const points = [];
        let labelDepth = 0;
        parseXml(xml, (name, attrs) => {
            if (name === 'navpoint') {
                const item = { title: '', level: points.length };
                entries.push(item);
                points.push(item);
            }
            if (name === 'navlabel') labelDepth++;
            if (name === 'content' && points.length) points[points.length - 1].href = attrs.src;
        }, text => {
            if (labelDepth && points.length) points[points.length - 1].title += text;
        }, name => {
            if (name === 'navpoint') points.pop();
            if (name === 'navlabel') labelDepth--;
        });
    } else {
        let nav;
        let link;
        let depth = 0;
        const navs = [];
        parseXml(xml, (name, attrs) => {
            if (name === 'nav') {
                nav = { toc: (attrs['epub:type'] || '').split(/\s+/).includes('toc') || attrs.role === 'doc-toc', entries: [] };
                navs.push(nav);
            }
            if (!nav) return;
            if (name === 'ol') depth++;
            if (name === 'a' && attrs.href) {
                link = { title: '', href: attrs.href, level: Math.max(0, depth - 1) };
                nav.entries.push(link);
            }
        }, text => { if (link) link.title += text; }, name => {
            if (name === 'a') link = undefined;
            if (name === 'ol' && nav) depth--;
            if (name === 'nav') nav = undefined;
        });
        entries = (navs.find(item => item.toc) || navs[0] || { entries: [] }).entries;
    }
    return entries.map(item => ({ ...item, title: normalize(item.title).replace(/\s+/gu, ' ') })).filter(item => item.title && item.href);
}

function readEpub(bytes) {
    let total = 0;
    const files = Object.create(null);
    const extract = names => {
        Object.assign(files, unzipSync(bytes, {
            filter(entry) {
                if (!names.has(entry.name)) return false;
                const size = entry.compression === 0 ? entry.size : entry.originalSize;
                total += size;
                if (size > MAX_TEXT_BYTES || total > MAX_TEXT_BYTES * 2) {
                    throw new Error('EPUB 正文过大：单文件上限 16 MiB，解压文本总上限 32 MiB。');
                }
                return true;
            }
        }));
    };
    const read = name => {
        if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error(`EPUB 缺少文件：${name}`);
        // EPUB XML is UTF-8 or UTF-16; do not silently reinterpret malformed XML as GBK.
        const data = files[name];
        const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
            : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
        return decode(data, encoding);
    };
    extract(new Set(['META-INF/container.xml']));
    let rootfile;
    parseXml(read('META-INF/container.xml'), (name, attrs) => {
        if (name === 'rootfile' && !rootfile) rootfile = attrs['full-path'];
    });
    if (!rootfile) throw new Error('EPUB 缺少书籍描述文件。');
    rootfile = archivePath('', rootfile);
    extract(new Set([rootfile]));
    const manifest = new Map();
    const spine = [];
    let tocId;
    let title = '';
    const stack = [];
    parseXml(read(rootfile), (name, attrs) => {
        const parent = stack[stack.length - 1];
        if (name === 'item' && parent === 'manifest') manifest.set(attrs.id, attrs);
        if (name === 'spine') tocId = attrs.toc;
        if (name === 'itemref' && parent === 'spine' && attrs.linear !== 'no') spine.push(attrs.idref);
        stack.push(name);
    }, text => {
        if (stack[stack.length - 1] === 'title' && stack.includes('metadata')) title += text;
    }, () => stack.pop());
    if (!spine.length) throw new Error('EPUB 没有可阅读的正文顺序。');
    const chapterPaths = [];
    for (const id of spine) {
        const item = manifest.get(id);
        if (!item) throw new Error(`EPUB 目录引用不存在：${id}`);
        if (!['application/xhtml+xml', 'text/html'].includes(item['media-type'])) {
            throw new Error('此 EPUB 含非文字正文，当前仅支持 XHTML 文字书。');
        }
        chapterPaths.push(archivePath(path.dirname(rootfile), item.href || ''));
    }
    extract(new Set(chapterPaths));
    const documents = [];
    const byPath = new Map();
    let textLength = 0;
    for (const name of chapterPaths) {
        const chapter = xhtmlText(read(name));
        const start = { offset: textLength + documents.length * 2 };
        for (const point of [...chapter.anchors.values(), ...chapter.headings]) point.offset += start.offset;
        textLength += chapter.text.length;
        if (textLength > MAX_TEXT_BYTES) throw new Error('EPUB 合并正文过长，上限为 1600 万个 UTF-16 单元。');
        const document = { ...chapter, start };
        documents.push(document);
        if (!byPath.has(name)) byPath.set(name, document);
    }
    const positions = documents.flatMap(item => [item.start, ...item.anchors.values(), ...item.headings]);
    const text = normalize(documents.map(item => item.text).join('\n\n'), positions);
    const fallback = documents.flatMap((item, index) => item.headings.length ? item.headings : item.text ? [{
        title: item.text.split('\n', 1)[0].slice(0, 80) || `第 ${index + 1} 部分`, offset: item.start.offset
    }] : []);
    const items = [...manifest.values()];
    const navigation = [
        ...items.filter(item => (item.properties || '').split(/\s+/).includes('nav')),
        ...items.filter(item => item.id === tocId || item['media-type'] === 'application/x-dtbncx+xml')
    ];
    let chapters = [];
    for (const item of navigation) {
        try {
            const name = archivePath(path.dirname(rootfile), item.href || '');
            if (!Object.prototype.hasOwnProperty.call(files, name)) extract(new Set([name]));
            const entries = navigationEntries(read(name), item['media-type'] === 'application/x-dtbncx+xml');
            chapters = entries.flatMap(entry => {
                try {
                    const hash = entry.href.indexOf('#');
                    const fragment = hash < 0 ? '' : decodeURIComponent(entry.href.slice(hash + 1));
                    const target = entry.href.startsWith('#') ? name : archivePath(path.dirname(name), entry.href);
                    const document = byPath.get(target);
                    const point = fragment ? document?.anchors.get(fragment) : document?.start;
                    return document?.text && point && point.offset < text.length
                        ? [{ title: entry.title, offset: point.offset, level: entry.level }] : [];
                } catch (_) { return []; }
            });
            if (chapters.length) break;
        } catch (_) {
            // Broken optional navigation must not prevent reading an intact spine.
        }
    }
    if (!chapters.length) chapters = fallback;
    const seen = new Set();
    chapters = chapters.sort((a, b) => a.offset - b.offset).filter(item => {
        if (seen.has(item.offset)) return false;
        seen.add(item.offset);
        return true;
    });
    return { title: normalize(title), text, chapters };
}

function readBook(bytes, filename, encoding) {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('文件过大，上限为 64 MiB。');
    let book;
    if (/\.epub$/i.test(filename)) book = readEpub(bytes);
    else if (/\.txt$/i.test(filename)) {
        if (bytes.length > MAX_TEXT_BYTES) throw new Error('TXT 文件过大，上限为 16 MiB。');
        book = { title: '', text: normalize(decode(bytes, encoding)) };
        book.chapters = textChapters(book.text);
    } else throw new Error('请选择 TXT 或 EPUB 文件。');
    if (!book.text) throw new Error('书籍中没有可阅读的文字（图片书暂不支持）。');
    return book;
}

module.exports = { MAX_FILE_BYTES, readBook, paginate, pageAt, chapterAt };
