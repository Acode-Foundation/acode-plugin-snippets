import ajax from '@deadlyjack/ajax';
import pluginManifest from '../plugin.json';
import { createCodeMirrorSnippetSession } from './codemirror-snippet-session.mjs';
import { createSnippetsLanguage } from './snippets-language.mjs';
import {
  compileSnippetTemplate,
  createSnippetVariables,
  findMatchingSnippet,
  getCompletionPrefix,
  normalizeModeMapping,
  normalizeModeMappings,
  parseSnippetFile,
  resolveActiveSnippetScopes,
  resolvePreloadSnippetScopes,
  SnippetCache,
} from './snippet-utils.mjs';

const pluginId = pluginManifest.id;
const appSettings = acode.require('settings');
const BUNDLED_MAPPINGS_KEY = '$bundled';
const ADD_MAPPING_ACTION = '$add';
const RESET_MAPPINGS_ACTION = '$reset';
const EDIT_MAPPING_ACTION = '$edit';
const DELETE_MAPPING_ACTION = '$delete';
const SNIPPETS_LANGUAGE = 'snippets';
const DEFAULT_FILE_ICON = 'file file_type_default';
const FILE_ICON_SCOPE_ALIASES = Object.freeze({
  c_cpp: 'cpp',
});
const CODEMIRROR_EDITOR_EVENTS = Object.freeze([
  'switch-file',
  'file-loaded',
  'new-file',
  'rename-file',
  'editor-state-changed',
  'update:read-only',
]);
const CODEMIRROR_INTERACTION_EVENTS = Object.freeze([
  'focusin',
  'pointerdown',
  'beforeinput',
]);
const RECONCILE_DELAYS = Object.freeze([0, 50, 250]);
const SCOPE_RETRY_DELAYS = Object.freeze([0, 50, 200]);
const SCOPE_FAILURE_COOLDOWN = 5000;
const EMPTY_SCOPE_RESULT = Object.freeze({ snippets: [], unsupported: [] });

function isMissingSnippetError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || error || '');
  return code === 'ENOENT' || status === 404 ||
    /(?:missing file|not found|does not exist|no such file|\b404\b)/i.test(message);
}

class AceSnippetsAdapter {
  constructor(host) {
    this.host = host;
    this.config = null;
    this.snippetManager = null;
    this.changeModeListener = this.onChangeMode.bind(this);
  }

  async init() {
    this.config = ace.require('ace/config');
    this.snippetManager = ace.require('ace/snippets')?.snippetManager;
    if (!this.config || !this.snippetManager) {
      throw new Error('Ace snippets API is unavailable.');
    }

    this.setVariables();
    const { editor } = editorManager;
    editor.setOption('enableBasicAutocompletion', true);
    editor.setOption('enableLiveAutocompletion', true);
    editor.on('changeMode', this.changeModeListener);
    editor.commands.addCommand({
      name: 'expandSnippet',
      description: 'Expand snippet',
      exec: (activeEditor) => this.snippetManager.expandWithTab(activeEditor),
      bindKey: { win: 'Tab' },
    });
    await this.onChangeMode();
  }

  async destroy() {
    const { editor } = editorManager;
    editor.off?.('changeMode', this.changeModeListener);
    editor.commands.removeCommand('expandSnippet');
    if (this.snippetManager?.files) this.snippetManager.files = {};
  }

  async refresh() {
    if (!this.snippetManager) return;
    this.snippetManager.files = {};
    await this.onChangeMode();
  }

  async onChangeMode() {
    await this.loadSnippetsForMode(editorManager.editor?.session?.$mode);
  }

  async loadSnippetsForMode(mode) {
    if (typeof mode === 'string') mode = this.config.$modes[mode];
    if (!mode) return;

    if (!this.snippetManager.files) this.snippetManager.files = {};
    await this.loadSnippetFile(mode);
    if (mode.modes) {
      await Promise.all(mode.modes.map((childMode) => (
        this.loadSnippetsForMode(childMode)
      )));
    }
  }

  async loadSnippetFile({ $id: id }) {
    if (!id || this.snippetManager.files[id]) return;

    const modeName = id.split('/').pop();
    this.snippetManager.files[id] = {};
    try {
      let snippetText = '';
      try {
        snippetText = await this.host.readSnippetScope(modeName);
      } catch {
        // Missing snippet files are valid for unsupported modes.
      }

      this.defineSnippets(
        modeName,
        snippetText,
        this.host.getIncludedScopes(modeName),
      );
      const snippetModule = ace.require(`ace/snippets/${modeName}`);
      if (!snippetModule) {
        this.snippetManager.files[id] = true;
        return;
      }

      this.snippetManager.files[id] = snippetModule;
      if (!snippetModule.snippets && snippetModule.snippetText) {
        snippetModule.snippets = this.snippetManager.parseSnippetFile(
          snippetModule.snippetText,
        );
      }
      this.snippetManager.register(
        snippetModule.snippets || [],
        snippetModule.scope,
      );

      if (snippetModule.includeScopes) {
        this.snippetManager.snippetMap[snippetModule.scope].includeScopes =
          snippetModule.includeScopes;
        await Promise.all(snippetModule.includeScopes.map((scope) => (
          this.loadSnippetsForMode(`ace/mode/${scope}`)
        )));
      }
    } catch (error) {
      console.error(error);
    }
  }

  defineSnippets(scope, snippets, includeScopes) {
    if (!snippets) return;
    define(
      `ace/snippets/${scope}.snippets`,
      ['require', 'exports', 'module'],
      (require, exports, module) => {
        module.exports = snippets;
      },
    );
    define(
      `ace/snippets/${scope}`,
      ['require', 'exports', 'module', `ace/snippets/${scope}.snippets`],
      (require, exports) => {
        exports.snippetText = require(`./${scope}.snippets`);
        exports.scope = scope;
        exports.includeScopes = includeScopes;
      },
    );
  }

  setVariables() {
    this.snippetManager.variables.FILEPATH = () => {
      const { SAFMode, uri, filename } = editorManager.activeFile || {};
      if (!uri || SAFMode === 'single') return filename || '';
      return uri;
    };
  }
}

class CodeMirrorSnippetsAdapter {
  constructor(host) {
    this.host = host;
    this.cache = new SnippetCache(
      (scope) => this.loadScope(scope),
      { failureCooldown: SCOPE_FAILURE_COOLDOWN },
    );
    this.warnedScopes = new Set();
    this.failedScopes = new Set();
    this.destroyed = false;
    this.installedViews = new Set();
    this.pendingTabs = new Map();
    this.reconcileTimers = new Map();
    this.retryWaits = new Map();
    this.completionSource = this.getCompletions.bind(this);
    this.handleEditorChange = this.scheduleReconcile.bind(this);
    this.handleSettingsUpdate = this.scheduleReconcile.bind(this);
    this.handleInteraction = this.onInteraction.bind(this);
    this.handleKeyDown = this.onKeyDown.bind(this);
  }

  async init() {
    const autocomplete = acode.require('@codemirror/autocomplete');
    const commands = acode.require('@codemirror/commands');
    const state = acode.require('@codemirror/state');
    const view = acode.require('@codemirror/view');
    const language = acode.require('@codemirror/language');
    if (
      !autocomplete?.acceptCompletion ||
      !autocomplete?.startCompletion ||
      !commands?.indentMore ||
      !state?.Compartment ||
      !state?.EditorState ||
      !state?.StateEffect ||
      !state?.StateField ||
      !view?.EditorView ||
      !view?.ViewPlugin ||
      !view?.Decoration ||
      !language?.syntaxTree
    ) {
      throw new Error('CodeMirror snippets API is unavailable.');
    }

    this.acceptCompletion = autocomplete.acceptCompletion;
    this.startCompletion = autocomplete.startCompletion;
    this.indentMore = commands.indentMore;
    this.EditorState = state.EditorState;
    this.StateEffect = state.StateEffect;
    this.syntaxTree = language.syntaxTree;
    this.indentUnit = language.indentUnit;
    this.session = createCodeMirrorSnippetSession(
      { state, view },
      {
        startCompletion: this.startCompletion,
        tab: (editorView) => this.handleTabCommand(editorView),
      },
    );
    this.compartment = new state.Compartment();
    this.extension = [
      this.EditorState.languageData.of(() => [
        { autocomplete: this.completionSource },
      ]),
      this.session.extension,
    ];

    editorManager.on(CODEMIRROR_EDITOR_EVENTS, this.handleEditorChange);
    appSettings.on?.('update:after', this.handleSettingsUpdate);
    for (const eventName of CODEMIRROR_INTERACTION_EVENTS) {
      document.addEventListener?.(eventName, this.handleInteraction, true);
    }
    document.addEventListener?.('keydown', this.handleKeyDown, true);
    editorManager.editor.commands.addCommand({
      name: 'expandSnippet',
      description: 'Expand snippet',
      exec: (view) => this.handleTabCommand(view),
      bindKey: { win: 'Tab' },
    });

    this.reconcileEditors();
    await this.preloadVisibleFiles();
  }

  async destroy() {
    this.destroyed = true;
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
    this.pendingTabs.clear();
    for (const [timer, resolve] of this.retryWaits) {
      clearTimeout(timer);
      resolve();
    }
    this.retryWaits.clear();
    editorManager.off(CODEMIRROR_EDITOR_EVENTS, this.handleEditorChange);
    appSettings.off?.('update:after', this.handleSettingsUpdate);
    for (const eventName of CODEMIRROR_INTERACTION_EVENTS) {
      document.removeEventListener?.(eventName, this.handleInteraction, true);
    }
    document.removeEventListener?.('keydown', this.handleKeyDown, true);
    editorManager.editor.commands.removeCommand('expandSnippet');

    const installedViews = new Set([
      ...this.installedViews,
      ...this.getVisibleEditors(),
    ]);
    for (const view of installedViews) {
      if (this.compartment.get(view.state) === undefined) continue;
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
        this.syncFileSession(view);
      } catch {
        // A removed split pane may already have destroyed its EditorView.
      }
    }
    this.installedViews.clear();

    for (const file of editorManager.files || []) {
      if (file?.type !== 'editor') continue;
      const state = file.session?.__rawState || file.session;
      if (!state || this.compartment.get(state) === undefined) continue;
      file.session = state.update({
        effects: this.compartment.reconfigure([]),
      }).state;
    }

    this.cache.clear();
    this.failedScopes.clear();
    this.session = null;
  }

  async refresh() {
    this.pendingTabs.clear();
    this.cache.clear();
    this.warnedScopes.clear();
    this.failedScopes.clear();
    this.reconcileEditors();
    await this.preloadVisibleFiles();
  }

  scheduleReconcile(candidate) {
    this.reconcileEditors(candidate);
    for (const milliseconds of RECONCILE_DELAYS) {
      clearTimeout(this.reconcileTimers.get(milliseconds));
      const timer = setTimeout(() => {
        this.reconcileTimers.delete(milliseconds);
        if (this.destroyed) return;
        this.reconcileEditors();
        void this.preloadVisibleFiles();
      }, milliseconds);
      this.reconcileTimers.set(milliseconds, timer);
    }
  }

  getVisibleEditors() {
    const panes = editorManager.panes || [];
    const views = panes.map((pane) => pane?.editor).filter(Boolean);
    if (editorManager.editor) views.push(editorManager.editor);
    return [...new Set(views)];
  }

  reconcileEditors(candidate) {
    if (candidate?.state) this.installInEditor(candidate);
    for (const view of this.getVisibleEditors()) {
      this.installInEditor(view);
    }
  }

  getViewForEvent(event) {
    const path = typeof event?.composedPath === 'function'
      ? event.composedPath()
      : [event?.target];
    return this.getVisibleEditors().find((view) => path.some((element) => (
      element && (
        element === view.dom ||
        element === view.contentDOM ||
        (
          typeof element.nodeType === 'number' &&
          view.dom?.contains?.(element)
        )
      )
    ))) || null;
  }

  onInteraction(event) {
    const view = this.getViewForEvent(event);
    if (!view) return;
    this.installInEditor(view);
    void this.preloadView(view);
  }

  onKeyDown(event) {
    if (
      event?.key !== 'Tab' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) return;

    const view = this.getViewForEvent(event);
    if (!view) return;
    this.installInEditor(view);

    let handled = false;
    if (event.shiftKey) {
      if (this.session?.getSession(view.state)) {
        handled = this.session.navigate(view, -1);
      }
    } else {
      handled = this.handleTabCommand(view);
    }
    if (!handled) return;

    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }

  installInEditor(view) {
    if (!view?.state) return false;
    if (this.compartment.get(view.state) !== undefined) {
      this.installedViews.add(view);
      return false;
    }
    view.dispatch({
      effects: this.StateEffect.appendConfig.of(
        this.compartment.of(this.extension),
      ),
    });
    this.installedViews.add(view);
    this.syncFileSession(view);
    return true;
  }

  syncFileSession(view) {
    const pane = view.__editorPane || (editorManager.panes || []).find(
      (candidate) => candidate?.editor === view,
    );
    const file = pane?.activeFile || (
      editorManager.editor === view ? editorManager.activeFile : null
    );
    if (file?.type === 'editor') file.session = view.state;
  }

  getFileForState(state) {
    const pane = (editorManager.panes || []).find(
      (candidate) => candidate?.editor?.state === state,
    );
    if (pane?.activeFile) return pane.activeFile;
    if (editorManager.editor?.state === state) return editorManager.activeFile;
    return null;
  }

  async loadScope(scope) {
    let text = '';
    let lastError = null;
    for (let attempt = 0; attempt < SCOPE_RETRY_DELAYS.length; attempt += 1) {
      this.throwIfDestroyed();
      const wait = SCOPE_RETRY_DELAYS[attempt];
      if (wait) await this.waitForRetry(wait);
      this.throwIfDestroyed();
      try {
        text = await this.host.readSnippetScope(scope);
        this.throwIfDestroyed();
        lastError = null;
        break;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (isMissingSnippetError(error)) return EMPTY_SCOPE_RESULT;
        lastError = error;
      }
    }
    if (lastError) {
      if (!this.failedScopes.has(scope)) {
        this.failedScopes.add(scope);
        console.error(
          `[Snippets] Unable to load ${scope}.snippets after ` +
          `${SCOPE_RETRY_DELAYS.length} attempts.`,
          lastError,
        );
      }
      throw lastError;
    }
    if (this.failedScopes.delete(scope)) {
      console.info(`[Snippets] Recovered ${scope}.snippets.`);
    }

    const parsed = parseSnippetFile(text, scope);
    if (parsed.unsupported.length && !this.warnedScopes.has(scope)) {
      this.warnedScopes.add(scope);
      console.warn(
        `[Snippets] CodeMirror ignored ${parsed.unsupported.length} invalid ` +
        `snippet${parsed.unsupported.length === 1 ? '' : 's'} in ` +
        `${scope}.snippets.`,
      );
    }
    return parsed;
  }

  throwIfDestroyed() {
    if (!this.destroyed) return;
    const error = new Error('Snippet adapter was destroyed.');
    error.name = 'AbortError';
    throw error;
  }

  waitForRetry(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryWaits.delete(timer);
        resolve();
      }, milliseconds);
      this.retryWaits.set(timer, resolve);
    });
  }

  getSyntaxNodeNames(state, position) {
    const names = [];
    try {
      let node = this.syntaxTree(state).resolveInner(position, -1);
      while (node) {
        names.push(node.name);
        node = node.parent;
      }
    } catch {
      // A language may not have finished parsing yet; the file scope is valid.
    }
    return names;
  }

  getScopes(file, state, position, preload = false) {
    const mode = file?.currentMode || file?.mode;
    const filename = file?.filename || file?.name;
    const modeMappings = this.host.getModeMappings();
    if (preload) {
      return resolvePreloadSnippetScopes(mode, filename, modeMappings);
    }
    return resolveActiveSnippetScopes(
      mode,
      filename,
      this.getSyntaxNodeNames(state, position),
      modeMappings,
    );
  }

  async getSnippetsForPosition(file, state, position, preload = false) {
    const scopes = this.getScopes(file, state, position, preload);
    if (!scopes.length) return [];
    const results = await Promise.all(
      scopes.map(async (scope) => {
        try {
          return await this.cache.getOrLoad(scope);
        } catch {
          return EMPTY_SCOPE_RESULT;
        }
      }),
    );
    return this.collectSnippets(scopes, results);
  }

  getLoadedSnippetsForPosition(file, state, position) {
    const scopes = this.getScopes(file, state, position);
    if (!scopes.length) return [];
    const results = scopes.map((scope) => this.cache.getLoaded(scope));
    if (results.some((result) => !result)) return [];
    return this.collectSnippets(scopes, results);
  }

  collectSnippets(scopes, results) {
    const activeScopes = new Set(scopes);
    const snippets = [];
    for (const result of results) {
      for (const snippet of result.snippets) {
        if (!activeScopes.has(snippet.scope)) continue;
        snippets.push(snippet);
      }
    }
    return snippets;
  }

  async preloadVisibleFiles() {
    await Promise.all(this.getVisibleEditors().map((view) => (
      this.preloadView(view)
    )));
  }

  preloadView(view) {
    const file = this.getFileForState(view?.state);
    return file?.type === 'editor'
      ? this.getSnippetsForPosition(
        file,
        view.state,
        view.state.selection.main.head,
        true,
      )
      : Promise.resolve([]);
  }

  getTabString(state) {
    try {
      const configured = this.indentUnit && state.facet(this.indentUnit);
      if (configured) return configured;
    } catch {
      // Minimal/mock states do not expose facets.
    }
    return '\t';
  }

  compileSnippet(snippet, file, state, position, matches = {}, selection) {
    const variables = createSnippetVariables(
      file,
      state,
      position,
      new Date(),
      selection,
    );
    const line = state.doc.lineAt(position);
    const cursorColumn = position - line.from;
    const leadingWhitespace = line.text.match(/^\s*/)?.[0] || '';
    return compileSnippetTemplate(snippet.content, {
      indentation: leadingWhitespace.slice(0, cursorColumn),
      matches,
      tabString: this.getTabString(state),
      variables,
    });
  }

  getChoiceCompletions(context) {
    const group = this.session?.activeGroup(context.state);
    if (!group?.choices?.length) return null;
    return {
      from: context.state.selection.main.from,
      options: group.choices.map((choice) => ({
        apply: (view) => this.session.replaceActiveChoice(view, choice),
        label: choice,
        type: 'text',
      })),
    };
  }

  async getCompletions(context) {
    const choices = this.getChoiceCompletions(context);
    if (choices) return choices;
    if (!this.host.showInAutocomplete) return null;
    if (this.session?.getSession(context.state)) return null;
    const file = this.getFileForState(context.state);
    if (file?.type !== 'editor') return null;

    const line = context.state.doc.lineAt(context.pos);
    const lineBeforeCursor = line.text.slice(0, context.pos - line.from);
    const prefix = getCompletionPrefix(lineBeforeCursor);
    if (!context.explicit && !prefix) return null;

    const snippets = await this.getSnippetsForPosition(
      file,
      context.state,
      context.pos,
    );
    if (context.aborted) return null;
    const options = [];

    for (const snippet of snippets) {
      if (snippet.unsupportedReason) continue;
      const label = snippet.name || snippet.tabTrigger;
      options.push({
        apply: (view, completion, from, to) => this.applyCompletion(
          view,
          snippet,
          from,
          to,
        ),
        boost: 99,
        label,
        detail: label === snippet.tabTrigger
          ? 'Snippet'
          : snippet.tabTrigger,
        type: 'snippet',
      });
    }

    if (!options.length) return null;
    return {
      from: context.pos - prefix.length,
      options,
    };
  }

  applyCompletion(view, snippet, from, to) {
    this.installInEditor(view);
    const file = this.getFileForState(view.state);
    if (file?.type !== 'editor') return false;
    const main = view.state.selection.main;
    const insertions = view.state.selection.ranges.map((selection) => {
      let rangeFrom = selection === main ? from : selection.from;
      let rangeTo = selection === main ? to : selection.to;
      if (selection !== main && selection.empty) {
        const line = view.state.doc.lineAt(selection.head);
        const before = line.text.slice(0, selection.head - line.from);
        rangeFrom = selection.head - getCompletionPrefix(before).length;
        rangeTo = selection.head;
      }
      return {
        compiled: this.compileSnippet(
          snippet,
          file,
          view.state,
          selection.head,
          {},
          selection,
        ),
        from: rangeFrom,
        to: rangeTo,
      };
    });
    return this.session.insert(view, insertions);
  }

  getUnreadyScopes(view) {
    const file = this.getFileForState(view?.state);
    if (file?.type !== 'editor') return [];
    const scopes = new Set();
    for (const selection of view.state.selection.ranges) {
      for (const scope of this.getScopes(
        file,
        view.state,
        selection.head,
        true,
      )) scopes.add(scope);
    }
    return [...scopes].filter(
      (scope) => this.cache.getStatus(scope) !== 'loaded',
    );
  }

  hasPotentialTabTrigger(view) {
    return view.state.selection.ranges.some((selection) => {
      const line = view.state.doc.lineAt(selection.head);
      return line.text.length > 0;
    });
  }

  captureTabSnapshot(view) {
    return {
      doc: view.state.doc,
      file: this.getFileForState(view.state),
      selections: view.state.selection.ranges.map((range) => ({
        anchor: range.anchor ?? range.from,
        head: range.head ?? range.to,
      })),
    };
  }

  isTabSnapshotCurrent(view, snapshot) {
    if (!view?.state || this.getFileForState(view.state) !== snapshot.file) {
      return false;
    }
    const sameDocument = view.state.doc === snapshot.doc ||
      view.state.doc.eq?.(snapshot.doc);
    if (!sameDocument) return false;
    const ranges = view.state.selection.ranges;
    return ranges.length === snapshot.selections.length && ranges.every(
      (range, index) => (
        (range.anchor ?? range.from) === snapshot.selections[index].anchor &&
        (range.head ?? range.to) === snapshot.selections[index].head
      ),
    );
  }

  async preloadTabScopes(view) {
    const file = this.getFileForState(view?.state);
    if (file?.type !== 'editor') return;
    await Promise.all(view.state.selection.ranges.map((selection) => (
      this.getSnippetsForPosition(
        file,
        view.state,
        selection.head,
        true,
      )
    )));
  }

  runNativeTab(view) {
    if (this.acceptCompletion?.(view)) return true;
    if (typeof view.execCommand === 'function' && view.execCommand('indent')) {
      return true;
    }
    return this.indentMore?.(view) || false;
  }

  queueTab(view) {
    if (this.pendingTabs.has(view)) return true;
    const snapshot = this.captureTabSnapshot(view);
    const pending = {};
    this.pendingTabs.set(view, pending);
    void this.preloadTabScopes(view).then(() => {
      if (this.pendingTabs.get(view) !== pending) return;
      this.pendingTabs.delete(view);
      if (this.destroyed || !this.isTabSnapshotCurrent(view, snapshot)) return;
      if (!this.expandWithTab(view)) this.runNativeTab(view);
    }).catch(() => {
      if (this.pendingTabs.get(view) !== pending) return;
      this.pendingTabs.delete(view);
      if (!this.destroyed && this.isTabSnapshotCurrent(view, snapshot)) {
        this.runNativeTab(view);
      }
    });
    return true;
  }

  handleTabCommand(view) {
    if (this.expandWithTab(view)) return true;
    if (
      !view?.state ||
      view.state.readOnly ||
      !this.hasPotentialTabTrigger(view) ||
      !this.getUnreadyScopes(view).length
    ) return false;
    return this.queueTab(view);
  }

  expandWithTab(view) {
    if (!view?.state || view.state.readOnly) return false;
    this.installInEditor(view);
    if (this.session?.getSession(view.state)) {
      return this.session.navigate(view, 1);
    }
    const file = this.getFileForState(view.state);
    if (file?.type !== 'editor') return false;

    const insertions = [];
    for (const selection of view.state.selection.ranges) {
      const position = selection.head;
      const line = view.state.doc.lineAt(position);
      const cursorColumn = position - line.from;
      const match = findMatchingSnippet(
        this.getLoadedSnippetsForPosition(file, view.state, position),
        line.text.slice(0, cursorColumn),
        line.text.slice(cursorColumn),
      );
      if (!match) continue;
      insertions.push({
        compiled: this.compileSnippet(
          match.snippet,
          file,
          view.state,
          position,
          match.matches,
          selection,
        ),
        from: line.from + match.from,
        to: line.from + match.to,
      });
    }
    if (!insertions.length) return false;
    return this.session.insert(view, insertions);
  }
}

class AcodeSnippets {
  #adapter = null;
  #baseUrl = '';
  #editorLanguages = null;
  #iconStyle = null;
  #ownsSnippetsLanguage = false;
  #snippetsLocation = '';

  async init(baseUrl, _page, options = {}) {
    const hasExistingSettings = Object.prototype.hasOwnProperty.call(
      appSettings.value,
      pluginId,
    );
    this.baseUrl = baseUrl;
    this.#registerIconStyles(baseUrl);
    if (editorManager.isCodeMirror) {
      this.#registerSnippetsLanguage();
    }
    if (!hasExistingSettings) {
      if (editorManager.isCodeMirror && options.firstInit) {
        await this.#initializeDefaultSnippetDirectory();
      } else {
        this.#saveSnippetLocation('');
      }
    }
    this.#adapter = editorManager.isCodeMirror
      ? new CodeMirrorSnippetsAdapter(this)
      : new AceSnippetsAdapter(this);
    await this.#adapter.init();
    this.#updateSettingsDisplays();
  }

  async destroy() {
    try {
      await this.#adapter?.destroy();
    } finally {
      this.#adapter = null;
      this.#unregisterSnippetsLanguage();
      this.#iconStyle?.remove();
      this.#iconStyle = null;
      await this.#clearSettingsAfterUninstall();
    }
  }

  #registerIconStyles(baseUrl) {
    this.#iconStyle?.remove();
    this.#iconStyle = document.createElement('style');
    const iconUrl = this.joinUrl(baseUrl, 'icon.png');
    this.#iconStyle.textContent =
      '.file.file_type_snippets::before {' +
      "content: '';" +
      'display: inline-block;' +
      'width: 1em;' +
      'height: 1em;' +
      `background: url("${iconUrl}") no-repeat center / contain;` +
      'vertical-align: middle;' +
      '}' +
      (editorManager.isCodeMirror
        ? '.cm-tooltip.cm-tooltip-autocomplete ' +
          '.cm-completionIcon.cm-completionIcon-snippet {' +
          'width: 1rem;' +
          'height: 1rem;' +
          'min-width: 1rem;' +
          'padding-right: 0.25rem;' +
          'opacity: 1;' +
          `background: url("${iconUrl}") no-repeat center / contain;` +
          '}'
        : '');
    document.head.appendChild(this.#iconStyle);
  }

  #registerSnippetsLanguage() {
    let editorLanguages;
    let languageModule;
    try {
      editorLanguages = acode.require('editorLanguages');
      languageModule = acode.require('@codemirror/language');
    } catch {
      console.warn('[Snippets] CodeMirror language registration is unavailable.');
      return;
    }
    if (!editorLanguages?.register || !languageModule?.StreamLanguage?.define) {
      console.warn('[Snippets] CodeMirror language registration is unavailable.');
      return;
    }

    this.#editorLanguages = editorLanguages;
    if (!editorLanguages.get?.(SNIPPETS_LANGUAGE)) {
      try {
        editorLanguages.register(
          SNIPPETS_LANGUAGE,
          ['snippets'],
          'Snippets',
          () => createSnippetsLanguage(languageModule),
        );
        this.#ownsSnippetsLanguage = true;
      } catch (error) {
        console.error('[Snippets] Unable to register CodeMirror language.', error);
        return;
      }
    }
    this.#refreshOpenSnippetFiles(false);
  }

  #unregisterSnippetsLanguage() {
    if (!this.#ownsSnippetsLanguage) {
      this.#editorLanguages = null;
      return;
    }

    try {
      this.#editorLanguages?.unregister?.(SNIPPETS_LANGUAGE);
      this.#refreshOpenSnippetFiles(true);
    } catch (error) {
      console.error('[Snippets] Unable to unregister CodeMirror language.', error);
    } finally {
      this.#ownsSnippetsLanguage = false;
      this.#editorLanguages = null;
    }
  }

  #refreshOpenSnippetFiles(unloading) {
    let refreshActiveFile = false;
    for (const file of editorManager.files || []) {
      if (
        file?.type !== 'editor' ||
        !/\.snippets$/i.test(file.filename || '') ||
        typeof file.setMode !== 'function'
      ) {
        continue;
      }

      const mode = String(file.currentMode || '').toLowerCase();
      if (
        unloading
          ? mode === SNIPPETS_LANGUAGE
          : !mode || mode === 'text' || mode === 'plain_text'
      ) {
        file.setMode();
        refreshActiveFile ||= file === editorManager.activeFile;
      }
    }
    if (refreshActiveFile) editorManager.reapplyActiveFile?.();
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  set baseUrl(value) {
    this.#baseUrl = value;
    this.#snippetsLocation = this.#getSnippetLocation() || this.joinUrl(
      value,
      'snippets',
    );
  }

  getIncludedScopes(mode) {
    switch (mode) {
      case 'velocity':
        return ['html', 'javascript', 'css'];
      case 'markdown':
        return ['html'];
      default:
        return null;
    }
  }

  getModeMappings() {
    if (!editorManager.isCodeMirror) return {};
    const byLocation = this.#getPluginSettings().modeMappingsByLocation;
    if (!byLocation || typeof byLocation !== 'object') return {};
    return normalizeModeMappings(byLocation[this.#getModeMappingsLocationKey()]);
  }

  get showInAutocomplete() {
    return this.#getPluginSettings().showInAutocomplete !== false;
  }

  joinUrl(path1, path2) {
    if ('joinUrl' in acode) return acode.joinUrl(path1, path2);
    return `${String(path1).replace(/\/+$/, '')}/${String(path2).replace(/^\/+/, '')}`;
  }

  async readSnippetScope(scope) {
    const fileUrl = this.joinUrl(
      this.#snippetsLocation,
      `${scope}.snippets`,
    );
    return this.readFile(fileUrl);
  }

  async readFile(url) {
    if (url.startsWith('http')) {
      const { response } = await ajax.get(url, { responseType: 'text' });
      return response;
    }
    return acode.fsOperation(url).readFile('utf-8');
  }

  #saveSnippetLocation(url) {
    appSettings.value[pluginId] = {
      ...this.#getPluginSettings(),
      snippetLocation: url,
    };
    appSettings.update();
    this.#updateSettingsDisplays();
  }

  #saveShowInAutocomplete(value) {
    appSettings.value[pluginId] = {
      ...this.#getPluginSettings(),
      showInAutocomplete: value !== false,
    };
    appSettings.update();
  }

  #getSnippetLocation() {
    return this.#getPluginSettings().snippetLocation || '';
  }

  #getPluginSettings() {
    const settings = appSettings.value[pluginId];
    return settings && typeof settings === 'object' ? settings : {};
  }

  #getModeMappingsLocationKey() {
    const location = this.#getSnippetLocation();
    return location
      ? String(location).replace(/\/+$/, '')
      : BUNDLED_MAPPINGS_KEY;
  }

  async #saveModeMappings(mappings) {
    const settings = this.#getPluginSettings();
    const byLocation = {
      ...(settings.modeMappingsByLocation || {}),
    };
    const locationKey = this.#getModeMappingsLocationKey();
    const normalized = normalizeModeMappings(mappings);

    if (Object.keys(normalized).length) {
      byLocation[locationKey] = normalized;
    } else {
      delete byLocation[locationKey];
    }

    const nextSettings = { ...settings };
    if (Object.keys(byLocation).length) {
      nextSettings.modeMappingsByLocation = byLocation;
    } else {
      delete nextSettings.modeMappingsByLocation;
    }
    appSettings.value[pluginId] = nextSettings;
    await appSettings.update();
    this.#updateModeMappingsDisplay();
  }

  #getSnippetLocationLabel() {
    const location = this.#snippetsLocation || this.#getSnippetLocation();
    if (!location) return 'Bundled snippets';
    if (
      this.#baseUrl &&
      location.replace(/\/+$/, '') === this.joinUrl(
        this.#baseUrl,
        'snippets',
      ).replace(/\/+$/, '')
    ) {
      return 'Bundled snippets';
    }

    const normalized = location.replace(/\/+$/, '');
    const terminalHomePath = normalized.match(/\/files\/public(\/.*)?$/);
    if (terminalHomePath) return `/public${terminalHomePath[1] || ''}`;
    return location;
  }

  #getModeMappingsLabel() {
    const count = Object.keys(this.getModeMappings()).length;
    if (!count) return 'None';
    return `${count} mapping${count === 1 ? '' : 's'}`;
  }

  #updateSettingsRow(key, label) {
    const settingsPage = appSettings.uiSettings?.[`plugin-${pluginId}`];
    const list = settingsPage?.getListElement?.();
    const selector = `[data-key="${key}"]`;
    const row = list?.querySelector?.(selector) || list?.get?.(selector);
    const value = row?.querySelector?.('.value') || row?.get?.('.value');
    if (!value) return;

    value.textContent = label;
    value.title = label;
  }

  #updateSnippetPathDisplay() {
    this.#updateSettingsRow(
      'setSnippetsDirectory',
      this.#getSnippetLocationLabel(),
    );
  }

  #updateModeMappingsDisplay() {
    if (!editorManager.isCodeMirror) return;
    this.#updateSettingsRow('languageMappings', this.#getModeMappingsLabel());
  }

  #updateSettingsDisplays() {
    this.#updateSnippetPathDisplay();
    this.#updateModeMappingsDisplay();
  }

  async #clearSettingsAfterUninstall() {
    if (!window.PLUGIN_DIR) return;
    const pluginDirectory = this.joinUrl(window.PLUGIN_DIR, pluginId);
    const pluginFs = acode.fsOperation(pluginDirectory);
    if (!pluginFs?.exists) return;

    try {
      if (await pluginFs.exists()) return;
    } catch {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(appSettings.value, pluginId)) {
      return;
    }
    delete appSettings.value[pluginId];
    await appSettings.update();
  }

  async #initializeDefaultSnippetDirectory() {
    try {
      const filesDirectory = await this.#getFilesDirectory();
      const dataDirectory = filesDirectory.startsWith('file:')
        ? filesDirectory
        : `file://${filesDirectory}`;
      const terminalHome = await this.#ensureDirectory(dataDirectory, 'public');
      const snippetsDirectory = await this.#ensureDirectory(
        terminalHome,
        '.acode-snippets',
      );

      await this.#copySnippets(snippetsDirectory, {
        onlyMissing: true,
        title: 'Initializing snippets...',
      });
      this.#snippetsLocation = snippetsDirectory;
      this.#saveSnippetLocation(snippetsDirectory);
    } catch (error) {
      this.#snippetsLocation = this.joinUrl(this.#baseUrl, 'snippets');
      this.#saveSnippetLocation('');
      console.error('Unable to initialize the default snippets directory.', error);
      acode.alert?.(
        'Snippets',
        'Unable to initialize editable snippets. Bundled snippets will be used.',
      );
    }
  }

  #getFilesDirectory() {
    if (!window.Terminal || !window.system?.getFilesDir) {
      return Promise.reject(new Error('Terminal Home is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      window.system.getFilesDir(resolve, reject);
    });
  }

  async #ensureDirectory(parentUrl, name) {
    const directoryUrl = this.joinUrl(parentUrl, name);
    const directoryFs = acode.fsOperation(directoryUrl);
    const parentFs = acode.fsOperation(parentUrl);
    if (!directoryFs || !parentFs) {
      throw new Error(`Unable to access ${directoryUrl}.`);
    }
    if (await directoryFs.exists()) return directoryUrl;

    try {
      return await parentFs.createDirectory(name);
    } catch (error) {
      if (!(await directoryFs.exists())) throw error;
      return directoryUrl;
    }
  }

  async #setSnippetPath() {
    const selection = await acode.fileBrowser(
      'folder',
      'select snippet location',
    );
    const url = selection?.url;
    if (!url) return;

    const fs = acode.fsOperation(url);
    const list = await fs.lsDir();
    if (!list.length) {
      try {
        await this.#copySnippets(url);
      } catch (error) {
        acode.alert('ERROR', `Unable to copy snippets, ${error.message}`);
        return;
      }
    }

    this.#snippetsLocation = url;
    this.#saveSnippetLocation(url);
    await this.#adapter?.refresh();
  }

  async #resetSnippetPath() {
    this.#snippetsLocation = this.joinUrl(this.#baseUrl, 'snippets');
    this.#saveSnippetLocation('');
    await this.#adapter?.refresh();
  }

  async #openLanguageMappings() {
    while (true) {
      const mappings = this.getModeMappings();
      const entries = Object.entries(mappings).sort(([left], [right]) => (
        left.localeCompare(right)
      ));
      const options = [
        {
          value: ADD_MAPPING_ACTION,
          text: 'Add',
          icon: 'add',
        },
        ...entries.map(([mode, scope]) => ({
          value: `mapping:${mode}`,
          text: `${mode} → ${scope}.snippets`,
          icon: this.#getMappingIcon(scope),
        })),
      ];
      if (entries.length) {
        options.push({
          value: RESET_MAPPINGS_ACTION,
          text: 'Reset',
          icon: 'historyrestore',
        });
      }

      let action;
      try {
        action = await acode.select('Language mappings', options, true);
      } catch {
        return;
      }

      if (action === ADD_MAPPING_ACTION) {
        await this.#editModeMapping();
      } else if (action === RESET_MAPPINGS_ACTION) {
        await this.#resetModeMappings();
      } else if (String(action).startsWith('mapping:')) {
        await this.#openModeMappingActions(String(action).slice(8));
      }
    }
  }

  #getMappingIcon(scope) {
    const iconScope = Object.prototype.hasOwnProperty.call(
      FILE_ICON_SCOPE_ALIASES,
      scope,
    )
      ? FILE_ICON_SCOPE_ALIASES[scope]
      : scope;
    try {
      const icon = acode.require('helpers')?.getIconForFile?.(
        `snippet.${iconScope}`,
      );
      if (typeof icon === 'string' && icon.trim()) return icon;
    } catch {
      // Older builds may not expose the file-icon helper.
    }
    return DEFAULT_FILE_ICON;
  }

  async #openModeMappingActions(mode) {
    let action;
    try {
      action = await acode.select(
        `${mode} → ${this.getModeMappings()[mode]}.snippets`,
        [
          { value: EDIT_MAPPING_ACTION, text: 'Edit mapping', icon: 'edit' },
          {
            value: DELETE_MAPPING_ACTION,
            text: 'Delete mapping',
            icon: 'delete',
          },
        ],
        true,
      );
    } catch {
      return;
    }

    if (action === EDIT_MAPPING_ACTION) {
      await this.#editModeMapping(mode);
    } else if (action === DELETE_MAPPING_ACTION) {
      await this.#deleteModeMapping(mode);
    }
  }

  async #editModeMapping(originalMode = '') {
    const mappings = this.getModeMappings();
    const activeFile = editorManager.activeFile;
    const defaultMode = originalMode || activeFile?.currentMode ||
      activeFile?.mode || '';
    let values;
    try {
      values = await acode.multiPrompt(
        originalMode ? 'Edit language mapping' : 'Add language mapping',
        [
          [
            'Language mode',
            {
              id: 'mode',
              placeholder: 'e.g. zig',
              required: true,
              value: defaultMode,
              autofocus: true,
            },
          ],
          [
            'Snippets file',
            {
              id: 'scope',
              placeholder: 'e.g. rust or rust.snippets',
              required: true,
              value: originalMode ? mappings[originalMode] : '',
            },
          ],
        ],
        'Choose an Acode mode and an existing file from this snippets ' +
          'directory. The .snippets suffix is optional.',
      );
    } catch {
      return false;
    }

    const mapping = normalizeModeMapping(values?.mode, values?.scope);
    if (!mapping) {
      acode.alert(
        'Invalid mapping',
        'Use a language mode and snippet filename without spaces or paths.',
      );
      return false;
    }

    try {
      await this.readSnippetScope(mapping.scope);
    } catch {
      acode.alert(
        'Snippets file not found',
        `${mapping.scope}.snippets does not exist in the active snippets directory.`,
      );
      return false;
    }

    if (
      mapping.mode !== originalMode &&
      Object.prototype.hasOwnProperty.call(mappings, mapping.mode)
    ) {
      const replace = await acode.confirm(
        'Replace mapping?',
        `${mapping.mode} is already mapped to ` +
          `${mappings[mapping.mode]}.snippets.`,
      );
      if (!replace) return false;
    }

    if (originalMode && originalMode !== mapping.mode) {
      delete mappings[originalMode];
    }
    mappings[mapping.mode] = mapping.scope;
    await this.#saveModeMappings(mappings);
    await this.#adapter?.refresh();
    return true;
  }

  async #deleteModeMapping(mode) {
    const mappings = this.getModeMappings();
    if (!Object.prototype.hasOwnProperty.call(mappings, mode)) return false;
    const confirmed = await acode.confirm(
      'Delete mapping?',
      `Restore the default snippet mapping for ${mode}?`,
    );
    if (!confirmed) return false;

    delete mappings[mode];
    await this.#saveModeMappings(mappings);
    await this.#adapter?.refresh();
    return true;
  }

  async #resetModeMappings() {
    if (!Object.keys(this.getModeMappings()).length) return false;
    const confirmed = await acode.confirm(
      'Reset language mappings?',
      'Remove every custom mapping for this snippets directory?',
    );
    if (!confirmed) return false;

    await this.#saveModeMappings({});
    await this.#adapter?.refresh();
    return true;
  }

  async #copySnippets(url, { onlyMissing = false, title = 'Loading...' } = {}) {
    const loader = acode.loader?.('', title);
    loader?.show();
    try {
      for (const file of [...pluginManifest.files]) {
        loader?.setMessage(`Copying ${file}...`);
        const filename = file.split('/').pop();
        const fileUrl = this.joinUrl(url, filename);
        const fileFs = acode.fsOperation(fileUrl);
        if (onlyMissing && await fileFs.exists()) continue;

        const content = await this.readFile(this.joinUrl(this.#baseUrl, file));
        try {
          await acode.fsOperation(url).createFile(filename, content);
        } catch (error) {
          if (!onlyMissing || !(await fileFs.exists())) throw error;
        }
      }
    } finally {
      loader?.destroy();
    }
  }

  onSettingsChange(key, value) {
    if (key === 'setSnippetsDirectory') {
      void this.#setSnippetPath();
    } else if (key === 'showInAutocomplete' && editorManager.isCodeMirror) {
      this.#saveShowInAutocomplete(value);
    } else if (key === 'languageMappings' && editorManager.isCodeMirror) {
      void this.#openLanguageMappings();
    } else if (key === 'resetSnippetsDirectory') {
      void this.#resetSnippetPath();
    }
  }

  get settingsList() {
    const list = [
      {
        key: 'setSnippetsDirectory',
        text: 'Set snippets directory',
        info: this.#getSnippetLocationLabel(),
      },
    ];
    if (editorManager.isCodeMirror) {
      list.push({
        key: 'showInAutocomplete',
        text: 'Autocomplete suggestions',
        info: 'Show snippets in the completion list.',
        checkbox: this.showInAutocomplete,
      });
      list.push({
        key: 'languageMappings',
        text: 'Language mappings',
        info: this.#getModeMappingsLabel(),
      });
    }
    list.push({
      key: 'resetSnippetsDirectory',
      text: 'Reset snippets directory',
    });
    return list;
  }

  get settings() {
    return appSettings.value[pluginId];
  }
}

if (window.acode) {
  const snippetsPlugin = new AcodeSnippets();
  acode.setPluginInit(
    pluginId,
    snippetsPlugin.init.bind(snippetsPlugin),
    {
      list: snippetsPlugin.settingsList,
      cb: snippetsPlugin.onSettingsChange.bind(snippetsPlugin),
    },
  );
  acode.setPluginUnmount(pluginId, () => snippetsPlugin.destroy());
}
