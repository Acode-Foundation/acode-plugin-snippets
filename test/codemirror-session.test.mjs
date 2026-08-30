import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSnippetInsertion,
  createCodeMirrorSnippetSession,
} from '../src/codemirror-snippet-session.mjs';
import { compileSnippetTemplate } from '../src/snippet-utils.mjs';

function createSessionHarness(initialText = '') {
  let sessionField;
  const pluginClasses = [];
  const dispatches = [];
  const defineEffect = () => {
    const type = {
      of(value) {
        return { is: (candidate) => candidate === type, value };
      },
    };
    return type;
  };
  const defineAnnotation = () => {
    const type = {
      of(value) {
        return { type, value };
      },
    };
    return type;
  };
  const makeRange = (from, to = from) => ({
    empty: from === to,
    from,
    head: to,
    to,
  });
  const EditorSelection = {
    create(ranges) {
      return { main: ranges[0], ranges };
    },
    range: makeRange,
  };
  const modules = {
    state: {
      Annotation: { define: defineAnnotation },
      EditorSelection,
      Prec: { highest: (extension) => extension },
      StateEffect: { define: defineEffect },
      StateField: {
        define(specification) {
          sessionField = { specification };
          return sessionField;
        },
      },
      Transaction: { addToHistory: defineAnnotation() },
    },
    view: {
      Decoration: {
        mark: () => ({ range: (from, to) => ({ from, to }) }),
        none: [],
        set: (ranges) => ranges,
      },
      EditorView: {
        baseTheme: (theme) => theme,
        decorations: { from: (...args) => args },
      },
      ViewPlugin: {
        fromClass(plugin) {
          pluginClasses.push(plugin);
          return plugin;
        },
      },
      keymap: { of: (bindings) => bindings },
    },
  };
  const session = createCodeMirrorSnippetSession(modules);
  let fieldValue = sessionField.specification.create();
  let text = initialText;
  const createDoc = (docText = text) => ({
    length: docText.length,
    sliceString: (from, to) => docText.slice(from, to),
  });
  const createState = (selection, fieldSnapshot = fieldValue) => ({
    doc: createDoc(),
    field(field, fallback) {
      if (field === sessionField) return fieldSnapshot;
      if (fallback === false) return undefined;
      throw new Error('Unknown state field.');
    },
    selection,
  });
  const initialRange = makeRange(initialText.length);
  const view = {
    state: createState(EditorSelection.create([initialRange])),
    dispatch(specification) {
      dispatches.push(specification);
      const startState = view.state;
      const effects = specification.effects
        ? [].concat(specification.effects)
        : [];
      const annotations = specification.annotations
        ? [].concat(specification.annotations)
        : [];
      const changes = specification.changes
        ? [].concat(specification.changes)
        : [];
      const orderedChanges = changes.slice().sort((left, right) => (
        left.from - right.from || left.to - right.to
      ));
      const mapPos = (position, association = 1) => {
        let delta = 0;
        for (const change of orderedChanges) {
          const insertedLength = String(change.insert || '').length;
          if (position < change.from) break;
          if (position > change.to) {
            delta += insertedLength - (change.to - change.from);
            continue;
          }
          if (change.from === change.to) {
            return change.from + delta + (association > 0 ? insertedLength : 0);
          }
          if (position === change.from && association < 0) {
            return change.from + delta;
          }
          return change.from + delta + insertedLength;
        }
        return position + delta;
      };
      const mappedSelection = EditorSelection.create(
        startState.selection.ranges.map((range) => EditorSelection.range(
          mapPos(range.from, -1),
          mapPos(range.to, 1),
        )),
      );
      const nextSelection = specification.selection?.ranges
        ? specification.selection
        : specification.selection?.anchor != null
          ? EditorSelection.create([
            makeRange(
              specification.selection.anchor,
              specification.selection.head ?? specification.selection.anchor,
            ),
          ])
          : mappedSelection;
      const transaction = {
        annotation(type) {
          return annotations.find((annotation) => annotation.type === type)?.value;
        },
        changes: {
          iterChangedRanges(callback) {
            for (const change of orderedChanges) {
              callback(change.from, change.to);
            }
          },
          mapPos,
        },
        docChanged: changes.length > 0,
        effects,
        newSelection: nextSelection,
        selection: specification.selection != null,
        startState,
      };

      fieldValue = sessionField.specification.update(fieldValue, transaction);
      for (const change of changes.slice().sort((left, right) => right.from - left.from)) {
        text = text.slice(0, change.from) + String(change.insert || '') +
          text.slice(change.to);
      }
      view.state = createState(nextSelection, fieldValue);
      transaction.state = view.state;
      const update = {
        docChanged: transaction.docChanged,
        startState,
        state: view.state,
        transactions: [transaction],
        view,
      };
      for (const plugin of plugins) plugin.update(update);
    },
  };
  const plugins = pluginClasses.map((Plugin) => new Plugin(view));
  const flushSynchronization = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    dispatches,
    EditorSelection,
    flushSynchronization,
    session,
    view,
  };
}

test('merges mirrored fields and final cursors across multiple selections', () => {
  const compiled = compileSnippetTemplate('const ${1:name} = $1; $0');
  const insertion = buildSnippetInsertion([
    { from: 0, to: 1, compiled },
    { from: 2, to: 3, compiled },
  ]);

  assert.equal(insertion.changes.length, 2);
  assert.deepEqual(insertion.groups.map(({ id }) => id), ['1']);
  assert.equal(insertion.groups[0].ranges.length, 4);
  assert.ok(insertion.groups[0].ranges[2].from > insertion.groups[0].ranges[1].to);
  assert.equal(insertion.finalRanges.length, 2);
  assert.ok(insertion.finalRanges[1].from > insertion.finalRanges[0].to);
  assert.equal(insertion.finalRanges[0].from, insertion.finalRanges[0].to);
});

test('keeps transformed mirrors attached to their editable source field', () => {
  const compiled = compileSnippetTemplate(
    'import ${1/.*\\///} from "${1}"; $0',
  );
  const insertion = buildSnippetInsertion([{ from: 4, to: 8, compiled }]);
  const source = insertion.groups[0];

  assert.equal(source.id, '1');
  assert.equal(source.ranges.length, 1);
  assert.equal(source.transforms.length, 1);
  assert.equal(source.transforms[0].regex, '.*\\/');
  assert.deepEqual(insertion.groups.map(({ id }) => id), ['1']);
  assert.equal(insertion.finalRanges.length, 1);
});

test('uses an implicit insertion-end cursor when a snippet omits $0', () => {
  const compiled = compileSnippetTemplate('${1:name} tail');
  const insertion = buildSnippetInsertion([{ from: 0, to: 0, compiled }]);

  assert.deepEqual(insertion.groups.map(({ id }) => id), ['1']);
  assert.deepEqual(insertion.finalRanges, [{ from: 9, to: 9 }]);
});

test('retains one final cursor per placeholder-free insertion', () => {
  const compiled = compileSnippetTemplate('done');
  const insertion = buildSnippetInsertion([
    { from: 0, to: 1, compiled },
    { from: 2, to: 3, compiled },
  ]);

  assert.deepEqual(insertion.groups, []);
  assert.deepEqual(insertion.finalRanges, [
    { from: 4, to: 4 },
    { from: 9, to: 9 },
  ]);
});

test('moves to the mapped implicit final cursor and clears the session', () => {
  const { EditorSelection, session, view } = createSessionHarness();
  const compiled = compileSnippetTemplate('${1:name} tail');

  assert.equal(session.insert(view, [{ from: 0, to: 0, compiled }]), true);
  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'name tail');
  assert.deepEqual(view.state.selection.ranges.map(({ from, to }) => [from, to]), [
    [0, 4],
  ]);
  assert.ok(session.getSession(view.state));

  view.dispatch({
    changes: { from: 0, to: 4, insert: 'longer' },
    selection: EditorSelection.create([EditorSelection.range(6, 6)]),
  });
  assert.equal(session.navigate(view, 1), true);
  assert.deepEqual(view.state.selection.ranges.map(({ head }) => head), [11]);
  assert.equal(session.getSession(view.state), null);
  assert.equal(session.navigate(view, 1), false);
});

test('uses explicit $0 and keeps final cursors for every selection', () => {
  const { session, view } = createSessionHarness('x x');
  const withField = compileSnippetTemplate('${1:name}$0 tail');

  session.insert(view, [
    { from: 0, to: 1, compiled: withField },
    { from: 2, to: 3, compiled: withField },
  ]);
  assert.equal(session.navigate(view, 1), true);
  assert.deepEqual(view.state.selection.ranges.map(({ head }) => head), [4, 14]);
  assert.equal(session.getSession(view.state), null);

  const placeholderFree = createSessionHarness('x x');
  const plain = compileSnippetTemplate('done');
  placeholderFree.session.insert(placeholderFree.view, [
    { from: 0, to: 1, compiled: plain },
    { from: 2, to: 3, compiled: plain },
  ]);
  assert.deepEqual(
    placeholderFree.view.state.selection.ranges.map(({ head }) => head),
    [4, 9],
  );
  assert.equal(placeholderFree.session.getSession(placeholderFree.view.state), null);
});

test('keeps ordinary mirrors synchronized when either occurrence is edited', async () => {
  const harness = createSessionHarness();
  const { EditorSelection, session, view } = harness;
  const compiled = compileSnippetTemplate('${1:name} = $1; $0');

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  let group = session.getSession(view.state).groups[0];
  view.dispatch({
    changes: { ...group.ranges[0], insert: 'value' },
    selection: EditorSelection.create([EditorSelection.range(5, 5)]),
  });
  await harness.flushSynchronization();
  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'value = value; ');
  assert.ok(session.getSession(view.state));

  group = session.getSession(view.state).groups[0];
  const mirror = group.ranges[1];
  view.dispatch({
    changes: { from: mirror.from, to: mirror.to, insert: 'result' },
    selection: EditorSelection.create([
      EditorSelection.range(mirror.from + 6, mirror.from + 6),
    ]),
  });
  await harness.flushSynchronization();
  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'result = result; ');
  assert.ok(session.getSession(view.state));
  assert.ok(harness.dispatches.at(-1).annotations.some(
    (annotation) => annotation.value === false,
  ));
});

test('does not duplicate immediate multi-selection mirror edits', async () => {
  const harness = createSessionHarness();
  const { session, view } = harness;
  const compiled = compileSnippetTemplate('${1:name} = $1');

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  const ranges = session.getSession(view.state).groups[0].ranges;
  view.dispatch({
    changes: ranges.map(({ from, to }) => ({ from, to, insert: 'item' })),
  });
  const dispatchCount = harness.dispatches.length;
  await harness.flushSynchronization();

  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'item = item');
  assert.equal(harness.dispatches.length, dispatchCount);
});

test('keeps mirrored values independent across separate snippet insertions', async () => {
  const harness = createSessionHarness('x x');
  const { EditorSelection, session, view } = harness;
  const compiled = compileSnippetTemplate('${1:left} = $1');

  session.insert(view, [
    { from: 0, to: 1, compiled },
    { from: 2, to: 3, compiled },
  ]);
  let group = session.getSession(view.state).groups[0];
  assert.deepEqual(
    [...new Set(group.ranges.map(({ insertionId }) => insertionId))],
    [0, 1],
  );
  const firstMirror = group.ranges.find(
    ({ insertionId, occurrenceId }) => insertionId === 0 && occurrenceId === 1,
  );
  view.dispatch({
    changes: { from: firstMirror.from, to: firstMirror.to, insert: 'one' },
    selection: EditorSelection.create([
      EditorSelection.range(firstMirror.from + 3, firstMirror.from + 3),
    ]),
  });
  await harness.flushSynchronization();

  group = session.getSession(view.state).groups[0];
  const values = (insertionId) => group.ranges
    .filter((range) => range.insertionId === insertionId)
    .map((range) => view.state.doc.sliceString(range.from, range.to));
  assert.deepEqual(values(0), ['one', 'one']);
  assert.deepEqual(values(1), ['left', 'left']);
});

test('updates ordinary and transformed mirrors from the edited occurrence', async () => {
  const harness = createSessionHarness();
  const { EditorSelection, session, view } = harness;
  const compiled = compileSnippetTemplate(
    '${1:name} = $1 ${1/(.*)/${1:/upcase}/}',
  );

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  const mirror = session.getSession(view.state).groups[0].ranges[1];
  view.dispatch({
    changes: { from: mirror.from, to: mirror.to, insert: 'item' },
    selection: EditorSelection.create([
      EditorSelection.range(mirror.from + 4, mirror.from + 4),
    ]),
  });
  await harness.flushSynchronization();

  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'item = item ITEM');
});

test('keeps choice replacement synchronized through final-cursor navigation', async () => {
  const harness = createSessionHarness();
  const { session, view } = harness;
  const compiled = compileSnippetTemplate('${1|one,two|} = $1$0');

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  assert.deepEqual(session.activeGroup(view.state).choices, ['one', 'two']);
  assert.equal(session.replaceActiveChoice(view, 'two'), true);
  await harness.flushSynchronization();

  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'two = two');
  assert.equal(session.navigate(view, 1), true);
  assert.deepEqual(view.state.selection.ranges.map(({ head }) => head), [9]);
  assert.equal(session.getSession(view.state), null);
});

test('synchronizes nested fields inside-out without ending navigation', async () => {
  const harness = createSessionHarness();
  const { EditorSelection, session, view } = harness;
  const compiled = compileSnippetTemplate(
    '${1:outer ${2:inner}} | $1 | $2$0',
  );

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  assert.equal(session.navigate(view, 1), true);
  const inner = session.getSession(view.state).groups[1].ranges[0];
  view.dispatch({
    changes: { from: inner.from, to: inner.to, insert: 'child' },
    selection: EditorSelection.create([
      EditorSelection.range(inner.from + 5, inner.from + 5),
    ]),
  });
  await harness.flushSynchronization();

  assert.equal(
    view.state.doc.sliceString(0, view.state.doc.length),
    'outer child | outer child | child',
  );
  assert.ok(session.getSession(view.state));
  assert.equal(session.navigate(view, 1), true);
  assert.equal(session.getSession(view.state), null);
  assert.equal(session.navigate(view, 1), false);
});

test('cancels the session for edits outside the active placeholder', async () => {
  const harness = createSessionHarness();
  const { session, view } = harness;
  const compiled = compileSnippetTemplate('${1:name} tail');

  session.insert(view, [{ from: 0, to: 0, compiled }]);
  view.dispatch({ changes: { from: 5, to: 5, insert: '!' } });
  await harness.flushSynchronization();

  assert.equal(session.getSession(view.state), null);
  assert.equal(view.state.doc.sliceString(0, view.state.doc.length), 'name !tail');
});
