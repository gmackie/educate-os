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
  assert.deepEqual(parseSpans('a **claim**, *why*, `x` and [notes](https://notes.example/a)'), [
    { text: 'a ' }, { text: 'claim', bold: true }, { text: ', ' }, { text: 'why', italic: true }, { text: ', ' },
    { text: 'x', code: true }, { text: ' and ' }, { text: 'notes', href: 'https://notes.example/a' },
  ]);
  assert.deepEqual(parseSpans('<b>hi</b>'), [{ text: '<b>hi</b>' }]);
});

test('links are tappable only for plain https addresses', () => {
  for (const address of ['javascript:alert`1`', 'data:text/html,x', 'http://plain.example', 'https://u:p@x.example', 'educateos://class/1', '']) {
    assert.deepEqual(parseSpans('[go](' + address + ')'), [{ text: 'go' }], address);
  }
});

test('simple pipe tables become tables; ragged rows are padded and extra cells dropped', () => {
  assert.deepEqual(parseBlocks('Before\n| Word | Sound |\n|---|:--:|\n| cat | /k/ |\n| dog |\n| a | b | c |\nAfter'), [
    { kind: 'paragraph', text: 'Before' },
    { kind: 'table', header: ['Word', 'Sound'], rows: [['cat', '/k/'], ['dog', ''], ['a', 'b']] },
    { kind: 'paragraph', text: 'After' },
  ]);
  // A row without a divider line is an ordinary paragraph.
  assert.deepEqual(parseBlocks('| not | a table |'), [{ kind: 'paragraph', text: '| not | a table |' }]);
  assert.equal(plainText('| A | B |\n|-|-|\n| 1 | 2 |'), 'A, B. 1, 2');
});

test('plainText flattens Markdown for previews', () => {
  assert.equal(plainText('Take a side and give **one** reason.\n\n- a\n- b'), 'Take a side and give one reason. a, b');
});
