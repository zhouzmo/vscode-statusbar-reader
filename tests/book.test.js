'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('../vendor/fflate.cjs');
const { readBook, paginate, pageAt, chapterAt } = require('../src/book');

function epub(chapters, items, spine, spineAttributes = '') {
    const files = {
        mimetype: strToU8('application/epub+zip'),
        'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>'),
        'EPUB/content.opf': strToU8(`<package><metadata><dc:title xmlns:dc="urn:dc">测试书</dc:title></metadata><manifest>${items}</manifest><spine ${spineAttributes}>${spine}</spine></package>`)
    };
    for (const [name, text] of Object.entries(chapters)) files[`EPUB/${name}`] = strToU8(text);
    return zipSync(files);
}

test('TXT: UTF-8 and GBK auto decoding', () => {
    assert.equal(readBook(strToU8('你好\r\n世界'), 'book.txt', 'auto').text, '你好\n世界');
    assert.equal(readBook(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]), 'book.txt', 'auto').text, '你好');
    assert.throws(() => readBook(new Uint8Array(), 'empty.txt', 'auto'), /没有可阅读/);
});

test('TXT: UTF-16 BOM detection', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')]);
    assert.equal(readBook(bytes, 'book.txt', 'auto').text, '你好');
});

test('pagination keeps all non-whitespace text and complete emoji', () => {
    const text = '这是开头，后面是连续文字。\n第二段包含😀和更多文字以及结束。';
    const pages = paginate(text, 12);
    assert.equal(pages.map(page => page.text).join('').replace(/\s/gu, ''), text.replace(/\s/gu, ''));
    for (const page of pages) {
        assert.ok(Array.from(page.text).length <= 12);
        assert.equal(text.slice(page.start, page.end).trim(), page.text);
    }
    for (let i = 0; i < pages.length; i++) assert.equal(pageAt(pages, pages[i].start), i);
    assert.equal(pageAt(pages, 1e9), pages.length - 1);
    const resized = paginate(text, 16);
    const offset = pages[1].start;
    const restored = resized[pageAt(resized, offset)];
    assert.ok(restored.start <= offset && restored.end > offset);
});

test('EPUB follows spine, resolves encoded paths, strips hidden content and decodes entities', () => {
    const bytes = epub({
        'b.xhtml': '<html><head><title>不显示</title></head><body><p>第二章 &amp; 结束</p><script>不显示</script></body></html>',
        'a first': '<html><body><nav>不显示目录</nav><p>第一章 <b>你好</b>&nbsp;世界</p><div hidden="hidden"><p>不显示内容</p></div></body></html>'
    }, '<item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a%20first" media-type="application/xhtml+xml"/>',
    '<itemref idref="a"/><itemref idref="b"/>');
    const book = readBook(bytes, 'book.epub');
    assert.equal(book.title, '测试书');
    assert.equal(book.text, '第一章 你好 世界\n\n第二章 & 结束');
});

test('EPUB rejects broken spine references, path traversal, and malformed archives', () => {
    assert.throws(() => readBook(epub({}, '', '<itemref idref="missing"/>'), 'book.epub'), /引用不存在/);
    assert.throws(() => readBook(epub({}, '<item id="a" href="../../bad.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="a"/>'), 'book.epub'), /路径无效/);
    assert.throws(() => readBook(strToU8('not a zip'), 'book.epub'));
});

test('TXT chapters use normalized UTF-16 offsets and remain correct after repagination', () => {
    const raw = '\uFEFFNCE2\r\nLessons 01-96\r\n\r\n\r\nLesson 01: A private conversation\r\n正文😀\r\n\r\n Lesson 02: Breakfast or lunch? \r\n正文二';
    const book = readBook(strToU8(raw), 'NCE2.txt');
    assert.deepEqual(book.chapters.map(item => item.title), [
        'Lesson 01: A private conversation', 'Lesson 02: Breakfast or lunch?'
    ]);
    for (const chapter of book.chapters) {
        assert.equal(book.text.slice(chapter.offset, chapter.offset + chapter.title.length), chapter.title);
        for (const length of [12, 28, 100]) {
            const pages = paginate(book.text, length);
            const page = pages[pageAt(pages, chapter.offset)];
            assert.ok(page.start <= chapter.offset && page.end > chapter.offset);
            assert.ok(page.text.startsWith(chapter.title.slice(0, 8)));
        }
    }
    assert.equal(chapterAt(book.chapters, 0), -1);
    assert.equal(chapterAt(book.chapters, book.chapters[0].offset), 0);
    assert.equal(chapterAt(book.chapters, book.chapters[1].offset - 1), 0);
    assert.equal(chapterAt(book.chapters, book.text.length), 1);
    assert.equal(chapterAt([], 10), -1);
});

test('TXT identifies standalone Chinese and English chapter headings conservatively', () => {
    const book = readBook(strToU8('前言\n第一章 起点\n正文\n第十二节：继续\n正文\nChapter IV: A new day\n正文\nI read Chapter 3 yesterday.\nLessons 01-96\n' + 'Chapter 5 ' + 'x'.repeat(100)), 'book.txt');
    assert.deepEqual(book.chapters.map(item => item.title), ['第一章 起点', '第十二节：继续', 'Chapter IV: A new day']);
    assert.deepEqual(readBook(strToU8('没有标题的普通正文。\n另一行正文。'), 'book.txt').chapters, []);
});

test('EPUB 3 navigation resolves encoded anchors without changing body text', () => {
    const body = '<html><body>\n\n<h1 id="one">相同标题</h1><p>第一部分😀</p><div hidden="hidden"><h2 id="hidden">隐藏</h2></div>\n\n<h2 id="第二节">相同标题</h2><p>第二部分</p></body></html>';
    const bytes = epub({
        'a.xhtml': body,
        'nav/toc.xhtml': '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks"><ol><li><a href="../a.xhtml">错误目录</a></li></ol></nav><nav epub:type="toc"><ol><li><a href="../a.xhtml#one">开篇</a><ol><li><a href="../a.xhtml#%E7%AC%AC%E4%BA%8C%E8%8A%82"><span>后半</span></a></li></ol></li><li><a href="../a.xhtml#missing">无效锚点</a></li><li><a href="https://example.com/book">外部链接</a></li><li><a href="../a.xhtml#hidden">隐藏锚点</a></li></ol></nav></body></html>'
    }, '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav/toc.xhtml" properties="nav" media-type="application/xhtml+xml"/>', '<itemref idref="a"/>');
    const book = readBook(bytes, 'book.epub');
    assert.equal(book.text, '相同标题\n\n第一部分😀\n\n相同标题\n\n第二部分');
    assert.deepEqual(book.chapters, [
        { title: '开篇', offset: 0, level: 0 },
        { title: '后半', offset: book.text.lastIndexOf('相同标题'), level: 1 }
    ]);
});

test('EPUB 2 NCX follows spine order and resolves anchors across files', () => {
    const book = readBook(epub({
        'first.xhtml': '<html><body><h1 id="start">第一章</h1><p>正文😀</p></body></html>',
        'empty.xhtml': '<html><body><img src="cover.png"/></body></html>',
        'last.xhtml': '<html><body>\n<h1 id="last">末章</h1><p>结束</p></body></html>',
        'toc.ncx': '<ncx><navMap><navPoint><navLabel><text>末尾</text></navLabel><content src="last.xhtml#last"/></navPoint><navPoint><navLabel><text>开头</text></navLabel><content src="first.xhtml#start"/></navPoint><navPoint><navLabel><text>重复</text></navLabel><content src="first.xhtml#start"/></navPoint></navMap></ncx>'
    }, '<item id="a" href="first.xhtml" media-type="application/xhtml+xml"/><item id="e" href="empty.xhtml" media-type="application/xhtml+xml"/><item id="b" href="last.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<itemref idref="a"/><itemref idref="e"/><itemref idref="b"/>', 'toc="ncx"'), 'book.epub');
    assert.equal(book.text, '第一章\n\n正文😀\n\n末章\n\n结束');
    assert.deepEqual(book.chapters.map(({ title, offset }) => ({ title, offset })), [
        { title: '开头', offset: 0 }, { title: '末尾', offset: book.text.indexOf('末章') }
    ]);
});

test('EPUB falls back to headings or file boundaries when optional navigation is broken', () => {
    for (const navigation of ['<broken>', '<html><body><nav><a href="a.xhtml#missing">失效</a></nav></body></html>']) {
        const book = readBook(epub({
            'a.xhtml': '<html><body><h1>正文标题</h1><p>正文</p></body></html>',
            'b.xhtml': '<html><body><p>另一部分</p></body></html>',
            'nav.xhtml': navigation
        }, '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<itemref idref="a"/><itemref idref="b"/>'), 'book.epub');
        assert.deepEqual(book.chapters.map(item => [item.title, item.offset]), [
            ['正文标题', 0], ['另一部分', book.text.indexOf('另一部分')]
        ]);
    }
});
