import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
  startCompletion,
} from '@codemirror/autocomplete';
import { indentMore, indentWithTab } from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import { JSDOM } from 'jsdom';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = fs.readFileSync(path.join(repoRoot, 'dist/main.js'), 'utf8');

function waitFor(predicate, label, timeout = 1500) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for ${label}.`));
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function preserveGlobals(window) {
  const names = [
    'cancelAnimationFrame',
    'document',
    'DOMRect',
    'MutationObserver',
    'Range',
    'requestAnimationFrame',
    'Selection',
    'window',
    'Window',
  ];
  const descriptors = new Map(names.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.DOMRect = window.DOMRect;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Range = window.Range;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.Selection = window.Selection;
  globalThis.Window = window.Window;
  if (!window.Range.prototype.getClientRects) {
    window.Range.prototype.getClientRects = () => [];
  }
  if (!window.Range.prototype.getBoundingClientRect) {
    window.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
    });
  }
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function createEventEmitter() {
  const listeners = new Map();
  return {
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    off(events, listener) {
      for (const event of [].concat(events)) listeners.get(event)?.delete(listener);
    },
    on(events, listener) {
      for (const event of [].concat(events)) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      }
    },
  };
}

function coreExtensions() {
  const nativeCompletion = (context) => {
    const match = context.matchBefore(/\w*/);
    return {
      from: match?.from ?? context.pos,
      options: [{
        apply: 'nativeCall()',
        label: `${match?.text || 'native'}Native`,
      }],
    };
  };
  return [
    autocompletion({ activateOnTyping: false, interactionDelay: 0 }),
    state.EditorState.languageData.of(() => [
      { autocomplete: nativeCompletion },
    ]),
    state.Prec.highest(view.keymap.of([
      { key: 'Tab', run: acceptCompletion },
    ])),
    view.keymap.of([indentWithTab]),
  ];
}

function createCoreState(doc) {
  return state.EditorState.create({
    doc,
    extensions: coreExtensions(),
    selection: { anchor: doc.length },
  });
}

function autocompleteSourceCount(editorState) {
  return editorState.languageDataAt(
    'autocomplete',
    editorState.selection.main.head,
  ).length;
}

function pressTab(editorView) {
  const event = new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Tab',
  });
  editorView.contentDOM.dispatchEvent(event);
  return event;
}

test('production runtime self-heals real CodeMirror states and owns Tab deterministically', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const restoreGlobals = preserveGlobals(dom.window);
  let editorView;
  let splitView;
  let unmount;
  try {
    const editorEvents = createEventEmitter();
    const settingsEvents = createEventEmitter();
    const commands = new Map();
    const settings = {
      uiSettings: {},
      value: {
        'acode.plugin.snippets': {
          showInAutocomplete: false,
          snippetLocation: '',
        },
      },
      off: settingsEvents.off,
      on: settingsEvents.on,
      async update() {
        settingsEvents.emit('update:after');
      },
    };
    let javascriptReads = 0;
    let resolveTypescript;
    const fsOperation = (url) => ({
      async readFile() {
        if (url.endsWith('/javascript.snippets')) {
          javascriptReads += 1;
          if (javascriptReads < 3) {
            const error = new Error('Temporary EIO');
            error.code = 'EIO';
            throw error;
          }
          return 'snippet fun\n\tfunction ${1:name}() {$0}';
        }
        if (url.endsWith('/typescript.snippets')) {
          return new Promise((resolve) => { resolveTypescript = resolve; });
        }
        const error = new Error(`Missing file: ${url}`);
        error.code = 'ENOENT';
        throw error;
      },
    });
    const modules = {
      '@codemirror/autocomplete': {
        acceptCompletion,
        startCompletion,
      },
      '@codemirror/commands': { indentMore },
      '@codemirror/language': language,
      '@codemirror/state': state,
      '@codemirror/view': view,
      editorLanguages: {
        get: () => null,
        register() {},
        unregister() {},
      },
      helpers: {
        getIconForFile: () => 'file file_type_default',
      },
    };
    const acode = {
      addIcon() {},
      fsOperation,
      joinUrl: (left, right) => (
        `${left.replace(/\/$/, '')}/${right.replace(/^\//, '')}`
      ),
      require(id) {
        if (id === 'settings') return settings;
        return modules[id];
      },
      setPluginInit(id, callback) {
        assert.equal(id, 'acode.plugin.snippets');
        this.initPlugin = callback;
      },
      setPluginUnmount(id, callback) {
        assert.equal(id, 'acode.plugin.snippets');
        unmount = callback;
      },
    };
    const file = {
      currentMode: '',
      filename: 'demo.js',
      type: 'editor',
    };
    editorView = new view.EditorView({
      parent: dom.window.document.body,
      state: createCoreState('fun'),
    });
    editorView.commands = {
      addCommand(command) { commands.set(command.name, command); },
      removeCommand(name) { commands.delete(name); },
    };
    editorView.execCommand = () => false;
    file.session = editorView.state;
    const editorManager = {
      ...editorEvents,
      activeFile: file,
      editor: editorView,
      files: [file],
      isCodeMirror: true,
      panes: [{ activeFile: file, editor: editorView }],
    };
    Object.assign(dom.window, {
      acode,
      editorManager,
      PLUGIN_DIR: undefined,
      system: undefined,
      Terminal: undefined,
    });
    vm.runInContext(bundle, dom.getInternalVMContext());
    await acode.initPlugin('/plugin/', null, { firstInit: false });

    assert.equal(autocompleteSourceCount(editorView.state), 2);
    assert.equal(commands.has('expandSnippet'), true);
    file.currentMode = 'javascript';
    editorView.focus();
    assert.equal(startCompletion(editorView), true);
    await waitFor(() => (
      completionStatus(editorView.state) === 'active' &&
      currentCompletions(editorView.state).length === 1 &&
      selectedCompletionIndex(editorView.state) === 0
    ), 'the completion menu');
    const firstTab = pressTab(editorView);
    const duplicateTab = pressTab(editorView);
    assert.equal(firstTab.defaultPrevented, true);
    assert.equal(duplicateTab.defaultPrevented, true);
    await waitFor(
      () => editorView.state.doc.toString() === 'function name() {}',
      'the delayed snippet expansion',
    );
    assert.equal(javascriptReads, 3);

    settings.value['acode.plugin.snippets'].showInAutocomplete = true;
    editorView.setState(createCoreState('fun'));
    file.session = editorView.state;
    editorView.contentDOM.dispatchEvent(new window.Event('beforeinput', {
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(startCompletion(editorView), true);
    await waitFor(() => (
      currentCompletions(editorView.state).some(({ type }) => type === 'snippet') &&
      dom.window.document.querySelector('.cm-completionIcon-snippet')
    ), 'the rendered snippet completion icon');
    const snippetIcon = dom.window.document.querySelector(
      '.cm-tooltip.cm-tooltip-autocomplete .cm-completionIcon-snippet',
    );
    assert.ok(snippetIcon);
    assert.equal(
      snippetIcon.closest('li')?.textContent.includes('fun'),
      true,
    );
    assert.equal(
      dom.window.document.querySelectorAll('.cm-completionIcon-snippet').length,
      1,
    );
    closeCompletion(editorView);

    editorView.setState(createCoreState('ordinary'));
    file.session = editorView.state;
    assert.equal(autocompleteSourceCount(editorView.state), 1);
    editorView.contentDOM.dispatchEvent(new window.Event('beforeinput', {
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(autocompleteSourceCount(editorView.state), 2);
    assert.equal(file.session, editorView.state);

    assert.equal(startCompletion(editorView), true);
    await waitFor(
      () => (
        completionStatus(editorView.state) === 'active' &&
        currentCompletions(editorView.state).length === 1 &&
        selectedCompletionIndex(editorView.state) === 0
      ),
      'the native completion menu',
    );
    const nativeTab = pressTab(editorView);
    assert.equal(nativeTab.defaultPrevented, true);
    assert.equal(editorView.state.doc.toString(), 'nativeCall()');

    editorView.setState(createCoreState('line\n'));
    file.session = editorView.state;
    editorView.contentDOM.dispatchEvent(new window.Event('focusin', {
      bubbles: true,
    }));
    pressTab(editorView);
    assert.equal(editorView.state.doc.toString(), 'line\n  ');

    editorView.setState(createCoreState('settings'));
    file.session = editorView.state;
    await settings.update();
    assert.equal(autocompleteSourceCount(editorView.state), 2);

    editorView.setState(createCoreState('renamed'));
    file.session = editorView.state;
    editorEvents.emit('rename-file', file);
    assert.equal(autocompleteSourceCount(editorView.state), 2);

    const splitFile = {
      currentMode: 'javascript',
      filename: 'split.js',
      type: 'editor',
    };
    splitView = new view.EditorView({
      parent: dom.window.document.body,
      state: createCoreState('split'),
    });
    splitFile.session = splitView.state;
    editorManager.files.push(splitFile);
    editorManager.panes.push({ activeFile: splitFile, editor: splitView });
    editorEvents.emit('new-file', splitFile);
    assert.equal(autocompleteSourceCount(splitView.state), 2);
    splitView.setState(createCoreState('switched'));
    splitFile.session = splitView.state;
    editorEvents.emit('switch-file', splitFile);
    assert.equal(autocompleteSourceCount(splitView.state), 2);

    editorView.setState(createCoreState('fun'));
    file.session = editorView.state;
    file.currentMode = 'typescript';
    editorView.contentDOM.dispatchEvent(new window.Event('pointerdown', {
      bubbles: true,
    }));
    const staleTab = pressTab(editorView);
    assert.equal(staleTab.defaultPrevented, true);
    await waitFor(
      () => typeof resolveTypescript === 'function',
      'the TypeScript snippet read',
    );
    editorView.dispatch({ changes: { from: 3, insert: 'x' } });
    resolveTypescript('snippet fun\n\tconst ${1:name} = true;$0');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(editorView.state.doc.toString(), 'funx');

    await unmount();
    unmount = null;
    assert.equal(commands.has('expandSnippet'), false);
    assert.equal(autocompleteSourceCount(editorView.state), 1);
    assert.equal(autocompleteSourceCount(splitView.state), 1);
  } finally {
    if (unmount) await unmount();
    splitView?.destroy();
    editorView?.destroy();
    restoreGlobals();
    dom.window.close();
  }
});
