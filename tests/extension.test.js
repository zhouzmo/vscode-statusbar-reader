'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function event() {
    const listeners = new Set();
    return {
        subscribe(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        fire(value) { for (const listener of [...listeners]) listener(value); }
    };
}

async function reader(t) {
    const commands = new Map();
    const calls = [];
    const saved = {};
    const windowState = { focused: true };
    const text = 'NCE2\n\nLesson 01: First\n正文一\n\nLesson 02: Second\n正文二';
    const resource = value => ({ path: value, toString: () => value });
    const configuration = event();
    const focus = event();
    const h = { text, selectedFile: 'book.txt', calls, saved };
    const vscode = {
        Uri: { parse: resource, joinPath: (base, name) => resource(`${base.path}/${name}`) },
        StatusBarAlignment: { Left: 1, Right: 2 },
        MarkdownString: class { appendText() {} appendMarkdown() {} },
        TextEditorSelectionChangeKind: { Mouse: 2, Keyboard: 1 },
        commands: {
            registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; },
            async executeCommand(name, ...args) {
                calls.push(name);
                return commands.get(name)?.(...args);
            }
        },
        workspace: {
            getConfiguration: () => ({ get: (name, fallback) => name === 'charactersPerPage' ? (h.pageLength || 28) : fallback }),
            fs: {
                async stat() { return { size: Buffer.byteLength(text) }; },
                async readFile(uri) {
                    if (uri.path.endsWith('library-update.json')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                    return Buffer.from(text);
                }
            },
            onDidChangeConfiguration: configuration.subscribe,
            onDidChangeTextDocument: event().subscribe
        },
        window: {
            state: windowState,
            createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
            showInformationMessage: message => { h.message = message; },
            showWarningMessage: message => { throw new Error(message); },
            showErrorMessage: message => { throw new Error(message); },
            showOpenDialog: async () => [resource(h.selectedFile)],
            createQuickPick() {
                const accept = event();
                const hide = event();
                const picker = {
                    selectedItems: [], activeItems: [],
                    onDidAccept: accept.subscribe, onDidHide: hide.subscribe,
                    show() { h.picker = picker; },
                    hide() { hide.fire(); },
                    dispose() { this.hide(); this.disposed = true; },
                    accept(index) { this.selectedItems = [this.items[index]]; accept.fire(); }
                };
                return picker;
            },
            onDidChangeWindowState: focus.subscribe,
            onDidChangeActiveTerminal: event().subscribe,
            onDidChangeActiveTextEditor: event().subscribe,
            onDidChangeTextEditorSelection: event().subscribe
        }
    };
    const filename = path.resolve(__dirname, '../src/extension.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, require: name => name === 'vscode' ? vscode : localRequire(name),
        Buffer, setTimeout, clearTimeout, setInterval, clearInterval
    }, { filename });
    await module.exports.activate({
        globalState: {
            get: () => ({}),
            async update(key, value) { saved[key] = JSON.parse(JSON.stringify(value)); }
        },
        globalStorageUri: resource('storage'), subscriptions: []
    });
    h.close = () => module.exports.deactivate();
    t.after(h.close);
    h.command = name => commands.get(`statusbarNovel.${name}`)();
    h.state = () => saved['readingState.v1'];
    h.resize = length => { h.pageLength = length; configuration.fire({ affectsConfiguration: () => true }); };
    h.blur = () => { windowState.focused = false; focus.fire(windowState); };
    await h.command('open');
    return h;
}

test('directory preselects current chapter, confirms a jump, saves and restores paging focus', async t => {
    const h = await reader(t);
    await h.command('nextChapter');
    const pending = h.command('contents');
    const picker = h.picker;
    assert.equal(picker.activeItems[0].chapterIndex, 0);
    assert.match(picker.items[0].description, /当前章节/);
    picker.accept(1);
    await pending;
    assert.ok(picker.disposed);
    assert.equal(h.state().books['book.txt'].offset, h.text.indexOf('Lesson 02'));
    assert.deepEqual(h.calls.slice(-2), ['workbench.statusBar.focusFirst', 'workbench.statusBar.clearFocus']);
    const cancel = h.command('contents');
    assert.equal(h.picker.activeItems[0].chapterIndex, 1);
    h.picker.hide();
    await cancel;
});

test('cancelling a directory leaves the saved position and focus unchanged', async t => {
    const h = await reader(t);
    await h.command('nextChapter');
    const before = JSON.stringify(h.state());
    const callCount = h.calls.length;
    const pending = h.command('contents');
    h.picker.hide();
    await pending;
    assert.equal(JSON.stringify(h.state()), before);
    assert.equal(h.calls.length, callCount);
});

test('switching books invalidates the old directory and retains separate positions', async t => {
    const h = await reader(t);
    await h.command('nextChapter');
    await h.command('nextChapter');
    const pending = h.command('contents');
    const oldPicker = h.picker;
    h.selectedFile = 'other.txt';
    await h.command('open');
    await pending;
    assert.ok(oldPicker.disposed);
    assert.equal(h.state().lastUri, 'other.txt');
    assert.equal(h.state().books['book.txt'].offset, h.text.indexOf('Lesson 02'));
    assert.equal(h.state().books['other.txt'].offset, 0);
    h.selectedFile = 'book.txt';
    await h.command('open');
    assert.equal(h.state().books['book.txt'].offset, h.text.indexOf('Lesson 02'));
});

test('chapter boundaries, repagination, and focus loss are safe', async t => {
    const h = await reader(t);
    await h.command('previousChapter');
    assert.equal(h.state().books['book.txt'].offset, 0);
    await h.command('nextChapter');
    await h.command('nextChapter');
    const end = h.state().books['book.txt'].offset;
    await h.command('nextChapter');
    assert.equal(h.state().books['book.txt'].offset, end);
    h.resize(12);
    await h.command('previousChapter');
    assert.equal(h.state().books['book.txt'].offset, h.text.indexOf('Lesson 01'));
    const pending = h.command('contents');
    const picker = h.picker;
    // Focus loss may race with accepting a directory entry.
    picker.accept(1);
    h.blur();
    await pending;
    await h.close();
    assert.ok(picker.disposed);
    assert.equal(h.state().books['book.txt'].offset, h.text.indexOf('Lesson 01'));
    assert.equal(h.state().hidden, true);
});
