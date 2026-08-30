import assert from 'node:assert/strict';
import test from 'node:test';

import { snippetsStreamParser } from '../src/snippets-language.mjs';

class TestStringStream {
  constructor(string) {
    this.string = string;
    this.pos = 0;
    this.start = 0;
  }

  current() {
    return this.string.slice(this.start, this.pos);
  }

  eat(match) {
    const character = this.peek();
    const matched = typeof match === 'string'
      ? character === match
      : Boolean(character && match.test(character));
    if (!matched) return undefined;
    this.pos += 1;
    return character;
  }

  eatSpace() {
    return this.eatWhile(/\s/);
  }

  eatWhile(match) {
    const start = this.pos;
    while (!this.eol() && this.eat(match)) {}
    return this.pos > start;
  }

  eol() {
    return this.pos >= this.string.length;
  }

  match(pattern, consume = true) {
    const remaining = this.string.slice(this.pos);
    if (typeof pattern === 'string') {
      if (!remaining.startsWith(pattern)) return false;
      if (consume) this.pos += pattern.length;
      return true;
    }

    const matched = remaining.match(pattern);
    if (!matched || matched.index !== 0) return null;
    if (consume) this.pos += matched[0].length;
    return matched;
  }

  next() {
    if (this.eol()) return undefined;
    return this.string[this.pos++];
  }

  peek() {
    return this.string[this.pos];
  }

  skipToEnd() {
    this.pos = this.string.length;
  }

  sol() {
    return this.pos === 0;
  }
}

function tokenize(lines) {
  const state = snippetsStreamParser.startState();
  const tokens = [];
  for (const line of lines) {
    const stream = new TestStringStream(line);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = snippetsStreamParser.token(stream, state);
      assert.ok(stream.pos > stream.start, `Tokenizer stalled at: ${line}`);
      tokens.push({ style, text: stream.current() });
    }
  }
  return tokens;
}

function styleFor(tokens, text) {
  return tokens.find((token) => token.text === text)?.style;
}

test('highlights Ace snippet directives, regexes, bodies, and placeholders', () => {
  const tokens = tokenize([
    '# snippets for JavaScript',
    'snippet fun named function',
    'guard (?=function)',
    'regex ^foo/(.*)$',
    '\t${1|one,two|} ${TM_FILENAME/(.*)/\\u$1/g} $0 \\$',
  ]);

  assert.equal(styleFor(tokens, '# snippets for JavaScript'), 'comment');
  assert.equal(styleFor(tokens, 'snippet'), 'keyword');
  assert.equal(styleFor(tokens, 'fun named function'), 'string');
  assert.equal(styleFor(tokens, 'guard'), 'keyword');
  assert.equal(styleFor(tokens, '(?=function)'), 'regexp');
  assert.equal(styleFor(tokens, 'regex'), 'keyword');
  assert.equal(styleFor(tokens, '^foo/(.*)$'), 'regexp');
  assert.equal(styleFor(tokens, '${'), 'bracket');
  assert.equal(styleFor(tokens, '1'), 'number');
  assert.equal(styleFor(tokens, 'one,two'), 'string');
  assert.equal(styleFor(tokens, 'TM_FILENAME'), 'variableName');
  assert.equal(styleFor(tokens, '(.*)'), 'regexp');
  assert.equal(styleFor(tokens, '\\u'), 'keyword');
  assert.equal(styleFor(tokens, '$1'), 'variableName');
  assert.equal(styleFor(tokens, 'g'), 'regexp');
  assert.equal(styleFor(tokens, '$0'), 'variableName');
  assert.equal(styleFor(tokens, '\\$'), 'escape');
});

test('supports nested defaults, conditionals, scopes, and invalid body indentation', () => {
  const tokens = tokenize([
    'scope javascript,jsx',
    'description function helper',
    '  body must start with a tab',
    '\t${1?:${2:function_name}}',
  ]);

  assert.equal(styleFor(tokens, 'scope'), 'keyword');
  assert.equal(styleFor(tokens, 'javascript,jsx'), 'string');
  assert.equal(styleFor(tokens, 'description'), 'keyword');
  assert.equal(styleFor(tokens, 'function helper'), 'string');
  assert.equal(styleFor(tokens, '  '), 'invalid');
  assert.equal(tokens.filter(({ text }) => text === '${').length, 2);
  assert.equal(tokens.filter(({ style }) => style === 'bracket').length, 4);
});

test('keeps nested format variables inside the transform format section', () => {
  const tokens = tokenize([
    '\t${TM_FILENAME/(.*)/${1:/upcase}-${1:+present}/g}',
  ]);

  assert.equal(tokens.filter(({ text }) => text === '${').length, 3);
  assert.equal(tokens.filter(({ text }) => text === '1').length, 2);
  assert.equal(styleFor(tokens, '/upcase'), 'keyword');
  assert.equal(styleFor(tokens, '+'), 'punctuation');
  assert.equal(styleFor(tokens, 'g'), 'regexp');
  assert.equal(tokens.filter(({ style }) => style === 'bracket').length, 6);
});
