// Wiring smoke tests for the harness's Express app (#150, task 6/8):
// createApp() mounts the run + file routers under /api/runs, serves the
// docx-preview/jszip UMD bundles this package depends on directly out of
// its own node_modules (paths confirmed reachable by the WT-150 spike), and
// never lets an unmatched route or a thrown error escape as anything but a
// JSON body — no stack trace, no Express default HTML error page.

import { type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api-client/client.js';
import { createRunStore, type RunStore } from '../run/run-store.js';
import { createPipeline } from '../run/pipeline.js';
import { createHeaderFooterFixturePipeline } from '../run/header-footer-pipeline.js';
import { createApp } from './app.js';

describe('createApp (wiring smoke tests)', () => {
  let workRoot: string;
  let runStore: RunStore;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-app-'));
    runStore = createRunStore(workRoot);
    const apiClient = createApiClient({ baseUrl: 'http://localhost:3000' });
    const pipeline = createPipeline({ apiClient, runStore });
    const headerFooterFixturePipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });
    app = createApp({ pipeline, runStore, headerFooterFixturePipeline });

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind to a port');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('mounts the runs router under /api/runs', async () => {
    const response = await fetch(`${baseUrl}/api/runs/does-not-exist`);
    expect(response.status).toBe(404);
  });

  it('mounts the files router under the same /api/runs prefix', async () => {
    runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

    const response = await fetch(`${baseUrl}/api/runs/run-1/files/not-a-real-file.png`);
    expect(response.status).toBe(404);
  });

  it('mounts the header/footer fixtures router under /api/header-footer-fixtures (#305)', async () => {
    const response = await fetch(`${baseUrl}/api/header-footer-fixtures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'default' }),
    });
    const body = (await response.json()) as { success: boolean; data: { runId: string } };

    expect(response.status).toBe(202);
    expect(body.success).toBe(true);
    expect(typeof body.data.runId).toBe('string');
  });

  it('serves the docx-preview UMD bundle from its own node_modules', async () => {
    const response = await fetch(`${baseUrl}/vendor/docx-preview.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('docx-preview');
  });

  it('serves the jszip UMD bundle from its own node_modules', async () => {
    const response = await fetch(`${baseUrl}/vendor/jszip.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('JSZip');
  });

  it('serves the harness page at GET / with the pane/sidebar/report automation hooks (task 7/8)', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const body = await response.text();
    expect(body).toContain('data-testid="pane-reference"');
    expect(body).toContain('data-testid="pane-roundtrip"');
    expect(body).toContain('data-testid="pane-diff"');
    expect(body).toContain('data-testid="properties-sidebar"');
    expect(body).toContain('data-testid="derivation-report"');
    expect(body).toContain('/harness.js');
    // #506: an inline data: favicon <link> is sufficient on its own to
    // suppress Chromium's implicit /favicon.ico probe — no new route or
    // static asset needed (WT-506 spike finding 5). Pin the actual
    // invariant (a SELF-CONTAINED data: URI, not merely the presence of a
    // rel="icon" attribute anywhere in the page) — a bare substring check
    // would pass even if this regressed to a relative/external href that
    // required a server route or file. Lazy-captures up to the first `">`
    // rather than the first bare `>`, because the SVG data URI itself
    // contains unescaped `>` characters (its own tag closes) — a naive
    // `[^>]*` boundary would truncate mid-URI and never reach it.
    const iconHref = /rel="icon"\s+href="([\s\S]*?)">/.exec(body)?.[1];
    expect(iconHref).toMatch(/^data:/);
    // #506: scale-factor disagreement between the reference/round-trip
    // panes must be surfaced only through this DOM node, never through
    // console output — the driving agent reads DOM state, not console logs.
    expect(body).toContain('data-testid="fit-scale-note"');
  });

  it('serves harness.js exposing the render/measure hooks with no in-page screenshot capture', async () => {
    const response = await fetch(`${baseUrl}/harness.js`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('window.__loadPane');
    expect(body).toContain('window.__measure');
    expect(body).toContain('window.__regionGeom');
    // Confirmed non-viable by the WT-150 spike (blank/gray canvas output in
    // Chromium) — never shipped as a working default (design decision 2).
    // The real capture path is external Playwright -> POST
    // /api/runs/:runId/screenshot, exercised by routes/runs.ts already.
    expect(body).not.toContain('window.__captureScreenshot');
    // Decision 7 (flow-mode rendering) is a locked render option on both
    // panes now, not a query-string toggle like the spike's ignoreLRPB param.
    expect(body).toContain('ignoreLastRenderedPageBreak: true');
  });

  it('serves pane-scale.js exposing the display-mode hooks harness.js was split from (#506)', async () => {
    // harness.js had grown past this package's own 400-line file cap
    // (CLAUDE.md's project override) — the display-mode/scale-wrapper
    // concern (getScaleOuter/getScaleTarget/createScaleTarget/
    // rescaleAllPanes) was extracted into its own served file, same as
    // scenario-picker.js was split out earlier. index.html must load this
    // BEFORE harness.js's own <script> tag.
    const response = await fetch(`${baseUrl}/pane-scale.js`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('window.__setDisplayMode');
    expect(body).toContain('window.__getDisplayMode');
    expect(body).toContain('window.__createScaleTarget');
    expect(body).toContain('window.__rescaleAllPanes');
  });

  it('loads pane-scale.js before harness.js in index.html, matching the cross-file dependency direction', async () => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    const paneScaleIndex = body.indexOf('/pane-scale.js');
    const harnessIndex = body.indexOf('/harness.js');
    expect(paneScaleIndex).toBeGreaterThan(-1);
    expect(harnessIndex).toBeGreaterThan(-1);
    expect(paneScaleIndex).toBeLessThan(harnessIndex);
  });

  describe('harness.js display mode (#506)', () => {
    // Runs the REAL served harness.js in an isolated vm context so these
    // pin genuine runtime behavior, not just substring checks against the
    // source text. The document/window stubs below are real enough to
    // survive rescaleAllPanes()'s DOM reads/writes (task 3/9 wires it into
    // __setDisplayMode and a resize listener) without modeling actual CSS
    // layout — geometry is supplied as test fixtures, not computed.
    interface Rect {
      x: number;
      y: number;
      width: number;
      height: number;
    }

    interface FakeElement {
      tagName: string;
      className: string;
      style: Record<string, string>;
      clientWidth: number;
      value: string;
      textContent: string;
      readonly children: FakeElement[];
      appendChild(child: FakeElement): FakeElement;
      querySelector(selector: string): FakeElement | null;
      querySelectorAll(selector: string): FakeElement[];
      getBoundingClientRect(): Rect;
      addEventListener(type: string, handler: () => void): void;
      dispatchEvent(type: string): void;
    }

    interface FakeDocumentStub {
      getElementById(id: string): FakeElement | null;
      createElement(tagName: string): FakeElement;
      registerId(id: string, element: FakeElement): FakeElement;
    }

    interface FakeWindowStub {
      location: { search: string };
      addEventListener(type: string, handler: () => void): void;
      dispatchEvent(type: string): void;
      [key: string]: unknown;
    }

    function findByClassName(nodes: FakeElement[], className: string): FakeElement | null {
      for (const node of nodes) {
        if (node.className === className) return node;
        const found = findByClassName(node.children, className);
        if (found) return found;
      }
      return null;
    }

    // measurePage (untouched by #506 — see harness.js) issues bare tag
    // selectors ('header'/'footer'), so querySelector needs this alongside
    // its existing class-selector support.
    function findByTagName(nodes: FakeElement[], tagName: string): FakeElement | null {
      for (const node of nodes) {
        if (node.tagName === tagName) return node;
        const found = findByTagName(node.children, tagName);
        if (found) return found;
      }
      return null;
    }

    // Purpose-built for the ONE compound selector window.__measure actually
    // issues ('.docx-wrapper > section.docx') — mirrors querySelector's own
    // narrow, unsupported-selector-throws philosophy rather than growing a
    // general CSS engine this fake doesn't need.
    function findDocxPages(nodes: FakeElement[]): FakeElement[] {
      const wrapper = findByClassName(nodes, 'docx-wrapper');
      if (!wrapper) return [];
      return wrapper.children.filter(
        (child) => child.tagName === 'section' && child.className === 'docx'
      );
    }

    // Shared by both FakeElement (click/submit listeners — #506 task 6/9's
    // scenario-picker.js test needs a real dispatchable 'click') and
    // FakeWindowStub (the 'resize' listener task 3/9 already exercised) —
    // identical add/dispatch semantics, so this is the one place either
    // fake's listener bookkeeping lives.
    function createListenerRegistry(): {
      add: (type: string, handler: () => void) => void;
      dispatch: (type: string) => void;
    } {
      const listeners = new Map<string, Array<() => void>>();
      return {
        add(type, handler) {
          listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        },
        dispatch(type) {
          (listeners.get(type) ?? []).forEach((handler) => {
            handler();
          });
        },
      };
    }

    function createFakeElement(rect: Rect = { x: 0, y: 0, width: 0, height: 0 }): FakeElement {
      let text = '';
      let kids: FakeElement[] = [];
      const registry = createListenerRegistry();
      return {
        tagName: 'div',
        className: '',
        style: {},
        clientWidth: 0,
        value: '',
        get textContent(): string {
          return text;
        },
        // Mirrors real DOM semantics: assigning textContent replaces ALL
        // children — this is what makes createScaleTarget's clearChildren
        // call actually clear a previous render's wrapper, not just add to it.
        set textContent(value: string) {
          text = value;
          kids = [];
        },
        get children(): FakeElement[] {
          return kids;
        },
        appendChild(child: FakeElement): FakeElement {
          kids = [...kids, child];
          return child;
        },
        querySelector(selector: string): FakeElement | null {
          if (selector.startsWith('.')) {
            return findByClassName(kids, selector.slice(1));
          }
          if (/^[a-z]+$/.test(selector)) {
            return findByTagName(kids, selector);
          }
          throw new Error(`FakeElement.querySelector: unsupported selector "${selector}"`);
        },
        querySelectorAll(selector: string): FakeElement[] {
          if (selector !== '.docx-wrapper > section.docx') {
            throw new Error(`FakeElement.querySelectorAll: unsupported selector "${selector}"`);
          }
          return findDocxPages(kids);
        },
        getBoundingClientRect(): Rect {
          return { ...rect };
        },
        addEventListener: registry.add,
        dispatchEvent: registry.dispatch,
      };
    }

    function createFakeDocument(): FakeDocumentStub {
      const idMap = new Map<string, FakeElement>();
      return {
        getElementById(id: string): FakeElement | null {
          return idMap.get(id) ?? null;
        },
        createElement(tagName: string): FakeElement {
          const node = createFakeElement();
          node.tagName = tagName;
          return node;
        },
        registerId(id: string, element: FakeElement): FakeElement {
          idMap.set(id, element);
          return element;
        },
      };
    }

    function createFakeWindow(search: string): FakeWindowStub {
      const registry = createListenerRegistry();
      return {
        location: { search },
        addEventListener: registry.add,
        dispatchEvent: registry.dispatch,
      };
    }

    // The ids harness.js's top-level eval and display-mode code paths touch
    // — 'run-form' for the submit-listener wiring every load runs, the two
    // pane-content divs, the fit-scale diagnostic node, and (#506 task 6/9)
    // the run-status/properties-body/derivation-body/pane-diff-content ids
    // window.__pollRun's tick() writes into on every poll.
    function createDefaultHarnessDocument(): FakeDocumentStub {
      const document = createFakeDocument();
      document.registerId('run-form', createFakeElement());
      document.registerId('pane-reference-content', createFakeElement());
      document.registerId('pane-roundtrip-content', createFakeElement());
      document.registerId('fit-scale-note', createFakeElement());
      document.registerId('run-status', createFakeElement());
      document.registerId('properties-body', createFakeElement());
      document.registerId('derivation-body', createFakeElement());
      document.registerId('pane-diff-content', createFakeElement());
      return document;
    }

    function assertIsFunction(
      value: unknown,
      name: string
    ): asserts value is (...args: unknown[]) => unknown {
      if (typeof value !== 'function') {
        throw new Error(`harness.js sandbox: window.${name} is not a function`);
      }
    }

    // window.__pollRun's tick() chains several fetch().then().then() hops
    // (pollOnce's own two, plus tick()'s own .then callback, plus whatever
    // tryAutoLoadPane/loadDiffPane fire off inside it) before it finishes
    // writing to the DOM for one poll — this drains the FULL microtask
    // queue (including microtasks a microtask schedules) so a test can
    // await exactly once rather than guessing a fixed number of
    // `Promise.resolve()` hops. Safe without a sandboxed `setTimeout`: these
    // tests only ever poll a TERMINAL record, so tick()'s reschedule branch
    // (the only place it calls the real setTimeout) is never reached.
    async function flushAsync(): Promise<void> {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    // sonarjs flags vm.runInContext as dynamic code execution — safe here:
    // `source` is always this package's OWN just-served static file (fetched
    // from the app instance this test spun up), not attacker-controlled
    // input, and it runs inside a purpose-built sandbox with no
    // filesystem/network access exposed to it.
    async function evalServedScript(path: string, sandbox: object): Promise<void> {
      const response = await fetch(`${baseUrl}${path}`);
      const source = await response.text();
      // eslint-disable-next-line sonarjs/code-eval
      vm.runInContext(source, sandbox);
    }

    async function loadHarnessSandbox(
      search: string,
      // Extra sandbox globals (e.g. `fetch`/`docx` stubs for task 4/9's
      // __loadPane tests) — harness.js references both as bare identifiers,
      // never window.fetch/window.docx, so they must live directly on the
      // vm context object, not on the windowStub.
      sandboxGlobals: Record<string, unknown> = {}
    ): Promise<{ window: FakeWindowStub; document: FakeDocumentStub }> {
      const windowStub = createFakeWindow(search);
      const documentStub = createDefaultHarnessDocument();
      const sandbox = {
        window: windowStub,
        document: documentStub,
        URLSearchParams,
        ...sandboxGlobals,
      };
      vm.createContext(sandbox);
      // Mirrors index.html's own <script> tag order (#506): pane-scale.js
      // defines window.__setDisplayMode/__createScaleTarget/__rescaleAllPanes
      // — harness.js's own top-level eval and several of its functions
      // (ensureCaptureMode, __loadPane) reference those, so it must run
      // second, against this same sandbox, exactly as it does in the browser.
      await evalServedScript('/pane-scale.js', sandbox);
      await evalServedScript('/harness.js', sandbox);
      return { window: windowStub, document: documentStub };
    }

    // Shared by both the task 3/9 (scale-wrapper DOM management) and task
    // 4/9 (__loadPane wiring) sub-describes below — hoisted here rather than
    // duplicated per-describe.
    const PANE_CONTENT_IDS = {
      reference: 'pane-reference-content',
      roundtrip: 'pane-roundtrip-content',
    } as const;

    function configurePaneContent(
      document: FakeDocumentStub,
      paneContentId: string,
      clientWidth: number
    ): FakeElement {
      const container = document.getElementById(paneContentId);
      if (!container) throw new Error(`test setup: ${paneContentId} not registered`);
      container.clientWidth = clientWidth;
      return container;
    }

    function attachScalePair(
      container: FakeElement,
      targetRect: Rect
    ): { outer: FakeElement; target: FakeElement } {
      const outer = createFakeElement();
      outer.className = 'pane-scale-outer';
      const target = createFakeElement(targetRect);
      target.className = 'pane-scale-target';
      outer.appendChild(target);
      container.appendChild(outer);
      return { outer, target };
    }

    // Shared by the task 5/9 (__measure capture-mode guarantee) sub-describe
    // below — builds the '.docx-wrapper > section.docx' shape docx-preview
    // actually leaves behind inside a render target (docx.renderAsync's
    // `inWrapper: true` option), one section per page rect.
    function attachRenderedPages(target: FakeElement, pageRects: Rect[]): FakeElement[] {
      const wrapper = createFakeElement();
      wrapper.className = 'docx-wrapper';
      const sections = pageRects.map((rect) => {
        const section = createFakeElement(rect);
        section.tagName = 'section';
        section.className = 'docx';
        wrapper.appendChild(section);
        return section;
      });
      target.appendChild(wrapper);
      return sections;
    }

    it('defaults to fit mode with no query string', async () => {
      const { window: harnessWindow } = await loadHarnessSandbox('');
      const getDisplayMode = harnessWindow.__getDisplayMode;
      assertIsFunction(getDisplayMode, '__getDisplayMode');

      expect(getDisplayMode()).toBe('fit');
    });

    it('resolves capture mode only for an exact ?mode=capture query param, never throwing on garbage', async () => {
      const capture = (await loadHarnessSandbox('?mode=capture')).window.__getDisplayMode;
      const bogus = (await loadHarnessSandbox('?mode=bogus')).window.__getDisplayMode;
      const wrongCase = (await loadHarnessSandbox('?mode=CAPTURE')).window.__getDisplayMode;
      assertIsFunction(capture, '__getDisplayMode');
      assertIsFunction(bogus, '__getDisplayMode');
      assertIsFunction(wrongCase, '__getDisplayMode');

      expect(capture()).toBe('capture');
      expect(bogus()).toBe('fit');
      expect(wrongCase()).toBe('fit');
    });

    it('__setDisplayMode is a single global switch, not a per-pane setter', async () => {
      const { window: harnessWindow } = await loadHarnessSandbox('');
      const setDisplayMode = harnessWindow.__setDisplayMode;
      const getDisplayMode = harnessWindow.__getDisplayMode;
      assertIsFunction(setDisplayMode, '__setDisplayMode');
      assertIsFunction(getDisplayMode, '__getDisplayMode');

      // Arity pins the boundary shape: mode only, no `pane` argument — the
      // #506 design commits both panes to move together (spike finding 2).
      expect(setDisplayMode).toHaveLength(1);
      expect(getDisplayMode).toHaveLength(0);

      setDisplayMode('capture');
      expect(getDisplayMode()).toBe('capture');
      setDisplayMode('fit');
      expect(getDisplayMode()).toBe('fit');
    });

    it('__setDisplayMode throws on anything but exactly "fit"/"capture", leaving state untouched', async () => {
      const { window: harnessWindow } = await loadHarnessSandbox('');
      const setDisplayMode = harnessWindow.__setDisplayMode;
      const getDisplayMode = harnessWindow.__getDisplayMode;
      assertIsFunction(setDisplayMode, '__setDisplayMode');
      assertIsFunction(getDisplayMode, '__getDisplayMode');

      expect(() => setDisplayMode('bogus')).toThrow(/fit.*capture/);
      expect(() => setDisplayMode('')).toThrow();
      expect(() => setDisplayMode(undefined)).toThrow();
      expect(getDisplayMode()).toBe('fit');
    });

    describe('scale-wrapper DOM management and fit-mode scaling math (#506 task 3/9)', () => {
      // A single element can't simultaneously be docx-preview's render
      // target, the CSS transform target, AND the sizing box the
      // pane-content ancestor's overflow:auto measures against (#506 spike
      // finding 1) — so every pane gets a NESTED .pane-scale-outer >
      // .pane-scale-target pair. These tests pin the DOM-management and
      // scaling-math invariants that pair depends on; real pixel geometry
      // is the orchestrator's Playwright job, not this vitest suite's.
      // PANE_CONTENT_IDS/configurePaneContent/attachScalePair are hoisted to
      // this describe's parent scope (shared with the task 4/9 sub-describe
      // below).

      it('capture mode resets both scale elements to a blank state regardless of prior state (geometry invariance)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const referenceContainer = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { outer: dirtyOuter, target: dirtyTarget } = attachScalePair(referenceContainer, {
          x: 0,
          y: 0,
          width: 1600,
          height: 2000,
        });
        // Leftover state from a previous fit-mode computation — capture
        // mode must reset this away, not merely skip applying a new one.
        dirtyOuter.style.width = '999px';
        dirtyOuter.style.height = '111px';
        dirtyTarget.style.width = 'max-content';
        dirtyTarget.style.transform = 'scale(3.75)';
        dirtyTarget.style.transformOrigin = 'top left';

        const roundtripContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);
        const { outer: cleanOuter, target: cleanTarget } = attachScalePair(roundtripContainer, {
          x: 0,
          y: 0,
          width: 1600,
          height: 2000,
        });

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('capture');

        for (const outer of [dirtyOuter, cleanOuter]) {
          expect(outer.style.width).toBe('');
          expect(outer.style.height).toBe('');
        }
        for (const target of [dirtyTarget, cleanTarget]) {
          expect(target.style.width).toBe('');
          expect(target.style.transform).toBe('');
          expect(target.style.transformOrigin).toBe('');
        }
      });

      it('fit mode sizes the outer wrapper to exactly the scaled natural size, eliminating stray scroll space (no-overflow)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const container = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { outer, target } = attachScalePair(container, {
          x: 0,
          y: 0,
          width: 1600,
          height: 2000,
        });
        configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('fit');

        expect(target.style.width).toBe('max-content');
        expect(target.style.transform).toBe('scale(0.5)');
        expect(target.style.transformOrigin).toBe('top left');
        // The outer wrapper is the box the pane-content ancestor's
        // overflow:auto measures against — sizing it to exactly the scaled
        // natural dimensions (not the untransformed natural size) is what
        // eliminates the stray scroll space the #506 spike found with a
        // single transformed element.
        expect(outer.style.width).toBe('800px');
        expect(outer.style.height).toBe('1000px');
      });

      it('clamps the fit-mode scale factor to at most 1, never upscaling a page narrower than its pane column (#506)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        // clientWidth (1600) wider than the page's natural width (800) is
        // exactly the scenario the tool's own recommended workflow reaches:
        // pinning the documented 3200px capture viewport while still in
        // default fit mode (README step 2) yields a pane column noticeably
        // wider than a Letter/A4 page. A raw (unclamped) ratio would upscale
        // — contradicting index.html's/README's documented "scales panes
        // down" contract.
        const container = configurePaneContent(document, PANE_CONTENT_IDS.reference, 1600);
        const { outer, target } = attachScalePair(container, {
          x: 0,
          y: 0,
          width: 800,
          height: 1000,
        });
        configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 1600);

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('fit');

        expect(target.style.transform).toBe('scale(1)');
        // The outer wrapper is sized off the CLAMPED factor too — an
        // unclamped 2x factor would size it 1600x2000, defeating the point
        // of the clamp (the outer box exists to bound the pane to its
        // column, see the no-overflow test above).
        expect(outer.style.width).toBe('800px');
        expect(outer.style.height).toBe('1000px');
      });

      it('always resets before recomputing, so a later fit pass never compounds onto a stale transform (reset-first ordering)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const container = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { outer, target } = attachScalePair(container, {
          x: 0,
          y: 0,
          width: 1600,
          height: 2000,
        });
        configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');

        setDisplayMode('fit');
        expect(target.style.transform).toBe('scale(0.5)');

        // A viewport resize narrows the pane-content ancestor; re-applying
        // fit mode is idempotent (still re-scales even when the mode itself
        // doesn't change — see __setDisplayMode's own contract).
        container.clientWidth = 400;
        setDisplayMode('fit');

        // A compounded (not reset-first) implementation would layer
        // scale(0.25) on top of the still-present scale(0.5), or leave the
        // stale 800px outer width behind. This must read as an independent,
        // correct recomputation from the current clientWidth alone.
        expect(target.style.transform).toBe('scale(0.25)');
        expect(outer.style.width).toBe('400px');
        expect(outer.style.height).toBe('500px');
      });

      // createScaleTarget's own "replaces, never accumulates the outer/target
      // pair on repeat calls" invariant is pinned below, through the real
      // public window.__loadPane entry point (see "renders each load into a
      // fresh outer/target pair without accumulating wrappers" in the
      // window.__loadPane wiring describe below) — createScaleTarget has a
      // real caller now (__loadPane), so there is no need for a second copy
      // of this test reaching through an internal-only escape hatch.

      it('wires rescaleAllPanes to a window resize listener', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const container = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { target } = attachScalePair(container, { x: 0, y: 0, width: 1600, height: 2000 });
        configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);

        // Fit is the default mode, but nothing applies it to the DOM until
        // something drives rescaleAllPanes — confirm the pane starts inert
        // (never touched, not merely reset to '').
        expect(target.style.transform).toBeUndefined();

        harnessWindow.dispatchEvent('resize');

        expect(target.style.transform).toBe('scale(0.5)');
      });

      it('flags a scale-factor mismatch between panes via #fit-scale-note, and stays clear when factors match', async () => {
        const mismatched = await loadHarnessSandbox('');
        const refContainer = configurePaneContent(
          mismatched.document,
          PANE_CONTENT_IDS.reference,
          800
        );
        attachScalePair(refContainer, { x: 0, y: 0, width: 1600, height: 2000 }); // factor 0.5
        const rtContainer = configurePaneContent(
          mismatched.document,
          PANE_CONTENT_IDS.roundtrip,
          800
        );
        attachScalePair(rtContainer, { x: 0, y: 0, width: 800, height: 1000 }); // factor 1.0
        const setMismatched = mismatched.window.__setDisplayMode;
        assertIsFunction(setMismatched, '__setDisplayMode');
        setMismatched('fit');
        const mismatchedNote = mismatched.document.getElementById('fit-scale-note');
        if (!mismatchedNote) throw new Error('test setup: fit-scale-note not registered');
        expect(mismatchedNote.textContent).not.toBe('');

        const matched = await loadHarnessSandbox('');
        const refContainer2 = configurePaneContent(
          matched.document,
          PANE_CONTENT_IDS.reference,
          800
        );
        attachScalePair(refContainer2, { x: 0, y: 0, width: 1600, height: 2000 }); // factor 0.5
        const rtContainer2 = configurePaneContent(
          matched.document,
          PANE_CONTENT_IDS.roundtrip,
          800
        );
        attachScalePair(rtContainer2, { x: 0, y: 0, width: 1600, height: 2000 }); // factor 0.5
        const setMatched = matched.window.__setDisplayMode;
        assertIsFunction(setMatched, '__setDisplayMode');
        setMatched('fit');
        const matchedNote = matched.document.getElementById('fit-scale-note');
        if (!matchedNote) throw new Error('test setup: fit-scale-note not registered');
        expect(matchedNote.textContent).toBe('');
      });

      // SCALE_MISMATCH_EPSILON (0.01) is documented as "loose enough to
      // absorb sub-pixel rounding... tight enough to still flag a genuine
      // mismatch" — the test above only exercises a gross mismatch (0.5 vs
      // 1.0) and an exact match (0.5 vs 0.5), neither of which would catch
      // a regression to the wrong threshold value or comparison operator
      // (e.g. `>=` instead of `>`, or 0.1 instead of 0.01). These two pin
      // the actual boundary the epsilon draws.
      it('does not flag a scale-factor difference just UNDER the mismatch epsilon (#506 boundary)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const refContainer = configurePaneContent(document, PANE_CONTENT_IDS.reference, 10000);
        attachScalePair(refContainer, { x: 0, y: 0, width: 20000, height: 1000 }); // factor 0.5000
        const rtContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 10198);
        attachScalePair(rtContainer, { x: 0, y: 0, width: 20000, height: 1000 }); // factor 0.5099 — diff 0.0099

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('fit');

        const note = document.getElementById('fit-scale-note');
        if (!note) throw new Error('test setup: fit-scale-note not registered');
        expect(note.textContent).toBe('');
      });

      it('flags a scale-factor difference just OVER the mismatch epsilon (#506 boundary)', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const refContainer = configurePaneContent(document, PANE_CONTENT_IDS.reference, 10000);
        attachScalePair(refContainer, { x: 0, y: 0, width: 20000, height: 1000 }); // factor 0.5000
        const rtContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 10202);
        attachScalePair(rtContainer, { x: 0, y: 0, width: 20000, height: 1000 }); // factor 0.5101 — diff 0.0101

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('fit');

        const note = document.getElementById('fit-scale-note');
        if (!note) throw new Error('test setup: fit-scale-note not registered');
        expect(note.textContent).not.toBe('');
      });

      it('surfaces a scale-factor mismatch only via #fit-scale-note, never via console output (#506)', async () => {
        // README's "Display mode: fit vs capture" section states this
        // explicitly: "a DOM node, never console.*, because the driving
        // agent reads DOM state, not console logs." Supplying a spy console
        // as a sandbox global (harness.js has none of its own — a bare
        // `console` reference would otherwise throw ReferenceError in this
        // vm context) makes that invariant observable instead of merely
        // implicit in the sandbox's missing global.
        const consoleLog = vi.fn();
        const consoleWarn = vi.fn();
        const consoleError = vi.fn();
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          console: { log: consoleLog, warn: consoleWarn, error: consoleError },
        });
        const refContainer = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        attachScalePair(refContainer, { x: 0, y: 0, width: 1600, height: 2000 }); // factor 0.5
        const rtContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);
        attachScalePair(rtContainer, { x: 0, y: 0, width: 800, height: 1000 }); // factor 1.0

        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        setDisplayMode('fit');

        const note = document.getElementById('fit-scale-note');
        if (!note) throw new Error('test setup: fit-scale-note not registered');
        // Confirms this scenario genuinely exercises the mismatch path the
        // invariant covers — not a vacuously-true no-op where console just
        // happened not to be called because nothing happened at all.
        expect(note.textContent).not.toBe('');
        expect(consoleLog).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
      });
    });

    describe('window.__loadPane wiring (#506 task 4/9)', () => {
      // __loadPane now renders into createScaleTarget(pane)'s inner element
      // (not the pane-content div itself) and calls rescaleAllPanes() on its
      // existing success path — these tests drive that end-to-end through
      // the real public loadPane entry point, with fetch/docx.renderAsync
      // stubbed as sandbox globals (neither exists in this vm context
      // otherwise; harness.js references both as bare identifiers).

      function stubFetchOk(): (url: string) => Promise<{ ok: true; blob: () => Promise<object> }> {
        return () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) });
      }

      function createRenderAsyncSpy(): {
        docx: { renderAsync: (...args: unknown[]) => Promise<void> };
        targets: unknown[];
      } {
        const targets: unknown[] = [];
        return {
          docx: {
            renderAsync: (_blob: unknown, target: unknown): Promise<void> => {
              targets.push(target);
              return Promise.resolve();
            },
          },
          targets,
        };
      }

      it('renders each load into a fresh outer/target pair without accumulating wrappers (no wrapper accumulation)', async () => {
        const { docx, targets } = createRenderAsyncSpy();
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: stubFetchOk(),
          docx,
        });
        const container = document.getElementById(PANE_CONTENT_IDS.reference);
        if (!container) throw new Error('test setup: pane-reference-content not registered');
        const loadPane = harnessWindow.__loadPane;
        assertIsFunction(loadPane, '__loadPane');

        await loadPane('run-1', 'reference');
        await loadPane('run-1', 'reference');

        // Exactly one outer/target pair survives two loads — this is
        // createScaleTarget's own no-accumulation invariant, pinned here
        // through the real public window.__loadPane boundary rather than an
        // internal-only test hook, confirming __loadPane actually routes
        // through it, rather than rendering straight into the pane-content
        // div as before.
        expect(container.children).toHaveLength(1);
        expect(container.children[0]?.className).toBe('pane-scale-outer');
        expect(container.children[0]?.children).toHaveLength(1);
        expect(container.children[0]?.children[0]?.className).toBe('pane-scale-target');
        expect(targets).toHaveLength(2);
        expect(targets[1]).not.toBe(targets[0]);
      });

      it('calls rescaleAllPanes() on the success path, recomputing the OTHER (unloaded) pane cleanly instead of leaving or compounding its stale transform (reset-first ordering)', async () => {
        const { docx } = createRenderAsyncSpy();
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: stubFetchOk(),
          docx,
        });
        const roundtripContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);
        const { outer: staleOuter, target: staleTarget } = attachScalePair(roundtripContainer, {
          x: 0,
          y: 0,
          width: 1600,
          height: 2000,
        });
        // Leftover state from a stale prior fit-mode computation on the
        // OTHER pane (wrong values, deliberately not the correct 0.5 factor
        // this rect/clientWidth pair recomputes to below) — proves the
        // assertions afterward observe a real recompute, not a pane that
        // already happened to hold the right answer.
        staleOuter.style.width = '999px';
        staleOuter.style.height = '111px';
        staleTarget.style.width = 'max-content';
        staleTarget.style.transform = 'scale(3.75)';
        staleTarget.style.transformOrigin = 'top left';
        configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);

        const loadPane = harnessWindow.__loadPane;
        assertIsFunction(loadPane, '__loadPane');
        await loadPane('run-1', 'reference');

        // rescaleAllPanes() always visits BOTH panes, so loading 'reference'
        // must also recompute the untouched 'roundtrip' pane — landing on
        // exactly the fresh scale(0.5)/800px/1000px this rect+clientWidth
        // pair produces, not the stale scale(3.75)/999px it started with,
        // and not some compounded product of the two (reset-first, never
        // additive — the same invariant task 3/9 pins for __setDisplayMode,
        // now confirmed to hold when driven through __loadPane's success
        // path). If loadPane's success path never called rescaleAllPanes(),
        // the stale values would still be here untouched.
        expect(staleTarget.style.transform).toBe('scale(0.5)');
        expect(staleTarget.style.width).toBe('max-content');
        expect(staleTarget.style.transformOrigin).toBe('top left');
        expect(staleOuter.style.width).toBe('800px');
        expect(staleOuter.style.height).toBe('1000px');
      });

      it('a stale (superseded) call must not overwrite paneState set by a newer call for the SAME pane (race guard, review finding)', async () => {
        // Two concurrent __loadPane calls for the same pane, neither
        // awaited before the next starts, is a legitimate direct
        // page.evaluate() pattern (this file's own header comment, README
        // step 3). window.__createScaleTarget always detaches whatever the
        // earlier call rendered into, but nothing used to stop that earlier
        // call's own .then()/.catch() from still overwriting paneState once
        // its fetch/render eventually settled — even reporting a false
        // 'done' over a genuine 'error' the newer call already surfaced.
        const { docx } = createRenderAsyncSpy();
        // Definite-assignment assertion (test-only, CLAUDE.md permits `!`
        // here): the executor below always runs synchronously inside `new
        // Promise`, assigning this before the constructor returns.
        let resolveSlowFetch!: (value: { ok: true; blob: () => Promise<object> }) => void;
        const slowFetch = new Promise<{ ok: true; blob: () => Promise<object> }>((resolve) => {
          resolveSlowFetch = resolve;
        });
        let fetchCallCount = 0;
        const fetchStub = (): Promise<{
          ok: boolean;
          status?: number;
          blob?: () => Promise<object>;
        }> => {
          fetchCallCount += 1;
          // Call A (first): stays pending until the test resolves it below,
          // deliberately well after call B has already settled.
          if (fetchCallCount === 1) return slowFetch;
          // Call B (second, supersedes call A): fails fast with a real
          // (non-404, so tryAutoLoadPane's retry-on-404 path is irrelevant
          // here) render error.
          return Promise.resolve({ ok: false, status: 500 });
        };

        const { window: harnessWindow } = await loadHarnessSandbox('', {
          fetch: fetchStub,
          docx,
        });
        const loadPane = harnessWindow.__loadPane;
        const measure = harnessWindow.__measure;
        assertIsFunction(loadPane, '__loadPane');
        assertIsFunction(measure, '__measure');

        const callA = loadPane('run-1', 'reference') as Promise<void>;
        const callB = loadPane('run-1', 'reference') as Promise<void>;

        await callB.catch(() => {
          // Expected — call B's stubbed fetch resolves ok:false.
        });
        await flushAsync();
        const afterCallB = measure('reference') as { status: string; error: string | null };
        expect(afterCallB.status).toBe('error');
        expect(afterCallB.error).not.toBeNull();

        // Call A's render now succeeds — well after call B already failed.
        // Call A's own promise still resolves (the render genuinely
        // happened, just into a now-detached node), but the shared
        // paneState must stay exactly as call B (the newer, live call) left
        // it.
        resolveSlowFetch({ ok: true, blob: () => Promise.resolve({}) });
        await expect(callA).resolves.toBeUndefined();
        await flushAsync();

        const afterCallA = measure('reference') as { status: string; error: string | null };
        expect(afterCallA.status).toBe('error');
        expect(afterCallA.error).not.toBeNull();
      });
    });

    describe('window.__measure capture-mode guarantee (#506 task 5/9)', () => {
      // window.__measure()/window.__regionGeom() only trust geometry read in
      // capture mode (untransformed, natural size) — see this file's DISPLAY
      // MODES header comment. These tests pin that __measure() force-applies
      // capture mode itself before reading geometry, rather than trusting the
      // caller to have switched modes first.

      it('force-switches an active fit-mode transform to capture (GLOBALLY, both panes) before reading geometry', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const referenceContainer = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { outer: referenceOuter, target: referenceTarget } = attachScalePair(
          referenceContainer,
          { x: 0, y: 0, width: 1600, height: 2000 }
        );
        const [page] = attachRenderedPages(referenceTarget, [
          { x: 12, y: 34, width: 816, height: 1056 },
        ]);
        if (!page) throw new Error('test setup: reference page not attached');

        const roundtripContainer = configurePaneContent(document, PANE_CONTENT_IDS.roundtrip, 800);
        const { outer: roundtripOuter, target: roundtripTarget } = attachScalePair(
          roundtripContainer,
          { x: 0, y: 0, width: 1600, height: 2000 }
        );

        const setDisplayMode = harnessWindow.__setDisplayMode;
        const getDisplayMode = harnessWindow.__getDisplayMode;
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        assertIsFunction(getDisplayMode, '__getDisplayMode');
        setDisplayMode('fit');
        // Sanity: both panes are genuinely dirty (fit-mode transform applied)
        // before __measure runs, so the assertions below observe a real
        // force-switch, not a pane that already happened to be untransformed.
        expect(referenceTarget.style.transform).toBe('scale(0.5)');
        expect(roundtripTarget.style.transform).toBe('scale(0.5)');

        const measure = harnessWindow.__measure;
        assertIsFunction(measure, '__measure');
        const result = measure('reference') as {
          status: string;
          pageCount: number;
          pages: Array<{ pageGeom: Rect | null; headerGeom: Rect | null; footerGeom: Rect | null }>;
        };

        // The measured pane's scale pair is reset to the same blank state
        // __setDisplayMode('capture') itself produces (task 3/9's own pin).
        expect(referenceTarget.style.transform).toBe('');
        expect(referenceTarget.style.width).toBe('');
        expect(referenceTarget.style.transformOrigin).toBe('');
        expect(referenceOuter.style.width).toBe('');
        expect(referenceOuter.style.height).toBe('');
        // The OTHER (unmeasured) pane resets too — ensureCaptureMode routes
        // through the real, global __setDisplayMode('capture'), never a
        // local per-pane shortcut (#506 spike finding 2, decision 2).
        expect(roundtripTarget.style.transform).toBe('');
        expect(roundtripOuter.style.width).toBe('');
        expect(getDisplayMode()).toBe('capture');

        // geomOf/measurePage's own field shape and rounding are untouched —
        // the regression pin this task's design calls out explicitly.
        expect(result.pageCount).toBe(1);
        expect(result.pages).toHaveLength(1);
        expect(result.pages[0]?.pageGeom).toEqual({ x: 12, y: 34, width: 816, height: 1056 });
        expect(result.pages[0]?.headerGeom).toBeNull();
        expect(result.pages[0]?.footerGeom).toBeNull();
      });

      it('is idempotent when already in capture mode — repeat calls read byte-identical geometry with no side effect', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('?mode=capture');
        const getDisplayMode = harnessWindow.__getDisplayMode;
        const setDisplayMode = harnessWindow.__setDisplayMode;
        assertIsFunction(getDisplayMode, '__getDisplayMode');
        assertIsFunction(setDisplayMode, '__setDisplayMode');
        expect(getDisplayMode()).toBe('capture');

        const container = configurePaneContent(document, PANE_CONTENT_IDS.reference, 800);
        const { target } = attachScalePair(container, { x: 0, y: 0, width: 800, height: 1000 });
        attachRenderedPages(target, [{ x: 10, y: 20, width: 800, height: 1000 }]);
        // Establishes the realistic already-reset baseline a real page reaches
        // once anything (e.g. __loadPane's success path) has driven
        // rescaleAllPanes at least once, so the assertions below observe a
        // stable '' that never toggles — not an untouched `undefined` that
        // would trivially satisfy an unguarded assertion either way.
        setDisplayMode('capture');
        expect(target.style.transform).toBe('');

        const measure = harnessWindow.__measure;
        assertIsFunction(measure, '__measure');
        const first = measure('reference');
        const second = measure('reference');

        expect(second).toEqual(first);
        expect(target.style.transform).toBe('');
        expect(getDisplayMode()).toBe('capture');
      });
    });

    describe('window.__pollRun runKind threading + empty-state message (#506 task 6/9)', () => {
      // RunKind is a plain, caller-supplied 2nd argument — never persisted
      // module state, and never allowed to crash rendering just because a
      // caller passed something other than exactly 'upload'/'scenario'.
      // These drive the REAL __pollRun -> tick() -> renderProperties /
      // renderDerivationReport path end to end (fetch stubbed, nothing else
      // white-boxed) rather than asserting against an unexposed
      // emptyStateMessage helper directly.

      function terminalRecordWithNoReport(runId: string): unknown {
        return {
          runId,
          stage: 'generate',
          status: 'complete',
          error: null,
          artifacts: { derivationReport: null },
        };
      }

      function jsonResponse(body: unknown): { ok: true; json: () => Promise<unknown> } {
        return { ok: true, json: () => Promise.resolve(body) };
      }

      // Every fetch a poll tick fires besides the poll itself (pane files,
      // diff crops) is treated as "not ready yet" — __loadPane/loadDiffPane
      // already handle a non-ok response without crashing (pinned by the
      // task 4/9 suite above), so a blanket 404 keeps this suite focused on
      // the renderProperties/renderDerivationReport empty-state text alone.
      function createPollFetchStub(
        recordsByUrl: Record<string, unknown>
      ): (url: string) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }> {
        return (url: string) => {
          const record = recordsByUrl[url];
          if (record !== undefined) {
            return Promise.resolve(jsonResponse({ success: true, data: record }));
          }
          return Promise.resolve({ ok: false, status: 404 });
        };
      }

      function textOf(document: FakeDocumentStub, id: string): string {
        const element = document.getElementById(id);
        if (!element) throw new Error(`test setup: ${id} not registered`);
        return element.textContent;
      }

      // renderProperties/renderDerivationReport's empty-report branch
      // APPENDS a <p class="pane-empty"> child carrying the message — it
      // never assigns body.textContent directly — so (mirroring FakeElement's
      // real-DOM-like split between an element's own textContent setter and
      // its children) the message lives on that child, not on the container
      // this fixture's getElementById(id) itself returns.
      function emptyStateTextOf(document: FakeDocumentStub, id: string): string {
        const container = document.getElementById(id);
        if (!container) throw new Error(`test setup: ${id} not registered`);
        const message = container.children[0];
        if (!message) throw new Error(`test setup: ${id} has no rendered child`);
        return message.textContent;
      }

      it('defaults an omitted runKind to the "upload" empty-state message', async () => {
        const record = terminalRecordWithNoReport('run-upload-1');
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: createPollFetchStub({ '/api/runs/run-upload-1': record }),
        });
        const pollRun = harnessWindow.__pollRun;
        assertIsFunction(pollRun, '__pollRun');

        pollRun('run-upload-1');
        await flushAsync();

        expect(emptyStateTextOf(document, 'properties-body')).toContain(
          'No derivation report yet.'
        );
        expect(emptyStateTextOf(document, 'derivation-body')).toContain(
          'No derivation report yet.'
        );
      });

      it('renders the scenario-specific empty-state message for a caller-supplied runKind="scenario"', async () => {
        const record = terminalRecordWithNoReport('run-scenario-1');
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: createPollFetchStub({ '/api/runs/run-scenario-1': record }),
        });
        const pollRun = harnessWindow.__pollRun;
        assertIsFunction(pollRun, '__pollRun');

        pollRun('run-scenario-1', 'scenario');
        await flushAsync();

        expect(emptyStateTextOf(document, 'properties-body')).toContain(
          'n/a for fixture scenario runs'
        );
        expect(emptyStateTextOf(document, 'derivation-body')).toContain(
          'n/a for fixture scenario runs'
        );
      });

      it('never crashes rendering on an unexpected runKind value, falling back to the default empty-state message', async () => {
        const record = terminalRecordWithNoReport('run-bogus-1');
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: createPollFetchStub({ '/api/runs/run-bogus-1': record }),
        });
        const pollRun = harnessWindow.__pollRun;
        assertIsFunction(pollRun, '__pollRun');

        expect(() => pollRun('run-bogus-1', 'not-a-real-run-kind')).not.toThrow();
        await flushAsync();

        // A full, uninterrupted run-status write is the confirmation that
        // nothing threw mid-tick — a crash partway through tick() would
        // leave properties-body/derivation-body cleared but never refilled.
        expect(textOf(document, 'run-status')).toContain('run-bogus-1');
        expect(emptyStateTextOf(document, 'properties-body')).toContain(
          'No derivation report yet.'
        );
        expect(emptyStateTextOf(document, 'derivation-body')).toContain(
          'No derivation report yet.'
        );
      });

      it('is not persisted across calls — runKind is a per-call argument, not module state left over from a prior run', async () => {
        const scenarioRecord = terminalRecordWithNoReport('run-a');
        const uploadRecord = terminalRecordWithNoReport('run-b');
        const { window: harnessWindow, document } = await loadHarnessSandbox('', {
          fetch: createPollFetchStub({
            '/api/runs/run-a': scenarioRecord,
            '/api/runs/run-b': uploadRecord,
          }),
        });
        const pollRun = harnessWindow.__pollRun;
        assertIsFunction(pollRun, '__pollRun');

        pollRun('run-a', 'scenario');
        await flushAsync();
        expect(emptyStateTextOf(document, 'properties-body')).toContain(
          'n/a for fixture scenario runs'
        );

        // A second, unrelated run started with NO runKind argument must
        // fall back to the 'upload' default, not carry over 'scenario' from
        // the previous call.
        pollRun('run-b');
        await flushAsync();
        expect(emptyStateTextOf(document, 'properties-body')).toContain(
          'No derivation report yet.'
        );
      });
    });

    describe('resetPaneState clears the fit-scale note (#506 task 6/9)', () => {
      it('clears any existing #fit-scale-note text alongside the pane state it already resets', async () => {
        const { window: harnessWindow, document } = await loadHarnessSandbox('');
        const note = document.getElementById('fit-scale-note');
        if (!note) throw new Error('test setup: fit-scale-note not registered');
        note.textContent = 'fit-scale mismatch: reference=0.500 roundtrip=1.000';

        const resetPaneState = harnessWindow.__resetPaneState;
        assertIsFunction(resetPaneState, '__resetPaneState');
        resetPaneState();

        expect(note.textContent).toBe('');
      });
    });

    describe('scenario-picker.js runKind wiring (#506 task 6/9)', () => {
      // scenario-picker.js is a separate served file, not harness.js — this
      // runs the REAL served scenario-picker.js in its own sandbox, reusing
      // the same fake DOM/listener building blocks, with window.__pollRun
      // stubbed as a spy so the test observes exactly what argument list
      // handleStartScenario calls the shared entry point with.

      it('starts a fixture scenario run tagged runKind="scenario" through the shared __pollRun entry point', async () => {
        const response = await fetch(`${baseUrl}/scenario-picker.js`);
        const source = await response.text();

        const pollRunCalls: unknown[][] = [];
        const documentStub = createFakeDocument();
        const select = createFakeElement();
        select.value = 'default';
        documentStub.registerId('scenario-select', select);
        const button = createFakeElement();
        documentStub.registerId('start-scenario-button', button);
        documentStub.registerId('run-status', createFakeElement());

        const windowStub = createFakeWindow('');
        windowStub.__resetPaneState = (): void => {};
        windowStub.__pollRun = (...args: unknown[]): void => {
          pollRunCalls.push(args);
        };

        const sandbox = {
          window: windowStub,
          document: documentStub,
          fetch: (): Promise<{ json: () => Promise<unknown> }> =>
            Promise.resolve({
              json: () => Promise.resolve({ success: true, data: { runId: 'scenario-run-1' } }),
            }),
        };
        vm.createContext(sandbox);
        // eslint-disable-next-line sonarjs/code-eval
        vm.runInContext(source, sandbox);

        button.dispatchEvent('click');
        await flushAsync();

        expect(pollRunCalls).toEqual([['scenario-run-1', 'scenario']]);
      });
    });
  });

  it('answers a generic JSON 404 for any unmatched route, never an HTML error page', async () => {
    const response = await fetch(`${baseUrl}/nonexistent-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('accepts a JSON body large enough for a real full-page screenshot', async () => {
    runStore.createRun({ runId: 'run-2', referenceFilename: 'reference.docx' });
    // ~2 MB of base64 text — far past express's 100kb default limit, well
    // under this app's raised ceiling.
    const bigPayload = 'A'.repeat(2 * 1024 * 1024);

    const response = await fetch(`${baseUrl}/api/runs/run-2/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane: 'reference', imageBase64: bigPayload }),
    });

    // Not a valid PNG, so this is expected to 422 on content — the point is
    // that it is NOT rejected upstream as "payload too large".
    expect(response.status).toBe(422);
  });

  describe('errorHandler (HTTP transport boundary)', () => {
    it('passes through a client error status (malformed JSON) instead of flattening it to 500', async () => {
      // express.json() throws a body-parser SyntaxError carrying its own
      // `.status = 400` before any route handler runs — this pins that the
      // real client-error status survives, mirroring
      // src/api/middleware/error.ts's `err.status ?? 500` passthrough.
      const response = await fetch(`${baseUrl}/api/runs/does-not-exist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not valid JSON',
      });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(400);
      expect(body).toEqual({ success: false, error: 'internal server error' });
    });

    it('answers 400 for a multer file-size-limit rejection, passing through its message only', async () => {
      runStore.createRun({ runId: 'run-3', referenceFilename: 'reference.docx' });
      const overLimitFile = Buffer.alloc(10 * 1024 * 1024 + 1);
      const form = new FormData();
      form.append('file', new Blob([overLimitFile]), 'reference.docx');

      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.error).not.toContain('.ts:');
      expect(body.error).not.toContain('at ');
    });

    it('answers a generic 500 without leaking internals when a handler-level fs write throws', async () => {
      // Deletes the run's own work directory out from under it, so
      // routes/runs.ts's writeFileSync (writeScreenshot) throws a raw,
      // unwrapped ENOENT synchronously inside submitScreenshotHandler — the
      // exact "disk I/O fails mid-handler" scenario this middleware exists
      // to contain.
      runStore.createRun({ runId: 'run-4', referenceFilename: 'reference.docx' });
      rmSync(runStore.runDir('run-4'), { recursive: true, force: true });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

      const response = await fetch(`${baseUrl}/api/runs/run-4/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference', imageBase64: pngBytes.toString('base64') }),
      });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(500);
      expect(body).toEqual({ success: false, error: 'internal server error' });
      expect(JSON.stringify(body)).not.toContain('ENOENT');
    });
  });
});
