import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { contentPatchSchema, mergeContentPatch } from '../src/modules/docs/content-patch.js';
const block = (text = 'Note') => ({ id: randomUUID(), type: 'paragraph', text, checked: false });
test('content deltas preserve untouched blocks and metadata; ordering is exact', () => {
  const a = block(),
    b = block('two'),
    current = { title: 'Doc', kind: 'document', color: '#164e3d', blocks: [a, b], elements: [] };
  const changed = { ...a, text: 'Changed' };
  const out = mergeContentPatch(current, {
    blocks: { upsert: [changed], remove: [], order: [b.id, a.id] },
  });
  assert.equal(out.blocks[0].text, 'two');
  assert.equal(out.blocks[1].text, 'Changed');
  assert.equal(out.title, 'Doc');
  assert.equal(current.blocks[0].text, 'Note');
  assert.throws(() =>
    mergeContentPatch(current, { blocks: { upsert: [], remove: [], order: [a.id, a.id] } }),
  );
  assert.throws(() =>
    mergeContentPatch(current, { blocks: { upsert: [{ ...a, type: 'html' }], remove: [] } }),
  );
  assert.throws(() =>
    contentPatchSchema.parse({ revision: 1, changes: { businessId: randomUUID() } }),
  );
});
test('delta validation keeps scene and document size limits, file rules and typed content', () => {
  const current = {
    title: 'Board',
    kind: 'board',
    color: '#164e3d',
    blocks: [],
    elements: [],
    board: {
      format: 'excalidraw',
      version: 2,
      elements: [],
      files: {},
      appState: { viewBackgroundColor: '#ffffff', gridSize: null, gridModeEnabled: false },
      libraryItems: [],
    },
  };
  const out = mergeContentPatch(current, {
    boardPatch: { appState: { ...current.board.appState, viewBackgroundColor: '#195a43' } },
  });
  assert.equal(out.board.appState.viewBackgroundColor, '#195a43');
  assert.throws(() =>
    mergeContentPatch(current, {
      boardPatch: { elements: { upsert: [{ id: 'evil', type: 'html' }], remove: [] } },
    }),
  );
  assert.throws(() =>
    mergeContentPatch(current, { board: { ...current.board, libraryItems: Array(101).fill({}) } }),
  );
  const doc = { title: 'Doc', kind: 'document', color: '#164e3d', blocks: [block()], elements: [] };
  assert.throws(() => mergeContentPatch(doc, { boardPatch: {} }));
  assert.throws(() =>
    contentPatchSchema.parse(
      JSON.parse('{"revision":1,"changes":{"boardPatch":{"files":{"upsert":{"__proto__":{}}}}}}'),
    ),
  );
});
