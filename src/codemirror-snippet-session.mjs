import { applySnippetTransform } from './snippet-utils.mjs';

function mapRange(range, changes) {
  return {
    ...range,
    from: changes.mapPos(range.from, -1),
    to: changes.mapPos(range.to, 1),
  };
}

function mapFinalRange(range, changes) {
  if (range.from !== range.to) return mapRange(range, changes);
  const position = changes.mapPos(range.from, 1);
  return { ...range, from: position, to: position };
}

function mapSession(session, changes) {
  return {
    ...session,
    finalRanges: session.finalRanges.map(
      (range) => mapFinalRange(range, changes),
    ),
    groups: session.groups.map((group) => ({
      ...group,
      ranges: group.ranges.map((range) => mapRange(range, changes)),
      transforms: group.transforms.map((range) => mapRange(range, changes)),
    })),
  };
}

function uniqueSelectionRanges(ranges) {
  const seen = new Set();
  return ranges
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .filter((range) => {
      const key = `${range.from}:${range.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildSnippetInsertion(insertions) {
  const ordered = insertions
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const changes = [];
  const groups = new Map();
  const finalRanges = [];
  let delta = 0;

  for (const insertion of ordered) {
    changes.push({
      from: insertion.from,
      to: insertion.to,
      insert: insertion.compiled.text,
    });
    const start = insertion.from + delta;
    delta += insertion.compiled.text.length - (insertion.to - insertion.from);
    const explicitFinal = insertion.compiled.fields.find(
      (field) => field.id === '0' && field.ranges.length,
    )?.ranges[0];
    finalRanges.push(explicitFinal
      ? {
        from: start + explicitFinal.from,
        to: start + explicitFinal.to,
      }
      : {
        from: start + insertion.compiled.text.length,
        to: start + insertion.compiled.text.length,
      });
    for (const compiledField of insertion.compiled.fields) {
      if (compiledField.id === '0') continue;
      const group = groups.get(compiledField.id) || {
        id: compiledField.id,
        choices: compiledField.choices,
        ranges: [],
        transforms: [],
      };
      group.ranges.push(...compiledField.ranges.map((range) => ({
        from: start + range.from,
        to: start + range.to,
      })));
      group.transforms.push(...compiledField.transforms.map((range) => ({
        ...range,
        from: start + range.from,
        to: start + range.to,
      })));
      groups.set(compiledField.id, group);
    }
  }

  const sortedGroups = [...groups.values()]
    .filter((group) => group.ranges.length)
    .sort((left, right) => Number(left.id) - Number(right.id));
  return {
    changes,
    finalRanges: uniqueSelectionRanges(finalRanges),
    groups: sortedGroups,
  };
}

export function createCodeMirrorSnippetSession(modules, callbacks = {}) {
  const {
    Annotation,
    EditorSelection,
    Prec,
    StateEffect,
    StateField,
    Transaction,
  } = modules.state;
  const {
    Decoration,
    EditorView,
    ViewPlugin,
    keymap,
  } = modules.view;

  const setSession = StateEffect.define();
  const setActiveIndex = StateEffect.define();
  const clearSession = StateEffect.define();
  const synchronizing = Annotation.define();
  const fieldMark = Decoration.mark({ class: 'acode-snippet-field' });

  const createDecorations = (session) => {
    if (!session) return Decoration.none;
    const ranges = [];
    for (const group of session.groups) {
      for (const range of [...group.ranges, ...group.transforms]) {
        if (range.to > range.from) ranges.push(fieldMark.range(range.from, range.to));
      }
    }
    return Decoration.set(
      ranges.sort((left, right) => left.from - right.from || left.to - right.to),
      true,
    );
  };

  const withDecorations = (session) => session
    ? { ...session, decorations: createDecorations(session) }
    : null;

  const sessionField = StateField.define({
    create() {
      return null;
    },
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(clearSession)) return null;
        if (effect.is(setSession)) return withDecorations(effect.value);
      }
      if (!value) return null;

      if (transaction.docChanged && !transaction.annotation(synchronizing)) {
        const active = value.groups[value.activeIndex];
        let editsOnlyActiveRanges = !!active?.ranges.length;
        transaction.changes.iterChangedRanges((from, to) => {
          if (!active.ranges.some(
            (range) => from >= range.from && to <= range.to,
          )) editsOnlyActiveRanges = false;
        });
        if (!editsOnlyActiveRanges) return null;
      }

      let next = transaction.docChanged
        ? mapSession(value, transaction.changes)
        : value;
      for (const effect of transaction.effects) {
        if (effect.is(setActiveIndex)) {
          next = { ...next, activeIndex: effect.value };
        }
      }

      if (transaction.selection && !transaction.effects.some(
        (effect) => effect.is(setActiveIndex),
      )) {
        const positions = transaction.newSelection.ranges;
        const staysInSession = positions.some((selection) => next.groups.some(
          (group) => group.ranges.some(
            (range) => selection.head >= range.from && selection.head <= range.to,
          ),
        ));
        if (!staysInSession) return null;
      }
      return withDecorations(next);
    },
    provide: (field) => EditorView.decorations.from(
      field,
      (value) => value?.decorations || Decoration.none,
    ),
  });

  const syncTransforms = (view) => {
    const session = view.state.field(sessionField, false);
    if (!session) return;
    const changes = [];
    for (const group of session.groups) {
      if (!group.transforms.length || !group.ranges.length) continue;
      const source = view.state.doc.sliceString(
        group.ranges[0].from,
        group.ranges[0].to,
      );
      for (const transform of group.transforms) {
        const replacement = applySnippetTransform(source, transform);
        const current = view.state.doc.sliceString(transform.from, transform.to);
        if (replacement !== current) {
          changes.push({
            from: transform.from,
            to: transform.to,
            insert: replacement,
          });
        }
      }
    }
    if (!changes.length) return;
    view.dispatch({
      changes,
      annotations: [
        synchronizing.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  };

  const transformPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.pending = false;
      this.destroyed = false;
    }

    update(update) {
      if (!update.docChanged || update.transactions.some(
        (transaction) => transaction.annotation(synchronizing),
      )) return;
      if (this.pending) return;
      this.pending = true;
      Promise.resolve().then(() => {
        this.pending = false;
        if (!this.destroyed) syncTransforms(this.view);
      });
    }

    destroy() {
      this.destroyed = true;
    }
  });

  const getSession = (state) => typeof state?.field === 'function'
    ? state.field(sessionField, false)
    : null;

  const activeGroup = (state) => {
    const session = getSession(state);
    return session?.groups[session.activeIndex] || null;
  };

  const showChoices = (view) => {
    if (!activeGroup(view.state)?.choices?.length) return;
    Promise.resolve().then(() => callbacks.startCompletion?.(view));
  };

  const selectIndex = (view, nextIndex) => {
    const session = getSession(view.state);
    if (!session || nextIndex < 0 || nextIndex >= session.groups.length) {
      return false;
    }
    const group = session.groups[nextIndex];
    const ranges = uniqueSelectionRanges(group.ranges);
    if (!ranges.length) return false;
    view.dispatch({
      selection: EditorSelection.create(
        ranges.map(({ from, to }) => EditorSelection.range(from, to)),
      ),
      effects: setActiveIndex.of(nextIndex),
      scrollIntoView: true,
    });
    showChoices(view);
    return true;
  };

  const navigate = (view, direction = 1) => {
    const session = getSession(view.state);
    if (!session) return false;
    const nextIndex = session.activeIndex + direction;
    if (nextIndex < 0) return true;
    if (nextIndex >= session.groups.length) {
      const ranges = uniqueSelectionRanges(session.finalRanges);
      view.dispatch({
        selection: EditorSelection.create(
          ranges.map(({ from, to }) => EditorSelection.range(from, to)),
        ),
        effects: clearSession.of(null),
        scrollIntoView: true,
      });
      return true;
    }
    return selectIndex(view, nextIndex);
  };

  const clear = (view) => {
    if (!getSession(view.state)) return false;
    view.dispatch({ effects: clearSession.of(null) });
    return true;
  };

  const keyBindings = keymap.of([
    { key: 'Tab', run: (view) => callbacks.tab?.(view) || false },
    { key: 'Shift-Tab', run: (view) => navigate(view, -1) },
    { key: 'Escape', run: clear },
  ]);

  const extension = [
    sessionField,
    transformPlugin,
    Prec.highest(keyBindings),
    EditorView.baseTheme({
      '.acode-snippet-field': {
        backgroundColor: 'rgba(194, 193, 208, 0.09)',
        outline: '1px dotted rgba(211, 208, 235, 0.62)',
      },
    }),
  ];

  const insert = (view, insertions) => {
    if (!insertions.length) return false;
    const {
      changes,
      finalRanges,
      groups: sortedGroups,
    } = buildSnippetInsertion(insertions);
    if (!sortedGroups.length) {
      view.dispatch({
        changes,
        selection: EditorSelection.create(
          finalRanges.map(({ from, to }) => EditorSelection.range(from, to)),
        ),
      });
      return true;
    }

    const firstRanges = uniqueSelectionRanges(sortedGroups[0].ranges);
    view.dispatch({
      changes,
      selection: EditorSelection.create(
        firstRanges.map(({ from, to }) => EditorSelection.range(from, to)),
      ),
      effects: setSession.of({
        activeIndex: 0,
        finalRanges,
        groups: sortedGroups,
      }),
      scrollIntoView: true,
    });
    showChoices(view);
    return true;
  };

  const replaceActiveChoice = (view, value) => {
    const group = activeGroup(view.state);
    if (!group?.choices?.includes(value)) return false;
    view.dispatch({
      changes: group.ranges.map(({ from, to }) => ({ from, to, insert: value })),
    });
    const session = getSession(view.state);
    return selectIndex(view, session?.activeIndex ?? 0);
  };

  return {
    activeGroup,
    clear,
    extension,
    getSession,
    insert,
    navigate,
    replaceActiveChoice,
    syncTransforms,
  };
}
