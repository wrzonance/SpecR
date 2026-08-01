// examples/web_ui_demo/providers/tools.test.mjs
// Pure partition logic — no network. Run:
//   node --test examples/web_ui_demo/providers/tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHAT_CORE_TOOLS, REPORT_CORE_TOOLS, splitCoreAndDeferred } from './tools.mjs';
import { SYSTEM_PROMPT } from '../chat-handler.mjs';
import { REPORT_SYSTEM_PROMPT } from '../report-bridge.mjs';

// Extract the comma/or-separated tool names out of a "discover ... first
// with X, Y, or Z[, then ...]" sentence in a live prompt string. Used to pin
// CHAT_CORE_TOOLS / REPORT_CORE_TOOLS against the ACTUAL prompt text the
// model reads, not a hand-copied duplicate of the constant under test — so a
// prompt edit that drops/adds a discovery tool without touching the constant
// (or vice versa) fails these tests instead of passing silently.
function discoveryToolsIn(prompt, sentenceRegex) {
  const match = prompt.match(sentenceRegex);
  assert.ok(match, `expected prompt to contain a "discover ... first with" sentence`);
  return match[1]
    .split(/,\s*(?:or\s+)?|\s+or\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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

test('splitCoreAndDeferred allows an empty core — the adapter’s own search tool is the non-deferred one', () => {
  // Tier gating can remove every named core tool. What the APIs require is at
  // least one NON-DEFERRED tool, and each adapter prepends its search tool
  // (tool_search / bm25) outside this partition — so an empty application core
  // is legal and must not take chat and report down.
  const catalog = [tool('submittal_register')];
  const { core, deferred } = splitCoreAndDeferred(catalog, ['list_projects']);
  assert.deepEqual(core, []);
  assert.deepEqual(
    deferred.map((t) => t.name),
    ['submittal_register']
  );
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

test('CHAT_CORE_TOOLS carries every discovery tool the chat SYSTEM_PROMPT tells the model to call first', () => {
  // Live text: "...discover them first with list_projects, list_sections, or
  // search_library, then call the specific tool." If a prompt edit drops or
  // renames one of these without updating CHAT_CORE_TOOLS, this fails.
  const discovery = discoveryToolsIn(
    SYSTEM_PROMPT,
    /discover them first with ([a-z0-9_, ]+?), then call/i
  );
  assert.ok(discovery.length > 0);
  for (const name of discovery) {
    assert.ok(
      CHAT_CORE_TOOLS.includes(name),
      `CHAT_CORE_TOOLS is missing prompt-named discovery tool "${name}"`
    );
  }
});

test("CHAT_CORE_TOOLS includes get_references because index.html's greeting names a cross-reference example", () => {
  // The tie is: the chat greeting advertises "which sections cite 09 22 00?"
  // as an example question (index.html), so get_references — the tool that
  // answers it — must be preloaded rather than left to discovery. If the
  // greeting's cross-reference example is ever removed without also removing
  // get_references from CHAT_CORE_TOOLS, this test still documents the
  // coupling; if get_references itself is dropped while the example stays,
  // it fails.
  const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(
    indexHtml,
    /which sections cite/i,
    'expected index.html to still advertise a cross-reference example question'
  );
  assert.ok(CHAT_CORE_TOOLS.includes('get_references'));
});

test('REPORT_CORE_TOOLS exactly matches the discovery tools REPORT_SYSTEM_PROMPT names first', () => {
  // Live text: "Workflow: discover ids first with list_projects, list_sections,
  // or search_library,". Extracted straight from the prompt string the model
  // actually reads, not a hand-copied duplicate of REPORT_CORE_TOOLS — a
  // prompt edit that changes this tool list without updating the constant
  // (or vice versa) fails here.
  const discovery = discoveryToolsIn(
    REPORT_SYSTEM_PROMPT,
    /discover ids first with ([a-z0-9_, ]+?),\s*$/im
  );
  assert.deepEqual(discovery, REPORT_CORE_TOOLS);
});
