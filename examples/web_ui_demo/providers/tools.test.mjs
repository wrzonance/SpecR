// examples/web_ui_demo/providers/tools.test.mjs
// Pure partition logic — no network. Run:
//   node --test examples/web_ui_demo/providers/tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_CORE_TOOLS, REPORT_CORE_TOOLS, splitCoreAndDeferred } from './tools.mjs';

const tool = (name, readOnly = true) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object', properties: {} },
  readOnly,
});

test('splitCoreAndDeferred puts named tools in core and everything else in deferred', () => {
  const catalog = [tool('list_projects'), tool('get_spec'), tool('submittal_register')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['list_projects', 'get_spec']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects', 'get_spec']
  );
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['submittal_register']
  );
});

test('splitCoreAndDeferred: a core name absent from the catalog produces no phantom entry', () => {
  // Tier gating (MCP_ALLOWED_TIERS) can remove a tool from tools/list entirely.
  const catalog = [tool('list_projects'), tool('submittal_register')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['list_projects', 'get_spec']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects']
  );
  assert.equal(core.length, 1);
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['submittal_register']
  );
});

test('splitCoreAndDeferred throws when no core tool survives — both APIs reject all-deferred', () => {
  const catalog = [tool('submittal_register')];
  assert.throws(() => splitCoreAndDeferred(catalog, ['list_projects']), /at least one non-deferred/i);
});

test('splitCoreAndDeferred preserves catalog order within each partition', () => {
  const catalog = [tool('a'), tool('list_projects'), tool('b'), tool('get_spec')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['get_spec', 'list_projects']);
  assert.deepEqual(
    core.map((t) => t.name),
    ['list_projects', 'get_spec']
  );
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['a', 'b']
  );
});

test('the chat core set is the five agreed tools', () => {
  assert.deepEqual(CHAT_CORE_TOOLS, [
    'list_projects',
    'list_sections',
    'search_library',
    'get_spec',
    'get_references',
  ]);
});

test('the report core set is the three discovery tools its prompt names first', () => {
  assert.deepEqual(REPORT_CORE_TOOLS, ['list_projects', 'list_sections', 'search_library']);
});
