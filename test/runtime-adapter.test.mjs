import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = fs.readFileSync(path.join(repoRoot, 'dist/main.js'), 'utf8');
const pluginManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugin.json'), 'utf8'),
);

function createBaseRuntime({
  isCodeMirror,
  modules = {},
  ace,
  fileBrowser,
  fsOperation,
  settingsValue = {},
  system,
  Terminal,
  alert = () => {},
  confirm = async () => false,
  multiPrompt = async () => { throw new Error('cancelled'); },
  select = async () => { throw new Error('cancelled'); },
  loader = () => ({
    destroy() {},
    setMessage() {},
    show() {},
  }),
  consoleObject = console,
  pluginDir,
  define,
}) {
  let init;
  let unmount;
  let settingsCallback;
  let settingsList;
  const addedIcons = [];
  const iconStyles = [];
  const document = {
    createElement(tagName) {
      assert.equal(tagName, 'style');
      return {
        removed: false,
        textContent: '',
        remove() {
          this.removed = true;
        },
      };
    },
    head: {
      appendChild(element) {
        iconStyles.push(element);
      },
    },
  };
  const settingsPathValue = { textContent: '', title: '' };
  const settingsMappingsValue = { textContent: '', title: '' };
  const settingsPathRow = {
    get: (selector) => selector === '.value' ? settingsPathValue : null,
    querySelector: (selector) => selector === '.value' ? settingsPathValue : null,
  };
  const settingsMappingsRow = {
    get: (selector) => selector === '.value' ? settingsMappingsValue : null,
    querySelector: (selector) => selector === '.value'
      ? settingsMappingsValue
      : null,
  };
  const getSettingsRow = (selector) => {
    if (selector.includes('setSnippetsDirectory')) return settingsPathRow;
    if (selector.includes('languageMappings')) return settingsMappingsRow;
    return null;
  };
  const settingsListElement = {
    get: getSettingsRow,
    querySelector: getSettingsRow,
  };
  const commandNames = new Set();
  const commands = new Map();
  const listeners = new Map();
  const editor = {
    commands: {
      addCommand(command) {
        commandNames.add(command.name);
        commands.set(command.name, command);
      },
      removeCommand(name) {
        commandNames.delete(name);
        commands.delete(name);
      },
    },
    session: { $mode: null },
    setOption() {},
    on() {},
    off() {},
  };
  const editorManager = {
    isCodeMirror,
    activeFile: null,
    editor,
    files: [],
    panes: [],
    on(events, listener) {
      for (const event of [].concat(events)) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      }
    },
    off(events, listener) {
      for (const event of [].concat(events)) {
        listeners.get(event)?.delete(listener);
      }
    },
  };
  const settings = {
    uiSettings: {},
    value: settingsValue,
    updateCalls: 0,
    update() {
      this.updateCalls += 1;
    },
  };
  const acode = {
    addIcon(...args) {
      addedIcons.push(args);
    },
    require(id) {
      if (id === 'settings') return settings;
      return modules[id];
    },
    joinUrl(left, right) {
      return `${left.replace(/\/$/, '')}/${right.replace(/^\//, '')}`;
    },
    alert,
    confirm,
    fileBrowser,
    fsOperation,
    loader,
    multiPrompt,
    select,
    setPluginInit(id, callback, options) {
      assert.equal(id, 'acode.plugin.snippets');
      init = callback;
      settingsList = options?.list;
      settingsCallback = options?.cb;
      settingsPathValue.textContent = settingsList?.find(
        ({ key }) => key === 'setSnippetsDirectory',
      )?.info || '';
      settingsMappingsValue.textContent = settingsList?.find(
        ({ key }) => key === 'languageMappings',
      )?.info || '';
      settings.uiSettings[`plugin-${id}`] = {
        getListElement: () => settingsListElement,
      };
    },
    setPluginUnmount(id, callback) {
      assert.equal(id, 'acode.plugin.snippets');
      unmount = callback;
    },
  };
  const context = vm.createContext({
    acode,
    ace,
    clearTimeout,
    console: consoleObject,
    define,
    document,
    editorManager,
    self: null,
    setTimeout,
    system,
    Terminal,
    PLUGIN_DIR: pluginDir,
    window: { acode, document, system, Terminal, PLUGIN_DIR: pluginDir },
  });
  context.self = context;
  vm.runInContext(bundle, context);

  return {
    addedIcons,
    commandNames,
    editor,
    editorManager,
    executeCommand(name, target = editor) {
      return commands.get(name)?.exec(target);
    },
    emit(event) {
      for (const listener of listeners.get(event) || []) listener();
    },
    get init() {
      return init;
    },
    iconStyles,
    listenerCount(event) {
      return listeners.get(event)?.size || 0;
    },
    settings,
    get settingsList() {
      return settingsList;
    },
    get settingsPathDisplay() {
      return settingsPathValue.textContent;
    },
    get settingsMappingsDisplay() {
      return settingsMappingsValue.textContent;
    },
    get settingsCallback() {
      return settingsCallback;
    },
    get unmount() {
      return unmount;
    },
  };
}

function createSnippetFileSystem({
  filesDirectory = '/data/user/0/com.foxdebug.acode/files',
  existingFiles = {},
} = {}) {
  const dataDirectory = `file://${filesDirectory}`;
  const directories = new Set([dataDirectory]);
  const files = new Map(Object.entries(existingFiles));
  const createdDirectories = [];
  const createdFiles = [];
  const sourceReads = [];
  const join = (left, right) => `${left.replace(/\/$/, '')}/${right}`;

  return {
    createdDirectories,
    createdFiles,
    dataDirectory,
    directories,
    files,
    fsOperation(url) {
      return {
        async createDirectory(name) {
          const target = join(url, name);
          if (directories.has(target) || files.has(target)) {
            throw new Error('Path already exists');
          }
          directories.add(target);
          createdDirectories.push(target);
          return target;
        },
        async createFile(name, content) {
          const target = join(url, name);
          if (directories.has(target) || files.has(target)) {
            throw new Error('Path already exists');
          }
          files.set(target, content);
          createdFiles.push(target);
          return target;
        },
        async exists() {
          return directories.has(url) || files.has(url);
        },
        async readFile() {
          if (url.startsWith('/plugin/snippets/')) {
            sourceReads.push(url);
            return `contents:${path.posix.basename(url)}`;
          }
          if (files.has(url)) return files.get(url);
          throw new Error(`Missing file: ${url}`);
        },
      };
    },
    sourceReads,
  };
}

class TestCompartment {
  get(state) {
    return state.compartments.get(this);
  }

  of(extension) {
    return { compartment: this, extension, type: 'install' };
  }

  reconfigure(extension) {
    return { compartment: this, extension, type: 'reconfigure' };
  }
}

function createCodeMirrorModules({
  existingSnippetsLanguage = false,
  fileIcons = {},
} = {}) {
  const defineEffect = () => {
    const effectType = {
      of(value) {
        return { effectType, value, is: (candidate) => candidate === effectType };
      },
    };
    return effectType;
  };
  const languages = new Map();
  if (existingSnippetsLanguage) {
    languages.set('snippets', { name: 'snippets', source: 'core' });
  }
  const editorLanguages = {
    registerCalls: [],
    unregisterCalls: [],
    get(name) {
      return languages.get(name) || null;
    },
    register(name, extensions, caption, loader) {
      this.registerCalls.push({ caption, extensions, loader, name });
      languages.set(name, { caption, extensions, loader, name });
    },
    unregister(name) {
      this.unregisterCalls.push(name);
      languages.delete(name);
    },
  };
  class LanguageSupport {
    constructor(language, support = []) {
      this.language = language;
      this.support = support;
    }
  }
  const fileIconRequests = [];
  return {
    fileIconRequests,
    helpers: {
      getIconForFile(filename) {
        fileIconRequests.push(filename);
        const extension = filename.split('.').pop();
        return fileIcons[extension] || 'file file_type_default';
      },
    },
    editorLanguages,
    '@codemirror/autocomplete': {
      startCompletion: () => true,
    },
    '@codemirror/language': {
      indentUnit: { of: (value) => ({ indentUnit: value }) },
      LanguageSupport,
      StreamLanguage: {
        define: (parser) => ({ parser }),
      },
      syntaxTree: () => ({ resolveInner: () => null }),
    },
    '@codemirror/state': {
      Annotation: { define: defineEffect },
      Compartment: TestCompartment,
      EditorSelection: {
        create: (ranges) => ({ ranges, main: ranges[0] }),
        range: (from, to) => ({ from, to, head: to }),
      },
      EditorState: {
        languageData: { of: (provider) => ({ provider }) },
      },
      Prec: { highest: (extension) => extension },
      StateEffect: {
        appendConfig: { of: (value) => ({ type: 'append', value }) },
        define: defineEffect,
      },
      StateField: { define: (specification) => ({ specification }) },
      Transaction: {
        addToHistory: { of: (value) => ({ value }) },
      },
    },
    '@codemirror/view': {
      Decoration: {
        mark: () => ({ range: (from, to) => ({ from, to }) }),
        none: [],
        set: (ranges) => ranges,
      },
      EditorView: {
        baseTheme: (theme) => theme,
        decorations: { from: (...args) => args },
      },
      ViewPlugin: { fromClass: (plugin) => plugin },
      keymap: { of: (bindings) => bindings },
    },
  };
}

function createState(text = '') {
  const mainSelection = {
    empty: true,
    from: text.length,
    head: text.length,
    to: text.length,
  };
  const state = {
    compartments: new Map(),
    doc: {
      length: text.length,
      lineAt() {
        return { from: 0, number: 1, text };
      },
      sliceString(from, to) {
        return text.slice(from, to);
      },
    },
    readOnly: false,
    selection: {
      main: mainSelection,
      ranges: [mainSelection],
    },
    update({ effects }) {
      const next = createState(text);
      next.compartments = new Map(this.compartments);
      if (effects?.type === 'reconfigure') {
        next.compartments.set(effects.compartment, effects.extension);
      }
      return { state: next };
    },
  };
  return state;
}

function createView(state = createState()) {
  return {
    lastDispatch: null,
    dispatch(specification) {
      this.lastDispatch = specification;
      const { effects } = specification;
      if (effects?.type === 'append') {
        this.state.compartments.set(
          effects.value.compartment,
          effects.value.extension,
        );
      } else if (effects?.type === 'reconfigure') {
        this.state.compartments.set(effects.compartment, effects.extension);
      }
    },
    state,
  };
}

async function flushAsync(iterations = 8) {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('packaged runtime selects CodeMirror without touching Ace', async () => {
  const state = createState();
  const modules = createCodeMirrorModules();
  let aceAccessed = false;
  const ace = new Proxy({}, {
    get() {
      aceAccessed = true;
      throw new Error('Ace should not be accessed in CodeMirror mode.');
    },
  });
  const runtime = createBaseRuntime({ isCodeMirror: true, modules, ace });
  Object.assign(runtime.editor, createView(state));

  await runtime.init('https://plugins.local/snippets/');
  assert.equal(aceAccessed, false);
  assert.deepEqual(runtime.addedIcons, []);
  assert.equal(runtime.iconStyles.length, 1);
  assert.match(runtime.iconStyles[0].textContent, /file_type_snippets/);
  assert.match(
    runtime.iconStyles[0].textContent,
    /https:\/\/plugins\.local\/snippets\/icon\.png/,
  );
  assert.doesNotMatch(runtime.iconStyles[0].textContent, /scale\(/);
  assert.equal(modules.editorLanguages.registerCalls.length, 1);
  const languageRegistration = modules.editorLanguages.registerCalls[0];
  assert.equal(languageRegistration.name, 'snippets');
  assert.equal([...languageRegistration.extensions].join(','), 'snippets');
  assert.equal(languageRegistration.caption, 'Snippets');
  const languageSupport = languageRegistration.loader();
  assert.equal(languageSupport.language.parser.name, 'snippets');
  assert.equal(languageSupport.support.length, 1);
  assert.equal(languageSupport.support[0].indentUnit, '\t');
  assert.equal(runtime.commandNames.has('expandSnippet'), true);
  assert.equal(
    runtime.settingsList.some(({ key }) => key === 'languageMappings'),
    true,
  );
  assert.equal(runtime.settingsMappingsDisplay, 'None');
  await runtime.unmount();
  assert.equal(runtime.commandNames.has('expandSnippet'), false);
  assert.equal(runtime.iconStyles[0].removed, true);
  assert.deepEqual(modules.editorLanguages.unregisterCalls, ['snippets']);
});

test('CodeMirror language registration refreshes open snippets without overriding modes', async () => {
  const modules = createCodeMirrorModules();
  const runtime = createBaseRuntime({ isCodeMirror: true, modules, ace: null });
  Object.assign(runtime.editor, createView());
  const modeChanges = [];
  let activeRefreshes = 0;
  const snippetFile = {
    currentMode: 'text',
    filename: 'javascript.snippets',
    setMode() {
      this.currentMode = modules.editorLanguages.get('snippets')
        ? 'snippets'
        : 'text';
      modeChanges.push(this.currentMode);
    },
    type: 'editor',
  };
  const manuallyAssignedFile = {
    currentMode: 'javascript',
    filename: 'custom.snippets',
    setMode() {
      throw new Error('A manually selected mode must not be replaced.');
    },
    type: 'editor',
  };
  runtime.editorManager.files = [snippetFile, manuallyAssignedFile];
  runtime.editorManager.activeFile = snippetFile;
  runtime.editorManager.reapplyActiveFile = () => {
    activeRefreshes += 1;
  };

  await runtime.init('/plugin/');
  assert.deepEqual(modeChanges, ['snippets']);
  assert.equal(activeRefreshes, 1);
  await runtime.unmount();
  assert.deepEqual(modeChanges, ['snippets', 'text']);
  assert.equal(activeRefreshes, 2);
});

test('CodeMirror keeps a core snippets language and only adds the file icon', async () => {
  const modules = createCodeMirrorModules({ existingSnippetsLanguage: true });
  const runtime = createBaseRuntime({ isCodeMirror: true, modules, ace: null });
  Object.assign(runtime.editor, createView());

  await runtime.init('/plugin/');
  assert.deepEqual(modules.editorLanguages.registerCalls, []);
  assert.match(runtime.iconStyles[0].textContent, /file_type_snippets/);
  await runtime.unmount();
  assert.deepEqual(modules.editorLanguages.unregisterCalls, []);
});

test('CodeMirror snippet features survive without the language registration API', async () => {
  const modules = createCodeMirrorModules();
  delete modules.editorLanguages;
  const warnings = [];
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules,
    ace: null,
    consoleObject: {
      ...console,
      warn: (...args) => warnings.push(args),
    },
  });
  Object.assign(runtime.editor, createView());

  await runtime.init('/plugin/');
  assert.equal(runtime.commandNames.has('expandSnippet'), true);
  assert.match(warnings[0][0], /language registration is unavailable/);
  await runtime.unmount();
});

test('fresh CodeMirror installs initialize every snippet in Terminal Home', async () => {
  const fileSystem = createSnippetFileSystem();
  const loaderEvents = [];
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    fsOperation: fileSystem.fsOperation,
    system: {
      getFilesDir(resolve) {
        resolve('/data/user/0/com.foxdebug.acode/files');
      },
    },
    Terminal: {},
    loader(_title, message) {
      loaderEvents.push(message);
      return {
        destroy() {},
        setMessage() {},
        show() {},
      };
    },
  });
  Object.assign(runtime.editor, createView());

  await runtime.init('/plugin/', null, { firstInit: true });

  const snippetsDirectory = `${fileSystem.dataDirectory}/public/.acode-snippets`;
  assert.deepEqual(fileSystem.createdDirectories, [
    `${fileSystem.dataDirectory}/public`,
    snippetsDirectory,
  ]);
  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    snippetsDirectory,
  );
  assert.equal(fileSystem.sourceReads.length, pluginManifest.files.length);
  assert.equal(fileSystem.createdFiles.length, pluginManifest.files.length);
  assert.deepEqual(
    [...fileSystem.files.keys()].sort(),
    pluginManifest.files
      .map((file) => `${snippetsDirectory}/${path.posix.basename(file)}`)
      .sort(),
  );
  assert.deepEqual(loaderEvents, ['Initializing snippets...']);
  assert.equal(runtime.settingsPathDisplay, '/public/.acode-snippets');
  await runtime.unmount();
});

test('fresh initialization fills missing snippets without overwriting files', async () => {
  const snippetsDirectory =
    'file:///data/user/0/com.foxdebug.acode/files/public/.acode-snippets';
  const customJavaScript = 'snippet mine\n\tcustom content';
  const fileSystem = createSnippetFileSystem({
    existingFiles: {
      [`${snippetsDirectory}/javascript.snippets`]: customJavaScript,
    },
  });
  fileSystem.directories.add(`${fileSystem.dataDirectory}/public`);
  fileSystem.directories.add(snippetsDirectory);
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    fsOperation: fileSystem.fsOperation,
    system: { getFilesDir: (resolve) => resolve(fileSystem.dataDirectory) },
    Terminal: {},
  });
  Object.assign(runtime.editor, createView());

  await runtime.init('/plugin/', null, { firstInit: true });

  assert.equal(
    fileSystem.files.get(`${snippetsDirectory}/javascript.snippets`),
    customJavaScript,
  );
  assert.equal(fileSystem.files.size, pluginManifest.files.length);
  assert.equal(fileSystem.createdFiles.length, pluginManifest.files.length - 1);
  assert.equal(fileSystem.sourceReads.length, pluginManifest.files.length - 1);
  await runtime.unmount();
});

test('existing CodeMirror settings prevent upgrade migration', async () => {
  for (const [snippetLocation, expectedDisplay] of [
    ['', 'Bundled snippets'],
    ['/custom/snippets', '/custom/snippets'],
    [
      'file:///data/user/0/com.foxdebug.acode/files/public/Snippets/',
      '/public/Snippets',
    ],
  ]) {
    let terminalHomeAccesses = 0;
    const settingsValue = {
      'acode.plugin.snippets': { snippetLocation },
    };
    const runtime = createBaseRuntime({
      isCodeMirror: true,
      modules: createCodeMirrorModules(),
      ace: null,
      settingsValue,
      system: {
        getFilesDir() {
          terminalHomeAccesses += 1;
        },
      },
      Terminal: {},
    });
    Object.assign(runtime.editor, createView());

    await runtime.init('/plugin/', null, { firstInit: true });

    assert.equal(terminalHomeAccesses, 0);
    assert.equal(
      runtime.settings.value['acode.plugin.snippets'].snippetLocation,
      snippetLocation,
    );
    assert.equal(runtime.settings.updateCalls, 0);
    assert.equal(runtime.settingsPathDisplay, expectedDisplay);
    await runtime.unmount();
  }
});

test('failed fresh initialization reports the fallback and uses bundled snippets', async () => {
  const alerts = [];
  const errors = [];
  const runtimeConsole = Object.create(console);
  runtimeConsole.error = (...args) => errors.push(args);
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    alert: (...args) => alerts.push(args),
    consoleObject: runtimeConsole,
    system: { getFilesDir: (_resolve, reject) => reject('unavailable') },
    Terminal: {},
  });
  Object.assign(runtime.editor, createView());

  await runtime.init('/plugin/', null, { firstInit: true });

  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    '',
  );
  assert.equal(runtime.commandNames.has('expandSnippet'), true);
  assert.deepEqual(alerts, [[
    'Snippets',
    'Unable to initialize editable snippets. Bundled snippets will be used.',
  ]]);
  assert.equal(errors.length, 1);
  assert.equal(runtime.settingsPathDisplay, 'Bundled snippets');
  await runtime.unmount();
});

test('only genuine uninstall clears saved settings and preserves snippet files', async () => {
  const pluginDir = 'file:///data/plugins';
  const pluginDirectory = `${pluginDir}/acode.plugin.snippets`;
  let pluginExists = true;
  let deleteCalls = 0;
  const settingsValue = {
    'acode.plugin.snippets': { snippetLocation: '/custom/snippets' },
  };
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    pluginDir,
    settingsValue,
    fsOperation(url) {
      assert.equal(url, pluginDirectory);
      return {
        async delete() {
          deleteCalls += 1;
        },
        async exists() {
          return pluginExists;
        },
      };
    },
  });
  Object.assign(runtime.editor, createView());
  await runtime.init('/plugin/');

  await runtime.unmount();
  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    '/custom/snippets',
  );
  assert.equal(runtime.settings.updateCalls, 0);

  pluginExists = false;
  await runtime.unmount();
  assert.equal(
    Object.hasOwn(runtime.settings.value, 'acode.plugin.snippets'),
    false,
  );
  assert.equal(runtime.settings.updateCalls, 1);
  assert.equal(deleteCalls, 0);
});

test('uninstall detection failures retain saved settings', async () => {
  const settingsValue = {
    'acode.plugin.snippets': { snippetLocation: '/custom/snippets' },
  };
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    pluginDir: 'file:///data/plugins',
    settingsValue,
    fsOperation() {
      return {
        async exists() {
          throw new Error('Filesystem unavailable');
        },
      };
    },
  });
  Object.assign(runtime.editor, createView());
  await runtime.init('/plugin/');

  await runtime.unmount();

  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    '/custom/snippets',
  );
  assert.equal(runtime.settings.updateCalls, 0);
});

test('CodeMirror lifecycle covers split panes, file switches, and reinstall cleanup', async () => {
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
  });
  const first = createView();
  const second = createView();
  Object.assign(runtime.editor, first);
  runtime.editorManager.panes = [
    { editor: runtime.editor, activeFile: { type: 'editor' } },
    { editor: second, activeFile: { type: 'editor' } },
  ];

  await runtime.init('/plugin/');
  assert.equal(runtime.listenerCount('switch-file'), 1);
  assert.equal(first.state.compartments.size, 1);
  assert.equal(second.state.compartments.size, 1);

  runtime.emit('file-loaded');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first.state.compartments.size, 1);
  assert.equal(second.state.compartments.size, 1);

  const third = createView();
  runtime.editorManager.panes.push({
    editor: third,
    activeFile: { type: 'editor' },
  });
  runtime.emit('switch-file');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(third.state.compartments.size, 1);

  runtime.editor.state = createState('missing extension after a restored state');
  assert.equal(runtime.editor.state.compartments.size, 0);
  assert.equal(runtime.executeCommand('expandSnippet', runtime.editor), false);
  assert.equal(runtime.editor.state.compartments.size, 1);

  await runtime.unmount();
  assert.equal(runtime.listenerCount('switch-file'), 0);
  for (const view of [runtime.editor, second, third]) {
    const extensions = [...view.state.compartments.values()];
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0].length, 0);
  }

  await runtime.init('/plugin/');
  assert.equal(runtime.listenerCount('switch-file'), 1);
  assert.equal(runtime.editor.state.compartments.size, 2);
  await runtime.unmount();
});

test('custom snippet directories apply and reset without restarting', async () => {
  const readUrls = [];
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    fileBrowser: async () => ({ url: '/custom' }),
    fsOperation(url) {
      return {
        async lsDir() {
          return [{ name: 'javascript.snippets' }];
        },
        async readFile() {
          readUrls.push(url);
          return 'snippet fn\n\tfunction ${1:name}() {$0}';
        },
      };
    },
  });
  const file = {
    currentMode: 'javascript',
    filename: 'demo.js',
    type: 'editor',
  };
  const view = createView();
  Object.assign(runtime.editor, view);
  runtime.editorManager.activeFile = file;
  runtime.editorManager.panes = [{ editor: runtime.editor, activeFile: file }];

  await runtime.init('/plugin/');
  assert.equal(readUrls.at(-1), '/plugin/snippets/javascript.snippets');
  assert.equal(runtime.settingsPathDisplay, 'Bundled snippets');

  runtime.settingsCallback('setSnippetsDirectory');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    '/custom',
  );
  assert.equal(readUrls.at(-1), '/custom/javascript.snippets');
  assert.equal(runtime.settingsPathDisplay, '/custom');

  runtime.settingsCallback('resetSnippetsDirectory');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    runtime.settings.value['acode.plugin.snippets'].snippetLocation,
    '',
  );
  assert.equal(readUrls.at(-1), '/plugin/snippets/javascript.snippets');
  assert.equal(runtime.settingsPathDisplay, 'Bundled snippets');
  await runtime.unmount();
});

test('CodeMirror mappings select snippets separately for each directory', async () => {
  const defaultDirectory =
    'file:///data/user/0/com.foxdebug.acode/files/public/.acode-snippets';
  const customDirectory = '/custom';
  const fileSelections = [{ url: customDirectory }];
  const reads = [];
  const settingsValue = {
    'acode.plugin.snippets': {
      snippetLocation: `${defaultDirectory}/`,
      modeMappingsByLocation: {
        [defaultDirectory]: { zig: 'rust' },
        [customDirectory]: { zig: 'javascript' },
        $bundled: { zig: 'html' },
      },
    },
  };
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    settingsValue,
    fileBrowser: async () => fileSelections.shift(),
    fsOperation(url) {
      return {
        async lsDir() {
          return [{ name: 'javascript.snippets' }];
        },
        async readFile() {
          reads.push(url);
          if (url.endsWith('/rust.snippets')) {
            return 'snippet rustOnly\n\tconst rust = true;';
          }
          if (url.endsWith('/javascript.snippets')) {
            return 'snippet javascriptOnly\n\tconst javascript = true;';
          }
          if (url.endsWith('/html.snippets')) {
            return 'snippet htmlOnly\n\t<div></div>';
          }
          throw new Error(`Missing file: ${url}`);
        },
      };
    },
  });
  const file = { currentMode: 'zig', filename: 'demo.zig', type: 'editor' };
  const state = createState('rustOnly');
  const view = createView(state);
  Object.assign(runtime.editor, view);
  runtime.editorManager.activeFile = file;
  runtime.editorManager.panes = [{ editor: runtime.editor, activeFile: file }];

  await runtime.init('/plugin/');
  const extension = [...state.compartments.values()][0];
  const completionSource = extension[0].provider()[0].autocomplete;
  const getLabels = async () => {
    const result = await completionSource({
      aborted: false,
      explicit: true,
      pos: state.doc.length,
      state,
    });
    return [...result.options].map(({ label }) => label);
  };

  assert.deepEqual(await getLabels(), ['rustOnly']);
  assert.equal(runtime.settingsMappingsDisplay, '1 mapping');
  assert.equal(reads.at(-1), `${defaultDirectory}/rust.snippets`);
  assert.equal(runtime.executeCommand('expandSnippet', view), true);

  runtime.settingsCallback('setSnippetsDirectory');
  await flushAsync();
  assert.deepEqual(await getLabels(), ['javascriptOnly']);
  assert.equal(reads.at(-1), `${customDirectory}/javascript.snippets`);

  runtime.settingsCallback('resetSnippetsDirectory');
  await flushAsync();
  assert.deepEqual(await getLabels(), ['htmlOnly']);
  assert.equal(reads.at(-1), '/plugin/snippets/html.snippets');
  assert.deepEqual(
    Object.keys(
      runtime.settings.value['acode.plugin.snippets'].modeMappingsByLocation,
    ).sort(),
    ['$bundled', customDirectory, defaultDirectory].sort(),
  );
  await runtime.unmount();
});

test('language mapping manager validates and manages mappings without raw JSON', async () => {
  const settingsValue = {
    'acode.plugin.snippets': { snippetLocation: '/custom' },
  };
  const alerts = [];
  const selectQueue = [];
  const promptQueue = [];
  const confirmQueue = [];
  const promptCalls = [];
  const selectCalls = [];
  const cancel = Symbol('cancel');
  const select = async (...args) => {
    selectCalls.push(args);
    const value = selectQueue.shift();
    if (value === cancel || value === undefined) throw new Error('cancelled');
    return value;
  };
  const multiPrompt = async (...args) => {
    promptCalls.push(args);
    const value = promptQueue.shift();
    if (value === cancel || value === undefined) throw new Error('cancelled');
    return value;
  };
  const modules = createCodeMirrorModules({
    fileIcons: {
      javascript: 'file file_type_default file_type_javascript',
      rust: 'file file_type_default file_type_rust',
    },
  });
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules,
    ace: null,
    settingsValue,
    alert: (...args) => alerts.push(args),
    confirm: async () => confirmQueue.shift() ?? false,
    multiPrompt,
    select,
    fsOperation(url) {
      return {
        async readFile() {
          if (
            url.endsWith('/rust.snippets') ||
            url.endsWith('/javascript.snippets')
          ) return 'snippet mapped\n\tconst mapped = true;';
          throw new Error(`Missing file: ${url}`);
        },
      };
    },
  });
  const file = { currentMode: 'zig', filename: 'demo.zig', type: 'editor' };
  const view = createView();
  Object.assign(runtime.editor, view);
  runtime.editorManager.activeFile = file;
  runtime.editorManager.panes = [{ editor: runtime.editor, activeFile: file }];
  await runtime.init('/plugin/');

  const runManager = async (actions, promptValue, confirmations = []) => {
    selectQueue.push(...actions, cancel);
    if (promptValue !== undefined) promptQueue.push(promptValue);
    confirmQueue.push(...confirmations);
    runtime.settingsCallback('languageMappings');
    await flushAsync();
  };
  const getMappings = () => JSON.parse(JSON.stringify(
    runtime.settings.value['acode.plugin.snippets']
      .modeMappingsByLocation?.['/custom'] || {},
  ));

  await runManager(['$add'], cancel);
  assert.deepEqual(getMappings(), {});

  await runManager(['$add'], { mode: '../zig', scope: 'rust' });
  assert.deepEqual(getMappings(), {});
  assert.equal(alerts.at(-1)[0], 'Invalid mapping');

  await runManager(['$add'], { mode: 'zig', scope: 'missing' });
  assert.deepEqual(getMappings(), {});
  assert.equal(alerts.at(-1)[0], 'Snippets file not found');

  await runManager(['$add'], { mode: 'zig', scope: 'Rust.snippets' });
  assert.deepEqual(getMappings(), { zig: 'rust' });
  assert.equal(runtime.settingsMappingsDisplay, '1 mapping');
  const promptInputs = promptCalls.at(-1)[1];
  assert.equal(promptInputs[0][0], 'Language mode');
  assert.equal(promptInputs[0][1].placeholder, 'e.g. zig');
  assert.equal(promptInputs[0][1].value, 'zig');
  assert.equal(promptInputs[1][0], 'Snippets file');
  assert.equal(
    promptInputs[1][1].placeholder,
    'e.g. rust or rust.snippets',
  );
  const mappingMenu = selectCalls.at(-1);
  assert.equal(mappingMenu[0], 'Language mappings');
  assert.equal(
    mappingMenu[1].every((option) => option.subText === undefined),
    true,
  );
  const addOption = mappingMenu[1].find(({ value }) => value === '$add');
  assert.equal(addOption.text, 'Add');
  assert.equal(addOption.icon, 'add');
  const mappingOption = mappingMenu[1].find(
    ({ value }) => value === 'mapping:zig',
  );
  assert.equal(mappingOption.text, 'zig → rust.snippets');
  assert.equal(
    mappingOption.icon,
    'file file_type_default file_type_rust',
  );
  assert.equal(modules.fileIconRequests.at(-1), 'snippet.rust');
  const resetOption = mappingMenu[1].find(({ value }) => value === '$reset');
  assert.equal(resetOption.text, 'Reset');
  assert.equal(resetOption.icon, 'historyrestore');

  await runManager(
    ['mapping:zig', '$edit'],
    { mode: 'zig', scope: 'javascript' },
  );
  assert.deepEqual(getMappings(), { zig: 'javascript' });
  const mappingActions = selectCalls.find(
    ([title]) => title === 'zig → rust.snippets',
  );
  assert.deepEqual(
    [...mappingActions[1]].map(({ value, icon }) => ({ value, icon })),
    [
      { value: '$edit', icon: 'edit' },
      { value: '$delete', icon: 'delete' },
    ],
  );

  await runManager(['$add'], { mode: 'go', scope: 'rust' });
  assert.deepEqual(getMappings(), { zig: 'javascript', go: 'rust' });
  assert.equal(runtime.settingsMappingsDisplay, '2 mappings');

  await runManager(['$add'], { mode: 'go', scope: 'javascript' }, [false]);
  assert.deepEqual(getMappings(), { zig: 'javascript', go: 'rust' });

  await runManager(['mapping:zig', '$delete'], undefined, [true]);
  assert.deepEqual(getMappings(), { go: 'rust' });
  assert.equal(runtime.settingsMappingsDisplay, '1 mapping');

  await runManager(['$reset'], undefined, [true]);
  assert.deepEqual(getMappings(), {});
  assert.equal(runtime.settingsMappingsDisplay, 'None');
  assert.equal(
    'modeMappingsByLocation' in
      runtime.settings.value['acode.plugin.snippets'],
    false,
  );
  await runtime.unmount();
});

test('language mapping rows use target file icons with explorer fallback', async () => {
  const settingsValue = {
    'acode.plugin.snippets': {
      snippetLocation: '/custom',
      modeMappingsByLocation: {
        '/custom': {
          cpp: 'c_cpp',
          custom: 'constructor',
          javascript: 'javascript',
          plain: 'unsupported',
          rust: 'rust',
          zig: 'zig',
        },
      },
    },
  };
  const selectCalls = [];
  const modules = createCodeMirrorModules({
    fileIcons: {
      cpp: 'file file_type_default file_type_cpp',
      javascript: 'file file_type_default file_type_javascript',
      rust: 'file file_type_default file_type_rust',
      zig: 'file file_type_default file_type_zig',
    },
  });
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules,
    ace: null,
    settingsValue,
    select: async (...args) => {
      selectCalls.push(args);
      throw new Error('cancelled');
    },
  });
  Object.assign(runtime.editor, createView());
  await runtime.init('/plugin/');

  runtime.settingsCallback('languageMappings');
  await flushAsync();

  const options = selectCalls[0][1];
  const optionFor = (mode) => options.find(
    ({ value }) => value === `mapping:${mode}`,
  );
  assert.equal(
    optionFor('javascript').icon,
    'file file_type_default file_type_javascript',
  );
  assert.equal(
    optionFor('zig').icon,
    'file file_type_default file_type_zig',
  );
  assert.equal(
    optionFor('rust').icon,
    'file file_type_default file_type_rust',
  );
  assert.equal(
    optionFor('cpp').icon,
    'file file_type_default file_type_cpp',
  );
  assert.equal(optionFor('custom').icon, 'file file_type_default');
  assert.equal(optionFor('plain').icon, 'file file_type_default');
  assert.deepEqual(
    modules.fileIconRequests,
    [
      'snippet.cpp',
      'snippet.constructor',
      'snippet.javascript',
      'snippet.unsupported',
      'snippet.rust',
      'snippet.zig',
    ],
  );
  assert.doesNotMatch(
    modules.fileIconRequests.join(','),
    /function Object/,
  );
  assert.equal(options.find(({ value }) => value === '$add').icon, 'add');
  assert.equal(
    options.find(({ value }) => value === '$reset').icon,
    'historyrestore',
  );
  assert.equal(options.every((option) => option.subText === undefined), true);
  assert.deepEqual(runtime.addedIcons, []);
  assert.match(runtime.iconStyles[0].textContent, /file_type_snippets/);
  await runtime.unmount();
});

test('CodeMirror snippet completions are prioritized above built-in results', async () => {
  const runtime = createBaseRuntime({
    isCodeMirror: true,
    modules: createCodeMirrorModules(),
    ace: null,
    fsOperation() {
      return {
        async readFile() {
          return [
            'snippet fun',
            '\tfunction ${1:name}() {$0}',
            'snippet unrelated',
            '\tconst ${1:value} = true;',
            'snippet fun',
            '\tfunction ${1:other}() {$0}',
          ].join('\n');
        },
      };
    },
  });
  const file = {
    currentMode: 'javascript',
    filename: 'demo.js',
    type: 'editor',
  };
  const state = createState('fun');
  const view = createView(state);
  Object.assign(runtime.editor, view);
  runtime.editorManager.activeFile = file;
  runtime.editorManager.panes = [{ editor: runtime.editor, activeFile: file }];

  await runtime.init('/plugin/');
  const extension = [...state.compartments.values()][0];
  const completionSource = extension[0].provider()[0].autocomplete;
  const result = await completionSource({
    aborted: false,
    explicit: false,
    pos: 3,
    state,
  });
  const completion = result.options.find(({ label }) => label === 'fun');

  assert.equal(result.options.length, 3);
  assert.equal(result.options.filter(({ label }) => label === 'fun').length, 2);
  assert.equal(result.options.some(({ label }) => label === 'unrelated'), true);
  assert.equal(completion.boost, 99);
  assert.equal(completion.section, undefined);
  await runtime.unmount();
});

test('CodeMirror resolves selection variables independently for each cursor', async () => {
  const createSelection = (from, to) => ({
    empty: from === to,
    from,
    head: to,
    to,
  });
  const createRuntime = (text, selections) => {
    const runtime = createBaseRuntime({
      isCodeMirror: true,
      modules: createCodeMirrorModules(),
      ace: null,
      fsOperation() {
        return {
          async readFile() {
            return 'snippet x\n\t${SELECTION}';
          },
        };
      },
    });
    const state = createState(text);
    state.selection = { main: selections[0], ranges: selections };
    const view = createView(state);
    const file = {
      currentMode: 'javascript',
      filename: 'demo.js',
      type: 'editor',
    };
    Object.assign(runtime.editor, view);
    runtime.editorManager.activeFile = file;
    runtime.editorManager.panes = [{ editor: runtime.editor, activeFile: file }];
    return { runtime, state, view };
  };

  const completionCase = createRuntime('one two', [
    createSelection(0, 3),
    createSelection(4, 7),
  ]);
  await completionCase.runtime.init('/plugin/');
  const extension = [...completionCase.state.compartments.values()][0];
  const completionSource = extension[0].provider()[0].autocomplete;
  const completionResult = await completionSource({
    aborted: false,
    explicit: true,
    pos: 3,
    state: completionCase.state,
  });
  const completion = completionResult.options.find(({ label }) => label === 'x');
  assert.equal(completion.apply(completionCase.view, completion, 0, 3), true);
  assert.deepEqual(
    Array.from(
      completionCase.view.lastDispatch.changes,
      ({ from, insert, to }) => ({ from, insert, to }),
    ),
    [
      { from: 0, insert: 'one', to: 3 },
      { from: 4, insert: 'two', to: 7 },
    ],
  );
  await completionCase.runtime.unmount();

  const tabCase = createRuntime('one x two x', [
    createSelection(0, 5),
    createSelection(6, 11),
  ]);
  await tabCase.runtime.init('/plugin/');
  assert.equal(tabCase.runtime.executeCommand('expandSnippet', tabCase.view), true);
  assert.deepEqual(
    Array.from(
      tabCase.view.lastDispatch.changes,
      ({ from, insert, to }) => ({ from, insert, to }),
    ),
    [
      { from: 4, insert: 'one x', to: 5 },
      { from: 10, insert: 'two x', to: 11 },
    ],
  );
  await tabCase.runtime.unmount();
});

test('packaged runtime loads and delegates through the legacy Ace adapter', async () => {
  const setOptions = [];
  const definitions = new Map();
  const moduleCache = new Map();
  const parseCalls = [];
  const readUrls = [];
  const registrations = [];
  const expandCalls = [];
  let terminalHomeAccesses = 0;
  const define = (id, dependencies, factory) => {
    definitions.set(id, { dependencies, factory });
  };
  const requireModule = (id) => {
    if (moduleCache.has(id)) return moduleCache.get(id);
    const definition = definitions.get(id);
    if (!definition) return null;
    const module = { exports: {} };
    moduleCache.set(id, module.exports);
    const localRequire = (request) => {
      if (!request.startsWith('./')) return requireModule(request);
      const parent = id.slice(0, id.lastIndexOf('/'));
      return requireModule(`${parent}/${request.slice(2)}`);
    };
    definition.factory(localRequire, module.exports, module);
    moduleCache.set(id, module.exports);
    return module.exports;
  };
  const snippetManager = {
    files: {},
    snippetMap: {},
    variables: {},
    expandWithTab(editor) {
      expandCalls.push(editor);
      return true;
    },
    parseSnippetFile(snippetText) {
      parseCalls.push(snippetText);
      return [{ content: snippetText, tabTrigger: 'loaded' }];
    },
    register(snippets, scope) {
      registrations.push({ scope, snippets });
      this.snippetMap[scope] ||= {};
    },
  };
  const scopes = ['velocity', 'html', 'javascript', 'css'];
  const modes = Object.fromEntries(scopes.map((scope) => [
    `ace/mode/${scope}`,
    { $id: `ace/mode/${scope}` },
  ]));
  const config = { $modes: modes };
  const ace = {
    require(id) {
      if (id === 'ace/config') return config;
      if (id === 'ace/snippets') return { snippetManager };
      return requireModule(id);
    },
  };
  const runtime = createBaseRuntime({
    isCodeMirror: false,
    ace,
    define,
    settingsValue: {
      'acode.plugin.snippets': { snippetLocation: '/custom-snippets' },
    },
    fsOperation(url) {
      return {
        async readFile() {
          readUrls.push(url);
          return `snippet ${url.split('/').pop()}\n\tloaded $0`;
        },
      };
    },
    system: {
      getFilesDir() {
        terminalHomeAccesses += 1;
      },
    },
    Terminal: {},
  });
  runtime.editor.session.$mode = modes['ace/mode/velocity'];
  runtime.editorManager.activeFile = {
    filename: 'demo.vm',
    type: 'editor',
    uri: '/project/demo.vm',
  };
  runtime.editor.setOption = (name, value) => setOptions.push([name, value]);

  await runtime.init(
    'https://plugins.local/snippets/',
    null,
    { firstInit: true },
  );
  assert.deepEqual(setOptions, [
    ['enableBasicAutocompletion', true],
    ['enableLiveAutocompletion', true],
  ]);
  assert.equal(runtime.commandNames.has('expandSnippet'), true);
  assert.equal(typeof snippetManager.variables.FILEPATH, 'function');
  assert.equal(snippetManager.variables.FILEPATH(), '/project/demo.vm');
  assert.deepEqual(readUrls.slice().sort(), scopes.map(
    (scope) => `/custom-snippets/${scope}.snippets`,
  ).sort());
  assert.equal(parseCalls.length, 4);
  assert.deepEqual(
    registrations.map(({ scope }) => scope).sort(),
    scopes.slice().sort(),
  );
  assert.deepEqual(
    [...snippetManager.snippetMap.velocity.includeScopes],
    ['html', 'javascript', 'css'],
  );
  assert.equal(runtime.executeCommand('expandSnippet'), true);
  assert.deepEqual(expandCalls, [runtime.editor]);
  assert.equal(terminalHomeAccesses, 0);
  assert.deepEqual(runtime.addedIcons, []);
  assert.equal(runtime.iconStyles.length, 1);
  assert.match(runtime.iconStyles[0].textContent, /file_type_snippets/);
  assert.equal(
    runtime.settingsList.some(({ key }) => key === 'languageMappings'),
    false,
  );
  await runtime.unmount();
  assert.equal(runtime.commandNames.has('expandSnippet'), false);
  assert.deepEqual(Object.keys(snippetManager.files), []);
  assert.equal(runtime.iconStyles[0].removed, true);
});
