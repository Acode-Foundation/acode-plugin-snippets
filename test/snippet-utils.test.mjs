import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applySnippetTransform,
  compileSnippetTemplate,
  createSnippetVariables,
  findMatchingSnippet,
  getCompletionPrefix,
  normalizeModeMapping,
  normalizeModeMappings,
  parseSnippetFile,
  resolveActiveSnippetScopes,
  resolvePreloadSnippetScopes,
  resolveSnippetScopes,
  SnippetCache,
} from '../src/snippet-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parses Ace directives, regex guards, bodies, and scopes without lossy skips', () => {
  const parsed = parseSnippetFile([
    '# comment',
    'regex /((=)\\s*|\\b)/f/(\\))?/',
    'snippet f anonymous function',
    '\tfunction${M1?: ${1:functionName}}($2) {$0}${M2?;}',
    'scope html',
    'snippet tag',
    '\t<${1:div}>$0</${1}>',
  ].join('\n'), 'javascript');

  assert.equal(parsed.snippets.length, 2);
  assert.equal(parsed.unsupported.length, 0);
  assert.deepEqual(
    parsed.snippets.map(({ tabTrigger, scope }) => ({ tabTrigger, scope })),
    [
      { tabTrigger: 'f', scope: 'javascript' },
      { tabTrigger: 'tag', scope: 'html' },
    ],
  );
  assert.equal(parsed.snippets[0].guard, '((=)\\s*|\\b)');
  assert.equal(parsed.snippets[0].trigger, 'f');
  assert.equal(parsed.snippets[0].endTrigger, '(\\))?');
});

test('maps CodeMirror modes and resolves embedded JavaScript, CSS, HTML, and PHP scopes', () => {
  assert.deepEqual(resolveSnippetScopes('c'), ['c_cpp']);
  assert.deepEqual(resolveSnippetScopes('cpp'), ['c_cpp']);
  assert.deepEqual(resolveSnippetScopes('CoffeeScript'), ['coffee']);
  assert.deepEqual(resolveSnippetScopes('go'), ['golang']);
  assert.deepEqual(resolveSnippetScopes('Shell'), ['sh']);
  assert.deepEqual(resolveSnippetScopes('LaTeX'), ['tex']);
  assert.deepEqual(resolveSnippetScopes('ms-sql'), ['sqlserver']);
  assert.deepEqual(resolveSnippetScopes('PostgreSQL'), ['sql']);
  assert.deepEqual(resolveSnippetScopes('text', 'Makefile'), ['makefile']);
  assert.deepEqual(resolveSnippetScopes('text', 'custom.snippets'), ['snippets']);
  assert.deepEqual(resolvePreloadSnippetScopes('html'), [
    'html',
    'javascript',
    'css',
  ]);
  assert.deepEqual(
    resolveActiveSnippetScopes('html', 'index.html', ['Script', 'Element']),
    ['javascript'],
  );
  assert.deepEqual(
    resolveActiveSnippetScopes('php', 'index.php', ['StyleSheet', 'Element']),
    ['css'],
  );
  assert.deepEqual(
    resolveActiveSnippetScopes('php', 'index.php', ['Text', 'Element', 'Template']),
    ['html'],
  );
  assert.deepEqual(
    resolveActiveSnippetScopes('php', 'index.php', ['FunctionDefinition', 'Template']),
    ['php', 'html'],
  );
});

test('normalizes safe custom mappings and lets them override default scopes', () => {
  assert.deepEqual(normalizeModeMapping(' ACE/MODE/Zig ', 'Rust.snippets'), {
    mode: 'zig',
    scope: 'rust',
  });
  assert.deepEqual(normalizeModeMappings({
    Go: 'rust.snippets',
    '../unsafe': '../javascript',
    blank: '',
  }), { go: 'rust' });
  assert.equal(normalizeModeMapping('zig', '../rust'), null);
  assert.equal(normalizeModeMapping('zig mode', 'rust'), null);

  const mappings = { go: 'rust', text: 'javascript', html: 'php' };
  assert.deepEqual(resolveSnippetScopes('go', '', mappings), ['rust']);
  assert.deepEqual(resolveSnippetScopes('text', 'Makefile', mappings), [
    'javascript',
  ]);
  assert.deepEqual(resolvePreloadSnippetScopes('html', '', mappings), [
    'php',
    'html',
    'javascript',
    'css',
  ]);
  assert.deepEqual(
    resolveActiveSnippetScopes('html', 'index.html', ['Script'], mappings),
    ['javascript'],
  );
  assert.deepEqual(resolveSnippetScopes('go'), ['golang']);
});

test('matches the Ace golden expansion for fun and keeps ordered field ranges', () => {
  const compiled = compileSnippetTemplate([
    'function ${1?:function_name}(${2:argument}) {',
    '\t${3:// body...}',
    '}',
  ].join('\n'), { tabString: '  ' });

  assert.equal(compiled.text, [
    'function function_name(argument) {',
    '  // body...',
    '}',
  ].join('\n'));
  assert.deepEqual(compiled.fields.map(({ id }) => id), ['1', '2', '3']);
  assert.equal(
    compiled.text.slice(
      compiled.fields[0].ranges[0].from,
      compiled.fields[0].ranges[0].to,
    ),
    'function_name',
  );
});

test('supports Ace match variables, regex guards, and end triggers used by JavaScript', () => {
  const javascript = parseSnippetFile(
    fs.readFileSync(path.join(repoRoot, 'dist/snippets/javascript.snippets'), 'utf8'),
    'javascript',
  ).snippets;
  const cases = [
    ['f', '', 'f'],
    ['(f', ')', 'f'],
    ['f(', ')', 'f('],
    [':f', '', ':f'],
    ['setTimeo', '', 'setTimeout'],
    [' * @par', '', '@par'],
    ['  class', '', 'class'],
    ['  req', '', 'req'],
    ['  requ', '', 'requ'],
  ];

  for (const [before, after, trigger] of cases) {
    const match = findMatchingSnippet(javascript, before, after);
    assert.equal(match?.snippet.tabTrigger, trigger, `${before}|${after}`);
  }

  const anonymous = findMatchingSnippet(javascript, 'f', '');
  const compiled = compileSnippetTemplate(anonymous.snippet.content, {
    matches: anonymous.matches,
  });
  assert.equal(compiled.text, 'function functionName() {\n\t\n}');
  assert.deepEqual(compiled.fields.map(({ id }) => id), ['1', '2', '0']);

  const line = 'const timer = setTimeo';
  const timeout = findMatchingSnippet(javascript, line, '');
  assert.equal(timeout.snippet.tabTrigger, 'setTimeout');
  assert.equal(timeout.from, line.indexOf('setTimeo'));
  assert.equal(timeout.to, line.length);
  assert.equal(line.slice(timeout.from, timeout.to), 'setTimeo');
  assert.equal(timeout.matches.M0, 'setTimeo');

  const wrapped = findMatchingSnippet(javascript, 'const handler = (f', ')');
  assert.equal(wrapped.snippet.tabTrigger, 'f');
  assert.equal(wrapped.matches.M0.endsWith('f'), true);
  assert.equal(wrapped.matches.T0, ')');
  assert.equal(wrapped.to, 'const handler = (f'.length + 1);
});

test('supports mirrors, nested defaults, choices, final cursors, and escaped dollars', () => {
  const compiled = compileSnippetTemplate([
    '\\$this = ${1:${TM_FILENAME_BASE}${2:Props}};',
    '${1} ${3|one,two,three|}',
    '$0',
  ].join('\n'), {
    variables: { TM_FILENAME_BASE: 'Button' },
  });

  assert.equal(compiled.text, '$this = ButtonProps;\nButtonProps one\n');
  assert.deepEqual(compiled.fields.map(({ id }) => id), ['1', '2', '3', '0']);
  assert.equal(compiled.fields[0].ranges.length, 2);
  assert.deepEqual(compiled.fields[2].choices, ['one', 'two', 'three']);
});

test('applies variable and placeholder transforms, flags, and case operators', () => {
  assert.equal(applySnippetTransform('lib/Button', {
    regex: '.*\\/',
    format: '',
    flags: '',
  }), 'Button');
  assert.equal(applySnippetTransform('state', {
    regex: '(.)',
    format: 'set\\u$1',
    flags: '',
  }), 'setState');
  assert.equal(applySnippetTransform('abc', {
    regex: '.',
    format: '=',
    flags: 'g',
  }), '===');
  assert.equal(applySnippetTransform('hello-world', {
    regex: '(hello)-(world)',
    format: '${1:/upcase}\\u$2',
    flags: '',
  }), 'HELLOWorld');

  const markdown = compileSnippetTemplate('${PREV_LINE/./=/g}', {
    variables: { PREV_LINE: 'Heading' },
  });
  assert.equal(markdown.text, '=======');

  const transformedMirror = compileSnippetTemplate(
    'import ${1/.*\\///} from "${1}";',
  );
  assert.equal(transformedMirror.fields[0].transforms.length, 1);
  assert.equal(transformedMirror.fields[0].ranges.length, 1);
});

test('resolves common file, selection, word, line, and date variables', () => {
  const text = 'hello\nworld';
  const doc = {
    length: text.length,
    line(number) {
      return number === 1
        ? { number: 1, text: 'hello', from: 0 }
        : { number: 2, text: 'world', from: 6 };
    },
    lineAt(position) {
      return position < 6 ? this.line(1) : this.line(2);
    },
    sliceString(from, to) {
      return text.slice(from, to);
    },
  };
  const variables = createSnippetVariables(
    { filename: 'demo.tsx', uri: '/project/demo.tsx' },
    { doc, selection: { main: { from: 6, to: 11, empty: false } } },
    8,
    new Date('2026-08-29T12:34:56Z'),
  );

  assert.equal(variables.FILEPATH, '/project/demo.tsx');
  assert.equal(variables.FILENAME, 'demo.tsx');
  assert.equal(variables.TM_FILENAME_BASE, 'demo');
  assert.equal(variables.PREV_LINE, 'hello');
  assert.equal(variables.CURRENT_LINE, 'world');
  assert.equal(variables.CURRENT_WORD, 'world');
  assert.equal(variables.SELECTED_TEXT, 'world');
  assert.equal(variables.LINE_NUMBER, '2');
  assert.equal(variables.CURRENT_YEAR, '2026');

  const firstSelectionVariables = createSnippetVariables(
    { filename: 'demo.tsx', uri: '/project/demo.tsx' },
    { doc, selection: { main: { from: 6, to: 11, empty: false } } },
    2,
    new Date('2026-08-29T12:34:56Z'),
    { from: 0, to: 5, empty: false },
  );
  assert.equal(firstSelectionVariables.SELECTED_TEXT, 'hello');
  assert.equal(firstSelectionVariables.SELECTION, 'hello');
});

test('finds fuzzy completion prefixes and exact or regex Tab triggers', () => {
  const snippets = [
    { tabTrigger: 'if', name: 'if' },
    { tabTrigger: '.', name: 'dot' },
    { tabTrigger: 'timeout', trigger: 'timeout|setTimeo?u?t?' },
  ];
  assert.equal(getCompletionPrefix('  bdi:m+'), 'bdi:m+');
  assert.equal(findMatchingSnippet(snippets, 'if')?.snippet.name, 'if');
  assert.equal(findMatchingSnippet(snippets, 'diff'), null);
  assert.equal(findMatchingSnippet(snippets, 'value.')?.snippet.name, 'dot');
  assert.equal(findMatchingSnippet(snippets, 'setTimeo')?.snippet.tabTrigger, 'timeout');
});

test('deduplicates cache loads and prevents stale results after a clear', async () => {
  let calls = 0;
  let resolvePending;
  const cache = new SnippetCache((scope) => {
    calls += 1;
    if (calls === 1) return { scope };
    return new Promise((resolve) => {
      resolvePending = resolve;
    });
  });

  const [first, second] = await Promise.all([
    cache.getOrLoad('javascript'),
    cache.getOrLoad('javascript'),
  ]);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(cache.getLoaded('javascript'), { scope: 'javascript' });

  cache.clear();
  assert.equal(cache.getLoaded('javascript'), null);
  const staleLoad = cache.getOrLoad('javascript');
  await Promise.resolve();
  assert.equal(calls, 2);
  cache.clear();
  resolvePending({ scope: 'stale' });
  await staleLoad;
  assert.equal(cache.getLoaded('javascript'), null);
});

test('cools down failed cache loads without poisoning later retries', async () => {
  let calls = 0;
  let currentTime = 1000;
  const failure = new Error('temporary read failure');
  const cache = new SnippetCache(
    async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return { snippets: ['recovered'] };
    },
    { failureCooldown: 5000, now: () => currentTime },
  );

  await assert.rejects(cache.getOrLoad('javascript'), failure);
  assert.equal(cache.getStatus('javascript'), 'failed');
  await assert.rejects(cache.getOrLoad('javascript'), failure);
  assert.equal(calls, 1);

  currentTime += 5000;
  assert.equal(cache.getStatus('javascript'), 'missing');
  assert.deepEqual(
    await cache.getOrLoad('javascript'),
    { snippets: ['recovered'] },
  );
  assert.equal(calls, 2);
  assert.equal(cache.getStatus('javascript'), 'loaded');
});

test('accepts and compiles all 3,578 packaged snippets, including all 42 JavaScript snippets', () => {
  const snippetDirectory = path.join(repoRoot, 'dist/snippets');
  const files = fs.readdirSync(snippetDirectory)
    .filter((filename) => filename.endsWith('.snippets'));
  let snippetCount = 0;
  let javascriptCount = 0;

  assert.equal(files.length, 55);
  for (const filename of files) {
    const scope = path.basename(filename, '.snippets');
    const parsed = parseSnippetFile(
      fs.readFileSync(path.join(snippetDirectory, filename), 'utf8'),
      scope,
    );
    assert.equal(parsed.unsupported.length, 0, filename);
    snippetCount += parsed.snippets.length;
    if (scope === 'javascript') javascriptCount = parsed.snippets.length;
    for (const snippet of parsed.snippets) {
      assert.doesNotThrow(() => compileSnippetTemplate(snippet.content), (
        `${filename}: ${snippet.name}`
      ));
    }
  }

  assert.equal(snippetCount, 3578);
  assert.equal(javascriptCount, 42);
});
