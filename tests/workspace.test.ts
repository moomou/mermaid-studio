import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateTab, activeTab, addTab, closeTab, createWorkspace, decodeWorkspace,
  encodeWorkspace, oppositeTheme, resolveTheme, updateTab,
} from '../src/workspace.ts';

test('workspace state round-trips with independent per-tab source and layout options', () => {
  let workspace = createWorkspace('flowchart LR\nA --> B', 'one');
  workspace = addTab(workspace, {
    id: 'two',
    title: 'Second',
    source: 'sequenceDiagram\nA->>B: Hello',
    original: true,
    automatic: false,
  });
  workspace = updateTab(workspace, 'one', { title: 'First' });
  workspace = activateTab(workspace, 'one');

  const restored = decodeWorkspace(encodeWorkspace(workspace));
  assert.deepEqual(restored, workspace);
  assert.equal(activeTab(restored).title, 'First');
  assert.equal(restored.tabs[1].original, true);
});

test('closing tabs keeps the current tab or selects the nearest surviving tab', () => {
  let workspace = createWorkspace('flowchart LR\nA --> B', 'one');
  workspace = addTab(workspace, {
    id: 'two', title: 'Second', source: 'flowchart LR\nB --> C', original: false, automatic: true,
  });
  workspace = addTab(workspace, {
    id: 'three', title: 'Third', source: 'flowchart LR\nC --> D', original: false, automatic: true,
  });
  workspace = activateTab(workspace, 'two');

  workspace = closeTab(workspace, 'one');
  assert.equal(workspace.activeId, 'two');
  workspace = closeTab(workspace, 'two');
  assert.equal(workspace.activeId, 'three');
  assert.throws(() => closeTab(workspace, 'three'), /At least one/);
});

test('invalid saved workspaces fail explicitly', () => {
  assert.throws(() => decodeWorkspace('{'), /valid JSON/);
  assert.throws(() => decodeWorkspace('{"version":1,"activeId":"one","tabs":[]}'), /invalid format/);
  assert.throws(() => decodeWorkspace(JSON.stringify({
    version: 1,
    activeId: 'missing',
    tabs: [{ id: 'one', title: 'One', source: 'flowchart LR\nA', original: false, automatic: true }],
  })), /active diagram/);
  assert.throws(() => decodeWorkspace(JSON.stringify({
    version: 1,
    activeId: 'one',
    tabs: [
      { id: 'one', title: 'One', source: 'flowchart LR\nA', original: false, automatic: true },
      { id: 'one', title: 'Two', source: 'flowchart LR\nB', original: false, automatic: true },
    ],
  })), /duplicate/);
});

test('theme selection uses a saved choice before the system preference', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('unexpected', false), 'light');
  assert.equal(oppositeTheme('light'), 'dark');
});
