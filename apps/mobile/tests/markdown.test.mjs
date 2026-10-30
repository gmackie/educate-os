import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseSpans, plainText } from '../src/markdown.ts';

test('blocks: headings, paragraphs joined across lines, and lists of each kind', () => {
  assert.deepEqual(parseBlocks('## Build it\n\nA strong\nargument.\n\n- one\n- two\n1. first\n2) second'), [
    { kind: 'heading', level: 2, text: 'Build it' },
    { kind: 'paragraph', text: 'A strong argument.' },
    { kind: 'list', ordered: false, items: ['one', 'two'] },
    { kind: 'list', ordered: true, items: ['first', 'second'] },
  ]);
  assert.equal(parseBlocks('##### deep')[0].level, 3);
});

test('spans: bold, italic, code and link text; HTML stays text', () => {
  assert.deepEqual(parseSpans('a **claim**, *why*, `x` and [notes](https://evil.test)'), [
    { text: 'a ' }, { text: 'claim', bold: true }, { text: ', ' }, { text: 'why', italic: true }, { text: ', ' },
    { text: 'x', code: true }, { text: ' and ' }, { text: 'notes' },
  ]);
  assert.deepEqual(parseSpans('<b>hi</b>'), [{ text: '<b>hi</b>' }]);
});

test('plainText flattens Markdown for previews', () => {
  assert.equal(plainText('Take a side and give **one** reason.\n\n- a\n- b'), 'Take a side and give one reason. a, b');
});
