// Unit tests for the demo server's proxy-target builder (http-utils.mjs).
// Run: node --test examples/web_ui_demo/http-utils.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamUrl } from './http-utils.mjs';

const API_BASE = 'http://127.0.0.1:3000';

test('upstreamUrl copies the request path and query onto the configured API base', () => {
  const target = upstreamUrl(API_BASE, '/specs/abc', '?page=2&limit=10');
  assert.equal(target.href, 'http://127.0.0.1:3000/specs/abc?page=2&limit=10');
});

test('upstreamUrl with no query yields a bare path', () => {
  assert.equal(upstreamUrl(API_BASE, '/health').href, 'http://127.0.0.1:3000/health');
});

test('SSRF regression: a path beginning with // can never retarget the upstream host', () => {
  // `/specs/..//evil.example/x` normalises to a pathname of `//evil.example/x`;
  // `new URL(thatPath, API_BASE)` would have resolved to http://evil.example/x.
  const hostile = new URL('/specs/..//evil.example/x', 'http://127.0.0.1:3001').pathname;
  assert.equal(hostile, '//evil.example/x', 'precondition: the parser yields a //-prefixed path');
  const target = upstreamUrl(API_BASE, hostile, '');
  assert.equal(target.host, '127.0.0.1:3000');
  assert.equal(target.protocol, 'http:');
  assert.equal(target.pathname, '//evil.example/x');
});

test('SSRF regression: backslash and scheme-looking paths stay on the API base', () => {
  for (const pathname of ['/\\evil.example/x', '/https://evil.example/x', '/@evil.example/x']) {
    const target = upstreamUrl(API_BASE, pathname, '');
    assert.equal(target.host, '127.0.0.1:3000', `host must not change for ${pathname}`);
  }
});

test('upstreamUrl honours the API base scheme and port and carries no fragment', () => {
  const target = upstreamUrl('https://specr.internal:8443', '/mcp', '?x=1');
  assert.equal(target.href, 'https://specr.internal:8443/mcp?x=1');
  assert.equal(target.hash, '');
});
