import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import type { SourceFacts } from '../ast/index.js';

// #545, ADR-079 follow-on — end-to-end proof that every one of the four
// readiness-finding kinds now has a SUPPORTED API path to clear it, driven
// through the real REST endpoints (never the DB layer directly), closing
// the "block, never strip — but there is no path to fix the source and
// retry" gap PR 544 (ADR-079) left open.

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let specCounter = 0;
let paraCounter = 0;
let server: Server;
let baseUrl: string;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function newSpec(section: string, title: string): Promise<string> {
  const src = `rc_${suffix}_${String(++specCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, src]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}

interface ParaOptions {
  readonly nodeType?: string;
  readonly facts?: SourceFacts;
  readonly objectData?: Record<string, unknown>;
}

async function addParagraph(specId: string, text: string, opts: ParaOptions = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs
       (id, spec_id, parent_id, node_type, text, position, source_facts, object_data)
     VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      id,
      specId,
      opts.nodeType ?? 'pr1',
      text,
      ++paraCounter,
      JSON.stringify(opts.facts ?? {}),
      opts.objectData ? JSON.stringify(opts.objectData) : null,
    ]
  );
  return id;
}

async function readinessKinds(specId: string): Promise<readonly string[]> {
  const r = await req('GET', `/specs/${specId}/readiness-report`);
  const body = r.body as { data: { findings: readonly { type: string }[] } };
  return body.data.findings.map((f) => f.type);
}

// Every blob node must carry exactly one element tag (object-block.ts's
// buildImportedXmlComponent) — `blob: [{}]` is valid for readiness-only
// assertions (evaluateSpecReadiness never inspects the blob) but fails a
// real DOCX generation, which the full end-to-end scenario below exercises.
const textBoxObject = {
  kind: 'textBox',
  floating: false,
  generation: 'drawingml',
  blob: [
    {
      'w:p': [{ 'w:r': [{ 'w:drawing': [{ 'w:txbxContent': [{ 'w:p': [{ 'w:r': [] }] }] }] }] }],
    },
  ],
};

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;
});

afterAll(async () => {
  for (const id of specIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PATCH .../paragraphs/:nodeId — resolving a placeholder clears unresolved_choice_token (#545)', () => {
  it('editing the text through the real endpoint clears the finding end to end', async () => {
    const specId = await newSpec('09 91 26', 'Choice Token Clearance');
    const nodeId = await addParagraph(specId, 'Provide [insert value] finish.', {
      facts: {
        choiceTokens: [{ kind: 'bracket', options: ['insert value'], span: [8, 22] }],
        banner: '** SPECIAL NOTICE **',
      },
    });

    expect(await readinessKinds(specId)).toEqual(['unresolved_choice_token']);

    const patch = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}`, {
      text: 'Provide latex enamel finish.',
    });
    expect(patch.status).toBe(200);
    const patchBody = patch.body as { data: { meta: { sourceFacts?: SourceFacts } } };
    // The finding-clearing key is gone entirely (never an empty array)...
    expect(patchBody.data.meta.sourceFacts?.choiceTokens).toBeUndefined();
    // ...and an unrelated key survives the same write byte-identical (#545 —
    // "silently dropping unrelated source facts would be a far worse bug").
    expect(patchBody.data.meta.sourceFacts?.banner).toBe('** SPECIAL NOTICE **');

    expect(await readinessKinds(specId)).toEqual([]);
  });
});

describe('PATCH .../acknowledgement — clears specifier_note_present / body_object_present (#545)', () => {
  it('acknowledging a note clears its finding without changing its text', async () => {
    const specId = await newSpec('09 91 27', 'Note Acknowledgement');
    const nodeId = await addParagraph(specId, 'Confirm topcoat sheen with owner.', {
      nodeType: 'note',
    });

    expect(await readinessKinds(specId)).toEqual(['specifier_note_present']);

    const ack = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/acknowledgement`, {
      acknowledged: true,
    });
    expect(ack.status).toBe(200);
    const ackBody = ack.body as { data: { text: string; meta: { acknowledged?: boolean } } };
    expect(ackBody.data.text).toBe('Confirm topcoat sheen with owner.');
    expect(ackBody.data.meta.acknowledged).toBe(true);

    expect(await readinessKinds(specId)).toEqual([]);
  });

  it('acknowledging a textBox object clears its finding without changing its content', async () => {
    const specId = await newSpec('09 91 28', 'Object Acknowledgement');
    const nodeId = await addParagraph(specId, '', {
      nodeType: 'object',
      objectData: textBoxObject,
    });

    expect(await readinessKinds(specId)).toEqual(['body_object_present']);

    const ack = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/acknowledgement`, {
      acknowledged: true,
    });
    expect(ack.status).toBe(200);

    expect(await readinessKinds(specId)).toEqual([]);
  });

  it('un-acknowledging restores the finding — the toggle is a real toggle, not a one-way door', async () => {
    const specId = await newSpec('09 91 29', 'Note Un-acknowledgement');
    const nodeId = await addParagraph(specId, 'Verify with owner.', { nodeType: 'note' });

    await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/acknowledgement`, {
      acknowledged: true,
    });
    expect(await readinessKinds(specId)).toEqual([]);

    await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/acknowledgement`, {
      acknowledged: false,
    });
    expect(await readinessKinds(specId)).toEqual(['specifier_note_present']);
  });

  it('422s a node type that cannot produce either acknowledgeable finding', async () => {
    const specId = await newSpec('09 91 30', 'Non-acknowledgeable Node');
    const nodeId = await addParagraph(specId, 'Ordinary body text.');

    const ack = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/acknowledgement`, {
      acknowledged: true,
    });
    expect(ack.status).toBe(422);
  });
});

describe('PATCH .../comments/:index/closure — the only supported path to clear open_comment (#545)', () => {
  it('closing the comment clears the finding; reopening restores it', async () => {
    const specId = await newSpec('09 91 31', 'Comment Closure');
    const nodeId = await addParagraph(specId, 'Verify substrate.', {
      facts: { comments: [{ author: 'Jane', text: 'still open', anchor: [0, 5], closed: false }] },
    });

    expect(await readinessKinds(specId)).toEqual(['open_comment']);

    const close = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/comments/0/closure`, {
      closed: true,
    });
    expect(close.status).toBe(200);
    expect(await readinessKinds(specId)).toEqual([]);

    const reopen = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/comments/0/closure`, {
      closed: false,
    });
    expect(reopen.status).toBe(200);
    expect(await readinessKinds(specId)).toEqual(['open_comment']);
  });

  it('404s a comment index that does not exist (a lookup miss, not a validation failure)', async () => {
    const specId = await newSpec('09 91 32', 'Comment Closure Miss');
    const nodeId = await addParagraph(specId, 'No comments here.');

    const close = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/comments/0/closure`, {
      closed: true,
    });
    expect(close.status).toBe(404);
  });
});

describe('accept-as-note also closes the originating comment (#545 regression)', () => {
  it('no longer leaves the original comment open — accepting a comment no longer strictly increases blocking findings', async () => {
    const specId = await newSpec('09 91 33', 'Accept As Note Closes Comment');
    const nodeId = await addParagraph(specId, 'Verify substrate condition.', {
      facts: {
        comments: [{ author: 'Jane', text: 'pick a primer', anchor: [0, 5], closed: false }],
      },
    });

    expect(await readinessKinds(specId)).toEqual(['open_comment']);

    const accept = await req(
      'POST',
      `/specs/${specId}/paragraphs/${nodeId}/comments/0/accept-as-note`
    );
    expect(accept.status).toBe(201);

    // Before #545: open_comment (still open) PLUS the new note's
    // specifier_note_present — accepting a comment strictly increased the
    // blocking-finding count. After #545: the comment is closed as part of
    // accepting it, so only the new note's finding remains.
    expect(await readinessKinds(specId)).toEqual(['specifier_note_present']);

    const tree = await req('GET', `/specs/${specId}`);
    const treeBody = tree.body as {
      data: { parts: readonly { meta: { sourceFacts?: SourceFacts } }[] };
    };
    const anchor = treeBody.data.parts.find((p) => p.meta.sourceFacts?.comments);
    expect(anchor?.meta.sourceFacts?.comments?.[0]?.closed).toBe(true);
  });
});

describe('end-to-end: a final-mode issuance blocked by all four finding kinds succeeds once every finding is cleared through supported API paths ALONE (#545)', () => {
  it('drives the full block → clear → succeed scenario with overrideReadinessGate unset', async () => {
    const specId = await newSpec('09 91 34', 'Full Readiness Clearance E2E');

    const choiceNodeId = await addParagraph(specId, 'Provide [insert value] sealant.', {
      facts: { choiceTokens: [{ kind: 'bracket', options: ['insert value'], span: [8, 22] }] },
    });
    const noteNodeId = await addParagraph(specId, 'Confirm color with owner.', {
      nodeType: 'note',
    });
    const objectNodeId = await addParagraph(specId, '', {
      nodeType: 'object',
      objectData: textBoxObject,
    });
    const commentNodeId = await addParagraph(specId, 'Coordinate flashing detail.', {
      facts: {
        comments: [{ author: 'Sam', text: 'confirm detail', anchor: [0, 5], closed: false }],
      },
    });

    // 1. Blocked: all four finding kinds outstanding, mode: final, no override.
    const blocked = await req('POST', `/specs/${specId}/generate`, { mode: 'final' });
    expect(blocked.status).toBe(422);
    const blockedBody = blocked.body as { findings: readonly { type: string }[] };
    expect(new Set(blockedBody.findings.map((f) => f.type))).toEqual(
      new Set([
        'unresolved_choice_token',
        'specifier_note_present',
        'body_object_present',
        'open_comment',
      ])
    );

    // 2. Clear each finding through its supported API path — no overrideReadinessGate.
    const editRes = await req('PATCH', `/specs/${specId}/paragraphs/${choiceNodeId}`, {
      text: 'Provide silicone sealant.',
    });
    expect(editRes.status).toBe(200);

    const ackNoteRes = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/${noteNodeId}/acknowledgement`,
      { acknowledged: true }
    );
    expect(ackNoteRes.status).toBe(200);

    const ackObjectRes = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/${objectNodeId}/acknowledgement`,
      { acknowledged: true }
    );
    expect(ackObjectRes.status).toBe(200);

    const closeRes = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/${commentNodeId}/comments/0/closure`,
      { closed: true }
    );
    expect(closeRes.status).toBe(200);

    // 3. Every finding is gone via the dry-run report too.
    expect(await readinessKinds(specId)).toEqual([]);

    // 4. The SAME final-mode issuance now succeeds — overrideReadinessGate
    // still unset. This is the whole point of #545.
    const finalRes = await fetch(`${baseUrl}/specs/${specId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'final' }),
    });
    expect(finalRes.status).toBe(200);
    const buffer = Buffer.from(await finalRes.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer[0]).toBe(0x50); // 'P'
    expect(buffer[1]).toBe(0x4b); // 'K' — a real DOCX (zip) payload, not an error body.
  });
});
