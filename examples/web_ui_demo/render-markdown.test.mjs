// Unit tests for the shared markdown renderer used by the demo's two LLM-output
// surfaces (Ask-SpecR chat, Compose report). Run with:
//   node --test examples/web_ui_demo/render-markdown.test.mjs
// These do NOT run in CI (examples/ is outside the vitest projects) — they are the
// demo's own regression net proving (a) real LLM markdown renders correctly and
// (b) prompt-injected markdown renders inert. LLM output is UNTRUSTED input.
//
// The sanitization policy lives entirely in createMarkdownRenderer, so exercising
// its string->string output IS testing the security posture. markdown-it is imported
// straight from node_modules here (no DOM), mirroring how the browser wires the same
// factory to window.markdownit (served from /vendor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import {
  createMarkdownRenderer,
  renderMarkdown,
  renderMarkdownInto,
} from './js/render-markdown.mjs';

const md = createMarkdownRenderer(MarkdownIt);

// A genuine, rendered <a>/<img>/<script> element (as opposed to an escaped one,
// which begins with &lt;) — the presence of any of these from a hostile payload
// is a policy failure.
const ACTIVE_ANCHOR = /<a[\s>]/i;
const ACTIVE_IMG = /<img[\s/>]/i;
const ACTIVE_SCRIPT = /<script[\s/>]/i;
const DANGEROUS_HREF = /href\s*=\s*["'][^"']*(?:javascript|vbscript|data|file):/i;

// ── Formatting: real LLM markdown must render to the right HTML ──────────────

test('formatting: ATX headings render as <h1>', () => {
  assert.match(md.render('# Title'), /<h1>Title<\/h1>/);
});

test('formatting: bold and italic emphasis', () => {
  const html = md.render('**bold** and _italic_');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
});

test('formatting: nested unordered lists nest a second <ul>', () => {
  const html = md.render('- a\n    - b\n    - c');
  assert.match(html, /<ul>/);
  assert.match(html, /<li>a/);
  assert.match(html, /<li>b<\/li>/);
  // A nested list means at least two <ul> opens.
  assert.ok((html.match(/<ul>/g) || []).length >= 2, 'expected a nested <ul>');
});

test('formatting: ordered lists render as <ol>', () => {
  const html = md.render('1. one\n2. two');
  assert.match(html, /<ol>/);
  assert.match(html, /<li>one<\/li>/);
});

test('formatting: fenced code blocks render escaped monospace', () => {
  const html = md.render('```\nconst x = 1 < 2;\n```');
  assert.match(html, /<pre><code>/);
  // The `<` inside code is escaped, never a live tag.
  assert.match(html, /const x = 1 &lt; 2;/);
});

test('formatting: inline code renders as <code>', () => {
  assert.match(md.render('run `npm test` now'), /<code>npm test<\/code>/);
});

test('formatting: GFM tables render as <table>', () => {
  const html = md.render('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test('formatting: blockquotes render as <blockquote>', () => {
  assert.match(md.render('> quoted'), /<blockquote>/);
});

test('formatting: a safe link gets forced target + rel attributes', () => {
  const html = md.render('[SpecR](https://specr.example/docs)');
  assert.match(html, /<a\s/);
  assert.match(html, /href="https:\/\/specr\.example\/docs"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

// ── Adversarial: prompt-injected markdown must render inert ──────────────────

test('adversarial: a <script> tag is escaped, never executed', () => {
  const html = md.render('<script>alert(1)</script>');
  assert.doesNotMatch(html, ACTIVE_SCRIPT);
  assert.ok(html.includes('&lt;script&gt;'), 'raw HTML must be escaped, not stripped');
});

test('adversarial: a raw <img onerror> is escaped, not rendered', () => {
  const html = md.render('Hello <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, ACTIVE_IMG);
  assert.ok(html.includes('&lt;img'), 'raw HTML must be escaped, not stripped');
});

test('adversarial: a markdown image collapses to alt text — no <img>, no URL', () => {
  const html = md.render('![companylogo](https://evil.example/track.png)');
  assert.doesNotMatch(html, ACTIVE_IMG);
  assert.ok(!html.includes('evil.example'), 'the image URL must never reach the DOM');
  assert.ok(html.includes('companylogo'), 'the alt text survives as inert text');
});

test('adversarial: a javascript: markdown image yields no <img> and no link', () => {
  const html = md.render('![x](javascript:alert(1))');
  assert.doesNotMatch(html, ACTIVE_IMG);
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
});

test('adversarial: a javascript: link is dropped (no anchor)', () => {
  const html = md.render('[click](javascript:alert(1))');
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
  assert.doesNotMatch(html, DANGEROUS_HREF);
  assert.ok(html.includes('click'), 'the link text survives as inert text');
});

test('adversarial: a control-char-obfuscated javascript: scheme is dropped', () => {
  const html = md.render('[click](java\tscript:alert(1))');
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
  assert.doesNotMatch(html, DANGEROUS_HREF);
});

test('adversarial: a data: link is dropped', () => {
  const html = md.render('[d](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
  assert.doesNotMatch(html, DANGEROUS_HREF);
});

test('adversarial: a reference-link definition to javascript: is inert', () => {
  const html = md.render('[ref]: javascript:alert(1)\n\nsee [ref]');
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
  assert.doesNotMatch(html, DANGEROUS_HREF);
});

test('adversarial: a raw <a href="javascript:"> is escaped, not a live anchor', () => {
  const html = md.render('<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
  assert.ok(html.includes('&lt;a'), 'raw HTML must be escaped, not stripped');
});

test('adversarial: no dangerous scheme survives in any href across a mixed payload', () => {
  const html = md.render(
    ['[a](javascript:alert(1))', '[b](vbscript:foo)', '[c](file:///etc/passwd)', '[d](data:x)'].join(
      '\n\n'
    )
  );
  assert.doesNotMatch(html, DANGEROUS_HREF);
  assert.doesNotMatch(html, ACTIVE_ANCHOR);
});

test('render() coerces non-string input to an empty string', () => {
  assert.equal(md.render(null), '');
  assert.equal(md.render(undefined), '');
  assert.equal(md.render(42), '');
});

// ── Module-level helpers: the browser-facing wrappers stay inert ─────────────

test('renderMarkdown falls back to escaped text when no renderer is bound', () => {
  // In Node there is no window.markdownit, so renderMarkdown must degrade to an
  // HTML-escaped (still inert) string rather than passing markup through.
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(html, ACTIVE_SCRIPT);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdownInto routes through the sanitizer before touching innerHTML', () => {
  const stub = {};
  renderMarkdownInto(stub, '<b>x</b>');
  assert.equal(typeof stub.innerHTML, 'string');
  assert.doesNotMatch(stub.innerHTML, /<b>/i);
  assert.ok(stub.innerHTML.includes('&lt;b&gt;'));
});
