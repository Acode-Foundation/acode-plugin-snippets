const MODE_ALIASES = Object.freeze({
  c: 'c_cpp',
  'c++': 'c_cpp',
  cpp: 'c_cpp',
  coffeescript: 'coffee',
  go: 'golang',
  graphql: 'graphqlschema',
  latex: 'tex',
  'mariadb-sql': 'sql',
  'ms-sql': 'sqlserver',
  mysql: 'sql',
  plsql: 'sql',
  postgresql: 'sql',
  restructuredtext: 'rst',
  shell: 'sh',
  sqlite: 'sql',
});

const INCLUDED_SCOPES = Object.freeze({
  markdown: ['html'],
  php: ['html'],
  velocity: ['html', 'javascript', 'css'],
});

const EMBEDDED_SCOPES = Object.freeze({
  html: ['javascript', 'css'],
  markdown: ['javascript', 'css'],
  php: ['javascript', 'css'],
});

const MODE_NAME_PATTERN = /^[a-z0-9][a-z0-9_+.-]*$/;

function normalizeMode(mode) {
  return String(mode || '')
    .trim()
    .toLowerCase()
    .replace(/^ace\/mode\//, '');
}

function normalizeSnippetScope(scope) {
  return normalizeMode(
    String(scope || '').trim().replace(/\.snippets$/i, ''),
  );
}

export function normalizeModeMapping(mode, scope) {
  const normalizedMode = normalizeMode(mode);
  const normalizedScope = normalizeSnippetScope(scope);
  if (
    !MODE_NAME_PATTERN.test(normalizedMode) ||
    !MODE_NAME_PATTERN.test(normalizedScope)
  ) return null;
  return { mode: normalizedMode, scope: normalizedScope };
}

export function normalizeModeMappings(mappings) {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    return {};
  }

  const normalized = {};
  for (const [mode, scope] of Object.entries(mappings)) {
    const mapping = normalizeModeMapping(mode, scope);
    if (mapping) normalized[mapping.mode] = mapping.scope;
  }
  return normalized;
}

export function resolveSnippetScopes(mode, filename = '', modeMappings = {}) {
  const normalized = normalizeMode(mode);
  if (!normalized) return [];

  const basename = String(filename || '').split(/[\\/]/).pop() || '';
  const customScope = normalizeModeMapping(
    normalized,
    modeMappings?.[normalized],
  )?.scope || '';
  let primary = customScope || MODE_ALIASES[normalized] || normalized;
  if (
    !customScope &&
    normalized === 'text' &&
    /^(?:gnu)?makefile$/i.test(basename)
  ) {
    primary = 'makefile';
  } else if (
    !customScope &&
    normalized === 'text' &&
    /\.snippets$/i.test(basename)
  ) {
    primary = 'snippets';
  }
  return [...new Set([primary, ...(INCLUDED_SCOPES[primary] || [])])];
}

export function resolvePreloadSnippetScopes(
  mode,
  filename = '',
  modeMappings = {},
) {
  const scopes = resolveSnippetScopes(mode, filename, modeMappings);
  if (!scopes.length) return [];
  return [
    ...new Set([
      ...scopes,
      ...(EMBEDDED_SCOPES[scopes[0]] || []),
    ]),
  ];
}

export function resolveActiveSnippetScopes(
  mode,
  filename,
  syntaxNodeNames = [],
  modeMappings = {},
) {
  const fileScopes = resolveSnippetScopes(mode, filename, modeMappings);
  if (!fileScopes.length) return [];

  const names = new Set(syntaxNodeNames.map((name) => String(name).toLowerCase()));
  let primary = fileScopes[0];
  if (names.has('stylesheet')) primary = 'css';
  else if (names.has('script')) primary = 'javascript';
  else if (
    primary === 'php' &&
    (names.has('document') || names.has('element') || names.has('text'))
  ) primary = 'html';

  return [...new Set([primary, ...(INCLUDED_SCOPES[primary] || [])])];
}

function parseRegexDirective(value) {
  const parts = [];
  const matcher = /\/((?:[^/\\]|\\.)*)|$/g;
  for (let index = 0; index < 4; index += 1) {
    parts.push(matcher.exec(value)?.[1] || '');
  }
  return {
    guard: parts[0],
    trigger: parts[1],
    endTrigger: parts[2],
    endGuard: parts[3],
  };
}

function finalizeSnippet(snippet, defaultScope, snippets, unsupported) {
  if (!snippet.content) return;
  snippet.scope = snippet.scope || defaultScope;
  if (!snippet.tabTrigger) {
    snippet.unsupportedReason = 'missing tab trigger';
    unsupported.push({
      name: snippet.name || 'unnamed snippet',
      reason: snippet.unsupportedReason,
    });
  }
  snippets.push(snippet);
}

/** Parse Ace's directive-and-indented-body .snippets format. */
export function parseSnippetFile(text, defaultScope = '_') {
  const source = String(text || '').replace(/\r/g, '');
  const lines = source.split('\n');
  const snippets = [];
  const unsupported = [];
  let snippet = {};

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.startsWith('\t')) {
      const body = [];
      while (index < lines.length) {
        const bodyLine = lines[index];
        if (bodyLine.startsWith('\t')) {
          body.push(bodyLine.slice(1));
          index += 1;
          continue;
        }
        if (bodyLine === '') {
          let nextContent = index;
          while (lines[nextContent] === '') nextContent += 1;
          if (lines[nextContent]?.startsWith('\t')) {
            while (index < nextContent) {
              body.push('');
              index += 1;
            }
            continue;
          }
        }
        break;
      }
      snippet.content = body.join('\n');
      finalizeSnippet(snippet, defaultScope, snippets, unsupported);
      snippet = {};
      continue;
    }

    if (!line || line.startsWith('#')) {
      index += 1;
      continue;
    }

    if (line.startsWith('{')) {
      let json = line;
      let end = index;
      while (end + 1 < lines.length && !/^}\s*$/.test(lines[end])) {
        end += 1;
        if (end > index) json += `\n${lines[end]}`;
      }
      try {
        const parsed = JSON.parse(json);
        parsed.content = Array.isArray(parsed.body)
          ? parsed.body.join('\n')
          : parsed.content || parsed.body;
        finalizeSnippet(parsed, defaultScope, snippets, unsupported);
      } catch {
        // Ace also ignores malformed JSON snippet records.
      }
      snippet = {};
      index = end + 1;
      continue;
    }

    const directive = /^(\S+)\s+(.*)$/.exec(line);
    if (!directive) {
      index += 1;
      continue;
    }

    const [, key, value] = directive;
    if (key === 'snippet') {
      snippet.tabTrigger = /^\S*/.exec(value)?.[0] || '';
      if (!snippet.name) snippet.name = value;
    } else if (key === 'regex') {
      Object.assign(snippet, parseRegexDirective(value));
    } else {
      snippet[key] = value;
    }
    index += 1;
  }

  return { snippets, unsupported };
}

function getFilePath(file) {
  if (!file) return '';
  if (!file.uri || file.SAFMode === 'single') {
    return file.filename || file.name || '';
  }
  return file.uri;
}

function getFilename(file, filePath) {
  return (
    file?.filename ||
    file?.name ||
    String(filePath || '').split(/[\\/]/).pop() ||
    ''
  );
}

function formatDate(now, options) {
  const value = now.toLocaleString('en-us', options);
  return value.length === 1 ? `0${value}` : value;
}

export function createSnippetVariables(
  file,
  state,
  position,
  now = new Date(),
  selection = state?.selection?.main,
) {
  const filePath = getFilePath(file);
  const filename = getFilename(file, filePath);
  const filenameBase = filename.replace(/\.[^.]*$/, '');
  const doc = state?.doc;
  const safePosition = Math.max(0, Math.min(position || 0, doc?.length || 0));
  const line = doc?.lineAt?.(safePosition);
  const previousLine = line && line.number > 1 ? doc.line(line.number - 1) : null;
  const selectedText = selection && !selection.empty
    ? doc.sliceString(selection.from, selection.to)
    : '';
  const lineOffset = safePosition - (line?.from || 0);
  const wordBefore = line?.text.slice(0, lineOffset).match(/[\w$]+$/)?.[0] || '';
  const wordAfter = line?.text.slice(lineOffset).match(/^[\w$]+/)?.[0] || '';

  return {
    BLOCK_COMMENT_END: '',
    BLOCK_COMMENT_START: '',
    CLIPBOARD: '',
    CURRENT_DATE: formatDate(now, { day: '2-digit' }),
    CURRENT_DAY_NAME: formatDate(now, { weekday: 'long' }),
    CURRENT_DAY_NAME_SHORT: formatDate(now, { weekday: 'short' }),
    CURRENT_HOUR: formatDate(now, { hour: '2-digit', hour12: false }),
    CURRENT_LINE: line?.text || '',
    CURRENT_MINUTE: formatDate(now, { minute: '2-digit' }),
    CURRENT_MONTH: formatDate(now, { month: 'numeric' }),
    CURRENT_MONTH_NAME: formatDate(now, { month: 'long' }),
    CURRENT_MONTH_NAME_SHORT: formatDate(now, { month: 'short' }),
    CURRENT_SECOND: formatDate(now, { second: '2-digit' }),
    CURRENT_WORD: `${wordBefore}${wordAfter}`,
    CURRENT_YEAR: formatDate(now, { year: 'numeric' }),
    CURRENT_YEAR_SHORT: formatDate(now, { year: '2-digit' }),
    DIRECTORY: String(filePath || '').replace(/[^/\\]*$/, ''),
    FILENAME: filename,
    FILENAME_BASE: filenameBase,
    FILEPATH: filePath,
    FULLNAME: 'Unknown',
    LINE_COMMENT: '',
    LINE_INDEX: String(Math.max(0, (line?.number || 1) - 1)),
    LINE_NUMBER: String(line?.number || 1),
    PREV_LINE: previousLine?.text || '',
    SELECTED_TEXT: selectedText,
    SELECTION: selectedText,
    SOFT_TABS: 'YES',
    TAB_SIZE: '2',
    TM_FILENAME: filename,
    TM_FILENAME_BASE: filenameBase,
    TM_FILEPATH: filePath,
    WORKSPACE_NAME: 'Unknown',
  };
}

function readBraced(source, start) {
  let depth = 1;
  for (let index = start + 2; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '$' && source[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { content: source.slice(start + 2, index), end: index + 1 };
      }
    }
  }
  return null;
}

function splitTopLevel(value, separator = ':') {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === '$' && value[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (value[index] === '}' && depth) depth -= 1;
    if (value[index] === separator && depth === 0) {
      return [value.slice(0, index), value.slice(index + 1)];
    }
  }
  return [value, ''];
}

function splitTransform(value) {
  const firstSlash = value.indexOf('/');
  if (firstSlash < 1) return null;
  const target = value.slice(0, firstSlash);
  const parts = [];
  let part = '';
  let depth = 0;
  for (let index = firstSlash + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      part += char;
      if (index + 1 < value.length) part += value[++index];
      continue;
    }
    if (char === '$' && value[index + 1] === '{') {
      depth += 1;
      part += '${';
      index += 1;
      continue;
    }
    if (char === '}' && depth) {
      depth -= 1;
      part += char;
      continue;
    }
    if (char === '/' && depth === 0 && parts.length < 2) {
      parts.push(part);
      part = '';
      continue;
    }
    part += char;
  }
  parts.push(part);
  if (parts.length !== 3 || !/^(?:\d+|[A-Za-z_]\w*)$/.test(target)) {
    return null;
  }
  return {
    type: 'transform',
    target,
    regex: parts[0],
    format: parts[1],
    flags: parts[2],
  };
}

function parseChoice(value) {
  const match = /^(\d+)\|([\s\S]*)\|$/.exec(value);
  if (!match) return null;
  const choices = [];
  let current = '';
  for (let index = 0; index < match[2].length; index += 1) {
    const char = match[2][index];
    if (char === '\\' && index + 1 < match[2].length) {
      current += match[2][++index];
    } else if (char === ',') {
      choices.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  choices.push(current);
  return { type: 'field', id: match[1], choices };
}

function parseInterpolation(value) {
  const transform = splitTransform(value);
  if (transform) return transform;
  const choice = parseChoice(value);
  if (choice) return choice;

  let match = /^(\d+)\?:([\s\S]*)$/.exec(value);
  if (match) {
    return { type: 'field', id: match[1], defaultNodes: parseTemplate(match[2]) };
  }
  match = /^(\d+):([\s\S]*)$/.exec(value);
  if (match) {
    return { type: 'field', id: match[1], defaultNodes: parseTemplate(match[2]) };
  }
  if (/^\d+$/.test(value)) return { type: 'field', id: value };

  match = /^([A-Za-z_]\w*)\?:([\s\S]*)$/.exec(value);
  if (match) {
    return {
      type: 'conditional',
      target: match[1],
      operator: 'fallback',
      ifNodes: parseTemplate(match[2]),
    };
  }
  match = /^([A-Za-z_]\w*)\?([\s\S]*)$/.exec(value);
  if (match) {
    return {
      type: 'conditional',
      target: match[1],
      operator: 'present',
      ifNodes: parseTemplate(match[2]),
    };
  }
  match = /^([A-Za-z_]\w*):([+\-?])([\s\S]*)$/.exec(value);
  if (match) {
    const [ifText, elseText] = match[2] === '?'
      ? splitTopLevel(match[3])
      : [match[3], ''];
    return {
      type: 'conditional',
      target: match[1],
      operator: match[2],
      ifNodes: parseTemplate(ifText),
      elseNodes: parseTemplate(elseText),
    };
  }
  match = /^([A-Za-z_]\w*):([\s\S]*)$/.exec(value);
  if (match) {
    return {
      type: 'variable',
      name: match[1],
      defaultNodes: parseTemplate(match[2]),
    };
  }
  if (/^[A-Za-z_]\w*$/.test(value)) return { type: 'variable', name: value };
  return { type: 'text', value: `\${${value}}` };
}

export function parseTemplate(source) {
  const input = String(source || '');
  const nodes = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ type: 'text', value: text });
    text = '';
  };

  for (let index = 0; index < input.length;) {
    if (input[index] === '\\' && index + 1 < input.length) {
      const next = input[index + 1];
      text += '`$\\}'.includes(next) ? next : `\\${next}`;
      index += 2;
      continue;
    }
    if (input[index] !== '$') {
      text += input[index++];
      continue;
    }
    if (input[index + 1] === '{') {
      const braced = readBraced(input, index);
      if (!braced) {
        text += input[index++];
        continue;
      }
      flush();
      nodes.push(parseInterpolation(braced.content));
      index = braced.end;
      continue;
    }
    const direct = /^\$(\d+|[A-Za-z_]\w*)/.exec(input.slice(index));
    if (!direct) {
      text += input[index++];
      continue;
    }
    flush();
    nodes.push(/^\d+$/.test(direct[1])
      ? { type: 'field', id: direct[1] }
      : { type: 'variable', name: direct[1] });
    index += direct[0].length;
  }
  flush();
  return nodes;
}

function collectDefinitions(nodes, definitions) {
  for (const node of nodes) {
    if (node.type === 'field') {
      const definition = definitions.get(node.id) || { id: node.id };
      if (!definition.defaultNodes && node.defaultNodes) {
        definition.defaultNodes = node.defaultNodes;
      }
      if (!definition.choices && node.choices) definition.choices = node.choices;
      definitions.set(node.id, definition);
      if (node.defaultNodes) collectDefinitions(node.defaultNodes, definitions);
    } else if (node.defaultNodes) {
      collectDefinitions(node.defaultNodes, definitions);
    } else if (node.ifNodes || node.elseNodes) {
      collectDefinitions(node.ifNodes || [], definitions);
      collectDefinitions(node.elseNodes || [], definitions);
    }
  }
}

function getTargetValue(target, context, resolving = new Set()) {
  if (/^\d+$/.test(target)) {
    const definition = context.definitions.get(target);
    if (!definition || resolving.has(target)) return '';
    resolving.add(target);
    const value = renderPlain(
      definition.defaultNodes || parseTemplate(definition.choices?.[0] || ''),
      context,
      resolving,
    );
    resolving.delete(target);
    return value;
  }
  return String(context.variables[target] ?? '');
}

function renderPlain(nodes, context, resolving = new Set()) {
  let value = '';
  for (const node of nodes || []) {
    if (node.type === 'text') value += node.value;
    else if (node.type === 'field') value += getTargetValue(node.id, context, resolving);
    else if (node.type === 'variable') {
      const resolved = String(context.variables[node.name] ?? '');
      value += resolved || renderPlain(node.defaultNodes, context, resolving);
    } else if (node.type === 'conditional') {
      const resolved = String(context.variables[node.target] ?? '');
      if (node.operator === 'fallback') {
        value += resolved || renderPlain(node.ifNodes, context, resolving);
      } else if (node.operator === 'present' || node.operator === '+') {
        if (resolved) value += renderPlain(node.ifNodes, context, resolving);
      } else if (node.operator === '-') {
        if (!resolved) value += renderPlain(node.ifNodes, context, resolving);
      } else if (node.operator === '?') {
        value += renderPlain(resolved ? node.ifNodes : node.elseNodes, context, resolving);
      }
    } else if (node.type === 'transform') {
      value += applySnippetTransform(getTargetValue(node.target, context, resolving), node);
    }
  }
  return value;
}

function changeCase(value, mode) {
  if (mode === 'U') return value.toUpperCase();
  if (mode === 'L') return value.toLowerCase();
  if (mode === 'u') return value.charAt(0).toUpperCase() + value.slice(1);
  if (mode === 'l') return value.charAt(0).toLowerCase() + value.slice(1);
  return value;
}

function renderFormat(format, captures) {
  let result = '';
  let globalCase = '';
  let localCase = '';
  const append = (value) => {
    let next = String(value ?? '');
    if (localCase) {
      next = changeCase(next, localCase);
      localCase = '';
    }
    if (globalCase) next = changeCase(next, globalCase);
    result += next;
  };

  for (let index = 0; index < format.length;) {
    if (format[index] === '\\' && index + 1 < format.length) {
      const operator = format[index + 1];
      if (operator === 'u' || operator === 'l') localCase = operator;
      else if (operator === 'U' || operator === 'L') globalCase = operator;
      else if (operator === 'E') globalCase = '';
      else if (operator === 'n') append('\n');
      else if (operator === 't') append('\t');
      else append(operator);
      index += 2;
      continue;
    }
    if (format[index] === '$' && format[index + 1] === '{') {
      const braced = readBraced(format, index);
      if (braced) {
        const conditional = /^(\d+):([+\-?\/])([\s\S]*)$/.exec(braced.content);
        if (conditional) {
          const captured = captures[Number(conditional[1])] || '';
          if (conditional[2] === '/') {
            append(conditional[3] === 'upcase'
              ? captured.toUpperCase()
              : conditional[3] === 'downcase'
                ? captured.toLowerCase()
                : captured);
          } else if (conditional[2] === '+') {
            if (captured) append(conditional[3]);
          } else if (conditional[2] === '-') {
            if (!captured) append(conditional[3]);
          } else {
            const [present, absent] = splitTopLevel(conditional[3]);
            append(captured ? present : absent);
          }
        } else if (/^\d+$/.test(braced.content)) {
          append(captures[Number(braced.content)] || '');
        }
        index = braced.end;
        continue;
      }
    }
    const direct = /^\$(\d+|&)/.exec(format.slice(index));
    if (direct) {
      append(captures[direct[1] === '&' ? 0 : Number(direct[1])] || '');
      index += direct[0].length;
      continue;
    }
    append(format[index++]);
  }
  return result;
}

export function applySnippetTransform(value, transform) {
  try {
    const flags = String(transform.flags || '').replace(/[^dgimsuvy]/g, '');
    const regexp = new RegExp(transform.regex, flags);
    return String(value ?? '').replace(regexp, (...args) => {
      const captures = args.slice(0, -2);
      return renderFormat(transform.format, captures);
    });
  } catch {
    return String(value ?? '');
  }
}

function renderCompiledNodes(nodes, context, output, fields, resolving = new Set()) {
  const append = (value) => { output.value += String(value ?? ''); };
  for (const node of nodes || []) {
    if (node.type === 'text') {
      append(node.value);
      continue;
    }
    if (node.type === 'field') {
      const definition = context.definitions.get(node.id) || { id: node.id };
      const start = output.value.length;
      if (!resolving.has(node.id)) {
        resolving.add(node.id);
        renderCompiledNodes(
          definition.defaultNodes || parseTemplate(definition.choices?.[0] || ''),
          context,
          output,
          fields,
          resolving,
        );
        resolving.delete(node.id);
      }
      const end = output.value.length;
      const field = fields.get(node.id) || {
        id: node.id,
        choices: definition.choices || null,
        ranges: [],
        transforms: [],
      };
      field.ranges.push({ from: start, to: end });
      fields.set(node.id, field);
      continue;
    }
    if (node.type === 'variable') {
      const value = String(context.variables[node.name] ?? '');
      if (value) append(value);
      else renderCompiledNodes(node.defaultNodes, context, output, fields, resolving);
      continue;
    }
    if (node.type === 'conditional') {
      const value = String(context.variables[node.target] ?? '');
      if (node.operator === 'fallback') {
        if (value) append(value);
        else renderCompiledNodes(node.ifNodes, context, output, fields, resolving);
      } else if (node.operator === 'present' || node.operator === '+') {
        if (value) renderCompiledNodes(node.ifNodes, context, output, fields, resolving);
      } else if (node.operator === '-') {
        if (!value) renderCompiledNodes(node.ifNodes, context, output, fields, resolving);
      } else if (node.operator === '?') {
        renderCompiledNodes(
          value ? node.ifNodes : node.elseNodes,
          context,
          output,
          fields,
          resolving,
        );
      }
      continue;
    }
    if (node.type === 'transform') {
      const start = output.value.length;
      append(applySnippetTransform(getTargetValue(node.target, context), node));
      const end = output.value.length;
      if (/^\d+$/.test(node.target)) {
        const field = fields.get(node.target) || {
          id: node.target,
          choices: null,
          ranges: [],
          transforms: [],
        };
        field.transforms.push({
          from: start,
          to: end,
          regex: node.regex,
          format: node.format,
          flags: node.flags,
        });
        fields.set(node.target, field);
      }
    }
  }
}

function formatCompiledIndentation(compiled, indentation, tabString) {
  if (!indentation && tabString === '\t') return compiled;
  const positions = new Array(compiled.text.length + 1);
  let formatted = '';
  for (let index = 0; index < compiled.text.length; index += 1) {
    positions[index] = formatted.length;
    const char = compiled.text[index];
    if (char === '\t') formatted += tabString;
    else if (char === '\n') formatted += `\n${indentation}`;
    else formatted += char;
  }
  positions[compiled.text.length] = formatted.length;
  const mapRange = (range) => ({
    ...range,
    from: positions[range.from],
    to: positions[range.to],
  });
  return {
    text: formatted,
    fields: compiled.fields.map((field) => ({
      ...field,
      ranges: field.ranges.map(mapRange),
      transforms: field.transforms.map(mapRange),
    })),
  };
}

/** Compile Ace/TextMate snippet text into editable CodeMirror field ranges. */
export function compileSnippetTemplate(template, options = {}) {
  const nodes = parseTemplate(template);
  const definitions = new Map();
  collectDefinitions(nodes, definitions);
  const context = {
    definitions,
    variables: {
      ...(options.variables || {}),
      ...(options.matches || {}),
    },
  };
  const output = { value: '' };
  const fields = new Map();
  renderCompiledNodes(nodes, context, output, fields);
  const compiled = {
    text: output.value,
    fields: [...fields.values()].sort((left, right) => {
      if (left.id === '0') return 1;
      if (right.id === '0') return -1;
      return Number(left.id) - Number(right.id);
    }),
  };
  return formatCompiledIndentation(
    compiled,
    options.indentation || '',
    options.tabString || '\t',
  );
}

// Kept for plugin-local callers. Native CodeMirror snippets cannot represent
// Ace transforms, so runtime insertion uses compileSnippetTemplate directly.
export function prepareSnippetTemplate(template, variables = {}) {
  return {
    template: compileSnippetTemplate(template, { variables }).text,
    unsupportedReason: '',
  };
}

export function getCompletionPrefix(lineBeforeCursor) {
  return /[^\s()[\]{};,="'`]*$/.exec(String(lineBeforeCursor || ''))?.[0] || '';
}

function wrapRegexp(source) {
  if (source && !/^\^?\(.*\)\$?$|^\\b$/.test(source)) return `(?:${source})`;
  return source || '';
}

function guardedRegexp(expression, guard, opening) {
  let source = wrapRegexp(expression);
  const wrappedGuard = wrapRegexp(guard);
  if (opening) {
    source = wrappedGuard + source;
    if (source && !source.endsWith('$')) source += '$';
  } else {
    source += wrappedGuard;
    if (source && !source.startsWith('^')) source = `^${source}`;
  }
  return source ? new RegExp(source) : null;
}

function compileSnippetMatcher(snippet) {
  if (snippet._matcher) return snippet._matcher;
  let { guard, trigger, endTrigger, endGuard } = snippet;
  if (snippet.tabTrigger && !trigger) {
    if (!guard && /^\w/.test(snippet.tabTrigger)) guard = '\\b';
    trigger = escapeRegExp(snippet.tabTrigger);
  }
  try {
    snippet._matcher = {
      startRe: guardedRegexp(trigger, guard, true),
      triggerRe: trigger ? new RegExp(`(?:${trigger})$`) : null,
      endRe: guardedRegexp(endTrigger, endGuard, false),
      endTriggerRe: endTrigger ? new RegExp(`^(?:${endTrigger})`) : null,
    };
  } catch (error) {
    snippet._matcher = { error };
  }
  return snippet._matcher;
}

export function findMatchingSnippet(snippets, lineBeforeCursor, lineAfterCursor = '') {
  const before = String(lineBeforeCursor || '');
  const after = String(lineAfterCursor || '');
  for (let index = snippets.length - 1; index >= 0; index -= 1) {
    const snippet = snippets[index];
    if (snippet.unsupportedReason) continue;
    const matcher = compileSnippetMatcher(snippet);
    if (matcher.error || (!matcher.startRe && !matcher.endRe)) continue;
    if (matcher.startRe && !matcher.startRe.test(before)) continue;
    if (matcher.endRe && !matcher.endRe.test(after)) continue;
    const matchBefore = matcher.startRe?.exec(before) || [''];
    const matchAfter = matcher.endRe?.exec(after) || [''];
    const replaceBefore = matcher.triggerRe?.exec(before)?.[0] || '';
    const replaceAfter = matcher.endTriggerRe?.exec(after)?.[0] || '';
    const matches = {};
    matchBefore.forEach((value, matchIndex) => {
      matches[`M${matchIndex}`] = value || '';
    });
    matchAfter.forEach((value, matchIndex) => {
      matches[`T${matchIndex}`] = value || '';
    });
    return {
      snippet,
      from: before.length - replaceBefore.length,
      to: before.length + replaceAfter.length,
      matchBefore,
      matchAfter,
      matches,
    };
  }
  return null;
}

export class SnippetCache {
  constructor(loader) {
    this.loader = loader;
    this.pending = new Map();
    this.values = new Map();
    this.generation = 0;
  }

  getOrLoad(scope) {
    if (this.pending.has(scope)) return this.pending.get(scope);
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(() => this.loader(scope))
      .then((value) => {
        if (generation === this.generation) this.values.set(scope, value);
        return value;
      })
      .finally(() => {
        if (this.pending.get(scope) === pending) this.pending.delete(scope);
      });
    this.pending.set(scope, pending);
    return pending;
  }

  getLoaded(scope) {
    return this.values.get(scope) || null;
  }

  clear() {
    this.generation += 1;
    this.pending.clear();
    this.values.clear();
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
