'use strict';

const vscode = require('vscode');
const { MAX_FILE_BYTES, readBook, paginate, pageAt, chapterAt } = require('./book');

const STATE_KEY = 'readingState.v1';
let reader;

class StatusbarReader {
    constructor(context) {
        this.context = context;
        const saved = context.globalState.get(STATE_KEY, {});
        this.state = { hidden: saved.hidden === true, lastUri: saved.lastUri, books: { ...(saved.books || {}) } };
        // Startup restores the book and its position, but starts outside reading mode.
        this.state.hidden = true;
        this.book = undefined;
        this.index = 0;
        this.generation = 0;
        this.navigationGeneration = 0;
        this.disposed = false;
        this.saveQueue = Promise.resolve();
        this.saveWarning = false;
        this.items = [];
        this.createItems();
        this.render();
    }

    createItems() {
        this.items.forEach(item => item.dispose());
        this.alignment = this.config().get('alignment', 'right');
        this.items = [
            this.createItem('menu', 104, '阅读菜单', '$(ellipsis)', 'statusbarNovel.menu'),
            this.createItem('text', 102, '小说正文', '$(book)', 'statusbarNovel.open')
        ];
    }

    config() {
        return vscode.workspace.getConfiguration('statusbarNovel');
    }

    createItem(id, priority, name, text, command) {
        const alignment = this.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
        // Lower priority puts this group toward the right edge of the right-hand area.
        const item = vscode.window.createStatusBarItem(`statusbarNovel.${id}`, alignment,
            priority + (this.alignment === 'right' ? -10000 : 0));
        item.name = `小说：${name}`;
        item.text = text;
        item.command = command;
        return item;
    }

    async applyLibraryUpdate() {
        const updateUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'library-update.json');
        let bytes;
        try {
            bytes = await vscode.workspace.fs.readFile(updateUri);
        } catch (error) {
            if (error.code === 'FileNotFound' || error.code === 'ENOENT') return;
            throw error;
        }
        if (this.disposed) return;
        const update = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (update.version !== 1 || !Array.isArray(update.additions) || !Array.isArray(update.redirects) ||
            update.additions.some(book => typeof book.uri !== 'string' || !book.uri ||
                typeof book.title !== 'string' || !Number.isFinite(book.totalLength) || book.totalLength <= 0) ||
            update.redirects.some(alias => typeof alias.from !== 'string' || !alias.from ||
                typeof alias.to !== 'string' || !alias.to || alias.from === alias.to)) {
            throw new Error('书库更新文件格式无效');
        }
        for (const alias of update.redirects) {
            const source = this.state.books[alias.from];
            const target = this.state.books[alias.to];
            if (source) {
                this.state.books[alias.to] = {
                    ...source, ...target,
                    offset: Math.max(source.offset || 0, target?.offset || 0),
                    updatedAt: Math.max(source.updatedAt || 0, target?.updatedAt || 0)
                };
                delete this.state.books[alias.from];
            }
            if (this.state.lastUri === alias.from) this.state.lastUri = alias.to;
        }
        for (const book of update.additions) {
            // Retrying an update must never reset a book that has already been read.
            if (!this.state.books[book.uri]) {
                this.state.books[book.uri] = {
                    offset: 0, updatedAt: Date.now(), title: book.title, totalLength: book.totalLength
                };
            }
            if (!this.state.lastUri) this.state.lastUri = book.uri;
        }
        // Consume the request only after VS Code has committed the progress records.
        if (await this.flush()) await vscode.workspace.fs.delete(updateUri);
    }

    async restore() {
        if (typeof this.state.lastUri !== 'string') return;
        try {
            await this.load(vscode.Uri.parse(this.state.lastUri), true);
        } catch (error) {
            if (!this.disposed) vscode.window.showWarningMessage(`小说恢复失败：${error.message}。可通过阅读菜单重新打开。`);
        }
    }

    async open() {
        const selected = await vscode.window.showOpenDialog({
            title: '打开本地小说', openLabel: '开始阅读', canSelectMany: false,
            canSelectFiles: true, canSelectFolders: false,
            filters: { '小说（TXT / EPUB）': ['txt', 'epub'] }
        });
        if (selected && selected[0] && !this.disposed) await this.load(selected[0], false);
    }

    async switchBook() {
        this.stopAuto();
        if (!await this.flush() || this.disposed) return;
        const books = Object.entries(this.state.books)
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .map(([uri, progress]) => {
                const resource = vscode.Uri.parse(uri);
                const position = Number.isFinite(progress.offset) ? progress.offset : 0;
                const percent = progress.totalLength > 0
                    ? `${Math.min(100, Math.floor(position / progress.totalLength * 100))}%`
                    : `字符位置 ${position}`;
                return {
                    label: progress.title || resource.path.split('/').pop() || uri,
                    description: `${uri === this.book?.uri ? '当前阅读 · ' : ''}${percent}`,
                    detail: resource.fsPath || uri,
                    uri
                };
            });
        const selected = await vscode.window.showQuickPick([
            { label: '$(folder-opened) 打开其他 TXT / EPUB…', open: true },
            ...books
        ], { title: '切换书籍', placeHolder: '选择书籍，自动继续上次的阅读位置', matchOnDetail: true });
        if (!selected || this.disposed) return;
        if (selected.open) await this.open();
        else if (selected.uri === this.book?.uri) await this.focus();
        else await this.load(vscode.Uri.parse(selected.uri), false);
    }

    async load(uri, restoring) {
        const generation = ++this.generation;
        this.contentsPicker?.hide();
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) throw new Error('文件过大，上限为 64 MiB');
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed || generation !== this.generation) return;
        const parsed = readBook(bytes, uri.path, this.config().get('encoding', 'auto'));
        const length = this.config().get('charactersPerPage', 28);
        const pages = paginate(parsed.text, length);
        if (!pages.length) throw new Error('书籍中没有可阅读的文字');
        // Persist the outgoing book before replacing it, including pending debounced moves.
        this.stopAuto();
        if (this.book && !await this.flush()) return;
        if (this.disposed || generation !== this.generation) return;
        const key = uri.toString();
        const previous = this.state.books[key];
        const offset = previous && Number.isFinite(previous.offset) ? previous.offset : 0;
        this.book = {
            uri: key, title: parsed.title || uri.path.split('/').pop(),
            text: parsed.text, pages, chapters: parsed.chapters
        };
        this.index = pageAt(pages, offset);
        this.state.lastUri = key;
        if (!restoring) this.state.hidden = false;
        await this.flush();
        if (this.disposed || generation !== this.generation) return;
        this.render();
        if (!restoring) await this.focus();
    }

    progress() {
        return this.book ? `${this.index + 1} / ${this.book.pages.length}` : '';
    }

    currentChapter() {
        return this.book ? chapterAt(this.book.chapters, this.book.pages[this.index].start) : -1;
    }

    async contents() {
        if (this.disposed) return;
        const book = this.book;
        if (!book) {
            vscode.window.showInformationMessage('请先打开一本 TXT 或 EPUB。');
            return;
        }
        this.stopAuto();
        if (!book.chapters.length) {
            vscode.window.showInformationMessage('未识别到章节，可继续使用“跳转阅读进度”按段号定位。');
            return;
        }
        const generation = this.generation;
        const navigationGeneration = this.navigationGeneration;
        const current = this.currentChapter();
        const items = book.chapters.map((chapter, index) => ({
            label: `${index + 1}. ${chapter.title}`.replace(/\$\(/g, '$\u200b('),
            description: `${index === current ? '当前章节 · ' : ''}书中位置 ${Math.floor(chapter.offset / book.text.length * 100)}%`,
            chapterIndex: index
        }));
        this.contentsPicker?.hide();
        const picker = vscode.window.createQuickPick();
        this.contentsPicker = picker;
        picker.title = `${book.title} · 章节目录`;
        picker.placeholder = '输入章节序号、课号或标题搜索，回车跳转';
        picker.items = items;
        const subscriptions = [];
        let selected;
        try {
            selected = await new Promise(resolve => {
                subscriptions.push(
                    picker.onDidAccept(() => {
                        if (picker.selectedItems[0]) resolve(picker.selectedItems[0]);
                    }),
                    picker.onDidHide(() => resolve(undefined))
                );
                picker.show();
                picker.activeItems = [items[Math.max(0, current)]];
            });
        } finally {
            subscriptions.forEach(subscription => subscription.dispose());
            if (this.contentsPicker === picker) this.contentsPicker = undefined;
            picker.dispose();
        }
        if (selected && !this.disposed && this.book === book && this.generation === generation &&
            this.navigationGeneration === navigationGeneration && vscode.window.state.focused) {
            await this.goToChapter(selected.chapterIndex);
        }
    }

    async goToChapter(index) {
        const book = this.book;
        if (this.disposed || !book || index < 0 || index >= book.chapters.length) return;
        const generation = this.generation;
        const navigationGeneration = this.navigationGeneration;
        this.stopAuto();
        this.index = pageAt(book.pages, book.chapters[index].offset);
        this.render();
        await this.flush();
        if (!this.disposed && this.book === book && this.generation === generation &&
            this.navigationGeneration === navigationGeneration && vscode.window.state.focused) {
            await this.focus();
        }
    }

    async moveChapter(delta) {
        if (!this.book || this.disposed) return;
        this.stopAuto();
        if (!this.book.chapters.length) {
            vscode.window.showInformationMessage('未识别到章节，可继续使用“跳转阅读进度”按段号定位。');
            return;
        }
        await this.goToChapter(this.currentChapter() + delta);
    }

    render() {
        if (this.disposed) return;
        const visible = !this.state.hidden && Boolean(this.book);
        void vscode.commands.executeCommand('setContext', 'statusbarNovel.visible', visible);
        if (this.state.hidden) {
            for (const item of this.items) item.hide();
            return;
        }
        const [menu, text] = this.items;
        text.show();
        if (!this.book) {
            menu.hide();
            text.text = '$(book) 打开小说';
            text.tooltip = '选择本地 TXT 或 EPUB 文件';
            text.command = 'statusbarNovel.open';
            return;
        }
        menu.show();
        menu.tooltip = '阅读菜单（Alt+Shift+M）';
        const page = this.book.pages[this.index];
        const hoverOnly = this.config().get('hoverOnly', false);
        const label = page.text.replace(/\s+/gu, ' ').replace(/\$\(/g, '$\u200b(');
        text.text = hoverOnly ? '$(book)' : label;
        if (!hoverOnly && this.config().get('showProgress', false)) text.text += `  ${this.progress()}`;
        text.command = 'statusbarNovel.focus';
        // appendText escapes book-supplied Markdown; only fixed, allowlisted command links are trusted.
        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = { enabledCommands: ['statusbarNovel.previous', 'statusbarNovel.next', 'statusbarNovel.menu', 'statusbarNovel.contents'] };
        const chapter = this.book.chapters[this.currentChapter()];
        tooltip.appendText(`${this.book.title}  ·  ${this.progress()}${chapter ? `\n${chapter.title}` : ''}\n\n${page.text}\n\n`);
        tooltip.appendMarkdown('[上一段](command:statusbarNovel.previous)　[下一段](command:statusbarNovel.next)　[目录](command:statusbarNovel.contents)　[菜单](command:statusbarNovel.menu)');
        tooltip.appendText('\n\n阅读状态下：1 上一段、2 下一段（可在菜单配置）。Alt+R：切换阅读模式。切换文件、操作编辑器或窗口失焦时自动隐藏。');
        text.tooltip = tooltip;
        // Do not expose book text to screen readers outside the hover in hover-only mode.
        text.accessibilityInformation = { label: hoverOnly ? '小说阅读，悬停查看，点击进入阅读状态' : page.text };
    }

    async focus() {
        if (!this.book || this.disposed) return;
        this.enteringReading = true;
        if (this.state.hidden) {
            this.state.hidden = false;
            this.saveSoon();
            this.render();
        }
        try {
            // Keep keyboard focus on the bar itself instead of highlighting its last focused item.
            await vscode.commands.executeCommand('workbench.statusBar.focusFirst');
            await vscode.commands.executeCommand('workbench.statusBar.clearFocus');
        } finally {
            this.enteringReading = false;
        }
    }

    hide() {
        this.navigationGeneration++;
        this.contentsPicker?.hide();
        if (this.disposed || this.state.hidden) return;
        this.state.hidden = true;
        this.stopAuto();
        this.saveSoon();
        this.render();
    }

    exitOnEditorInteraction() {
        if (this.enteringReading || !this.book) return;
        // Hide only: an automatic exit must preserve the user's new focus.
        this.hide();
    }

    async leave() {
        if (this.disposed) return;
        this.hide();
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }

    async keybindings() {
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@ext:local-reader.statusbar-novel-reader');
    }

    move(delta) {
        if (!this.book || this.state.hidden) return;
        const next = Math.min(this.book.pages.length - 1, Math.max(0, this.index + delta));
        if (next === this.index || next === this.book.pages.length - 1) this.stopAuto();
        this.index = next;
        this.saveSoon();
        this.render();
    }

    async toggle() {
        if (!this.state.hidden) {
            await this.leave();
            return;
        }
        this.state.hidden = false;
        this.stopAuto();
        this.saveSoon();
        this.render();
        if (this.book) await this.focus();
    }

    async jump() {
        if (!this.book) return;
        const book = this.book;
        const value = await vscode.window.showInputBox({
            title: '跳转阅读进度', prompt: `输入段号（1–${book.pages.length}）`, value: String(this.index + 1),
            validateInput: input => /^\d+$/.test(input) && Number(input) >= 1 && Number(input) <= book.pages.length
                ? undefined : `请输入 1 到 ${book.pages.length} 之间的整数`
        });
        if (value === undefined || this.disposed || this.book !== book) return;
        this.stopAuto();
        this.index = Number(value) - 1;
        this.saveSoon();
        this.render();
    }

    stopAuto() {
        clearInterval(this.autoTimer);
        this.autoTimer = undefined;
    }

    toggleAuto() {
        if (!this.book || this.state.hidden) return;
        if (this.config().get('hoverOnly', false)) {
            vscode.window.showInformationMessage('自动翻页仅在关闭“仅悬停显示正文”后可用，避免移开鼠标时继续翻页。');
            return;
        }
        if (this.autoTimer) this.stopAuto();
        else if (vscode.window.state.focused && this.index < this.book.pages.length - 1) {
            this.autoTimer = setInterval(() => this.move(1), this.config().get('autoPageSeconds', 6) * 1000);
        }
        this.render();
    }

    async updateSetting(name, value) {
        const config = this.config();
        const inspected = config.inspect(name);
        const target = inspected && inspected.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update(name, value, target);
    }

    async toggleHover() {
        await this.updateSetting('hoverOnly', !this.config().get('hoverOnly', false));
    }

    async showRight() {
        await this.updateSetting('alignment', 'right');
        await this.updateSetting('hoverOnly', false);
        if (this.disposed) return;
        this.state.hidden = false;
        this.stopAuto();
        this.saveSoon();
        this.render();
        if (!this.book) await this.open();
        else await this.focus();
    }

    settingsChanged() {
        this.stopAuto();
        if (this.alignment !== this.config().get('alignment', 'right')) this.createItems();
        if (this.book) {
            const offset = this.book.pages[this.index].start;
            this.book.pages = paginate(this.book.text, this.config().get('charactersPerPage', 28));
            this.index = pageAt(this.book.pages, offset);
            this.saveSoon();
        }
        this.render();
    }

    async menu() {
        const selected = await vscode.window.showQuickPick([
            { label: '$(folder-opened) 打开 TXT / EPUB', command: 'open' },
            { label: '$(book) 切换书籍', command: 'switchBook' },
            { label: '$(list-tree) 章节目录', description: this.book?.chapters[this.currentChapter()]?.title, command: 'contents' },
            { label: '上一章', command: 'previousChapter' },
            { label: '下一章', command: 'nextChapter' },
            { label: '$(arrow-right) 在右下角显示正文', command: 'showRight' },
            { label: '进入阅读状态（使用翻页键）', command: 'focus' },
            { label: '退出阅读并隐藏内容', command: 'leave' },
            { label: '配置翻页快捷键', command: 'keybindings' },
            { label: '$(chevron-left) 上一段', command: 'previous' },
            { label: '$(chevron-right) 下一段', command: 'next' },
            { label: '$(go-to-file) 跳转阅读进度', description: this.progress(), command: 'jump' },
            { label: '$(eye) 切换悬停阅读', description: this.config().get('hoverOnly', false) ? '当前：悬停显示' : '当前：直接显示', command: 'hover' },
            { label: this.autoTimer ? '$(debug-pause) 暂停自动翻页' : '$(play) 开始自动翻页', command: 'auto' },
            { label: this.state.hidden ? '$(eye) 恢复阅读' : '$(eye-closed) 隐藏阅读', command: 'toggle' }
        ], { title: '状态栏小说', placeHolder: this.book ? this.book.title : '请选择一本本地小说' });
        if (selected && !this.disposed) await vscode.commands.executeCommand(`statusbarNovel.${selected.command}`);
    }

    saveSoon() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { void this.flush(); }, 300);
    }

    flush() {
        clearTimeout(this.saveTimer);
        if (this.book) {
            this.state.books[this.book.uri] = {
                offset: this.book.pages[this.index].start, updatedAt: Date.now(),
                title: this.book.title, totalLength: this.book.text.length
            };
        }
        // Retain every book's progress; snapshots must not change while writes are queued.
        // Never persist book content or sync file paths.
        const books = { ...this.state.books };
        const snapshot = { ...this.state, books };
        this.saveQueue = this.saveQueue.then(async () => {
            await this.context.globalState.update(STATE_KEY, snapshot);
            this.saveWarning = false;
            return true;
        }).catch(error => {
            if (!this.saveWarning) {
                this.saveWarning = true;
                vscode.window.showWarningMessage(`小说进度保存失败：${error.message}`);
            }
            return false;
        });
        return this.saveQueue;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        this.contentsPicker?.hide();
        this.stopAuto();
        void this.flush();
        this.items.forEach(item => item.dispose());
    }
}

async function activate(context) {
    reader = new StatusbarReader(context);
    const commands = {
        open: () => reader.open(), switchBook: () => reader.switchBook(),
        menu: () => reader.menu(), next: () => reader.move(1),
        contents: () => reader.contents(), previousChapter: () => reader.moveChapter(-1), nextChapter: () => reader.moveChapter(1),
        previous: () => reader.move(-1), toggle: () => reader.toggle(), jump: () => reader.jump(),
        auto: () => reader.toggleAuto(), hover: () => reader.toggleHover(), showRight: () => reader.showRight(),
        focus: () => reader.focus(), leave: () => reader.leave(), keybindings: () => reader.keybindings()
    };
    for (const [name, action] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(`statusbarNovel.${name}`, async () => {
            try { await action(); }
            catch (error) { vscode.window.showErrorMessage(`小说阅读失败：${error.message}`); }
        }));
    }
    context.subscriptions.push(reader,
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('statusbarNovel')) reader.settingsChanged();
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) reader.exitOnEditorInteraction();
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
                event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) reader.exitOnEditorInteraction();
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (event.contentChanges.length && editor && event.document === editor.document) reader.exitOnEditorInteraction();
        }),
        vscode.window.onDidChangeActiveTerminal(terminal => {
            if (terminal) reader.exitOnEditorInteraction();
        }),
        vscode.window.onDidChangeWindowState(state => {
            if (!state.focused) reader.hide();
        })
    );
    try {
        await reader.applyLibraryUpdate();
    } catch (error) {
        vscode.window.showWarningMessage(`书库更新失败：${error.message}`);
    }
    await reader.restore();
}

function deactivate() {
    if (!reader) return;
    reader.dispose();
    return reader.saveQueue;
}

module.exports = { activate, deactivate };
