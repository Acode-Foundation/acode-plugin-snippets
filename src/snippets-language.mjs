const DIRECTIVE_PATTERN =
  /^(description|endGuard|endTrigger|guard|key|name|regex|scope|snippet|tabTrigger|trigger)\b/;
const REGEX_DIRECTIVES = new Set([
  'endGuard',
  'endTrigger',
  'guard',
  'regex',
]);

function topPlaceholder(state) {
  return state.placeholders[state.placeholders.length - 1] || null;
}

function consumeUntil(stream, stopCharacters) {
  while (!stream.eol() && !stopCharacters.test(stream.peek())) stream.next();
}

function startLine(stream, state) {
  if (!stream.sol()) return false;

  state.headerValueStyle = null;
  if (stream.peek() === '\t') {
    state.lineType = 'body';
    stream.eatWhile('\t');
    return true;
  }

  state.lineType = 'header';
  state.placeholders = [];
  return false;
}

function tokenHeader(stream, state) {
  if (stream.sol() && stream.peek() === ' ') {
    stream.eatWhile(' ');
    return 'invalid';
  }
  if (stream.match(/^#.*/)) return 'comment';

  if (state.headerValueStyle) {
    if (stream.eatSpace()) return null;
    const style = state.headerValueStyle;
    state.headerValueStyle = null;
    stream.skipToEnd();
    return style;
  }

  const directive = stream.match(DIRECTIVE_PATTERN);
  if (directive) {
    state.headerValueStyle = REGEX_DIRECTIVES.has(directive[1])
      ? 'regexp'
      : 'string';
    return 'keyword';
  }

  stream.skipToEnd();
  return null;
}

function tokenChoice(stream, frame) {
  if (stream.match(/^\|(?=})/)) {
    frame.mode = 'default';
    return 'punctuation';
  }
  if (stream.match(/^\\./)) return 'escape';

  consumeUntil(stream, /[\\|]/);
  if (stream.current()) return 'string';
  stream.next();
  return 'string';
}

function tokenTransform(stream, state, frame) {
  if (frame.mode === 'regexp') {
    if (stream.match(/^\\./)) return 'escape';
    if (stream.eat('[')) {
      frame.mode = 'charClass';
      return 'regexp';
    }
    if (stream.eat('/')) {
      frame.mode = 'format';
      return 'punctuation';
    }
    consumeUntil(stream, /[\\[/]/);
    if (stream.current()) return 'regexp';
  } else if (frame.mode === 'charClass') {
    if (stream.match(/^\\./)) return 'escape';
    if (stream.eat(']')) {
      frame.mode = 'regexp';
      return 'regexp';
    }
    consumeUntil(stream, /[\\\]]/);
    if (stream.current()) return 'regexp';
  } else if (frame.mode === 'format') {
    if (stream.match(/^\\[ulULE]/)) return 'keyword';
    if (stream.match(/^\$\{/)) {
      state.placeholders.push({ mode: 'formatVariable' });
      return 'bracket';
    }
    if (stream.match(/^\$\d+/)) return 'variableName';
    if (stream.eat('/')) {
      frame.mode = 'flags';
      return 'punctuation';
    }
    consumeUntil(stream, /[\\$/]/);
    if (stream.current()) return 'string';
  } else if (frame.mode === 'flags') {
    if (stream.match(/^(?:[a-zA-Z]+:?|:)/)) {
      frame.mode = 'default';
      return 'regexp';
    }
    frame.mode = 'default';
    return tokenBody(stream, state);
  }

  stream.next();
  return frame.mode === 'format' ? 'string' : 'regexp';
}

function tokenBody(stream, state) {
  const frame = topPlaceholder(state);
  if (frame?.mode === 'choice') return tokenChoice(stream, frame);
  if (frame && ['regexp', 'charClass', 'format', 'flags'].includes(frame.mode)) {
    return tokenTransform(stream, state, frame);
  }

  if (stream.match(/^\\./)) return 'escape';
  if (stream.match(/^\$\{/)) {
    state.placeholders.push({ mode: 'declaration' });
    return 'bracket';
  }
  if (stream.match(/^\$(?:[A-Za-z_][\w]*|\d+)/)) return 'variableName';
  if (stream.match(/^\{VISUAL\}/)) return 'variableName';

  const activeFrame = topPlaceholder(state);
  if (activeFrame) {
    if (stream.eat('}')) {
      state.placeholders.pop();
      return 'bracket';
    }
    if (activeFrame.mode === 'declaration') {
      if (stream.match(/^\d+/)) return 'number';
      if (stream.match(/^[A-Za-z_][\w]*/)) return 'variableName';
      if (stream.eat(':')) {
        activeFrame.mode = 'default';
        return 'punctuation';
      }
      if (stream.eat('|')) {
        activeFrame.mode = 'choice';
        return 'punctuation';
      }
      if (stream.eat('/')) {
        activeFrame.mode = 'regexp';
        return 'punctuation';
      }
    } else if (activeFrame.mode === 'formatVariable') {
      if (stream.match(/^(?:\d+|[A-Za-z_][\w]*)/)) return 'variableName';
      if (stream.eat(':')) {
        activeFrame.mode = 'formatVariableValue';
        return 'punctuation';
      }
    } else if (activeFrame.mode === 'formatVariableValue') {
      if (stream.match(/^\/(?:[A-Za-z_]\w*)/)) return 'keyword';
      if (stream.match(/^[?+\-]/)) return 'punctuation';
    }
  }

  consumeUntil(stream, activeFrame ? /[\\${}:|/]/ : /[\\$]/);
  if (stream.current()) return null;
  stream.next();
  return null;
}

export const snippetsStreamParser = {
  name: 'snippets',
  startState() {
    return {
      headerValueStyle: null,
      lineType: 'header',
      placeholders: [],
    };
  },
  copyState(state) {
    return {
      ...state,
      placeholders: state.placeholders.map((frame) => ({ ...frame })),
    };
  },
  token(stream, state) {
    if (startLine(stream, state)) return null;
    return state.lineType === 'body'
      ? tokenBody(stream, state)
      : tokenHeader(stream, state);
  },
  languageData: {
    commentTokens: { line: '#' },
  },
};

export function createSnippetsLanguage(languageModule) {
  const { indentUnit, LanguageSupport, StreamLanguage } = languageModule || {};
  if (!LanguageSupport || !StreamLanguage?.define) {
    throw new Error('CodeMirror stream language API is unavailable.');
  }

  const language = StreamLanguage.define(snippetsStreamParser);
  const support = indentUnit?.of ? [indentUnit.of('\t')] : [];
  return new LanguageSupport(language, support);
}
