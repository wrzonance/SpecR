// src/mcp/contract-write-response-map.ts
//
// INV-6 (#549) exemption/burn-down maps, split out of contract-map.ts to stay under the repo's
// 400-line file cap. Companion to contract-write-response.integration.test.ts, mirroring how
// INV5_SHAPE_EXEMPT/INV5_READ_PENDING gate the read-mapped tool universe in contract-map.ts.

/**
 * INV-6 (#549). Write-mapped (POST/PUT/PATCH/DELETE) ops whose success response is real JSON
 * (binary egress like `post /specs/{}/generate` and REST 202 job-acceptance shapes with no MCP
 * analog are structurally out of scope — see `contract-write-response.integration.test.ts`'s
 * `writeMappedJsonOps()`) but whose MCP tool output legitimately does NOT mirror that JSON body
 * 1:1, so INV-6 does not schema-validate it against that op. Mirrors INV5_SHAPE_EXEMPT's posture.
 */
export const INV6_WRITE_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'post /parse',
    'reshapes by transport, not just shape: REST accepts the upload async, returning 202 ' +
      '{ jobId } for later polling via the exempt GET /parse/jobs/{} route (see MCP_UNEXPOSED ' +
      'in contract-map.ts). parse_document runs synchronously and returns the FULL PARSED SPEC ' +
      'payload — there is no jobId in its output to validate against the 202 schema. Same ' +
      "posture as INV4_PARAM_EXEMPT's post /parse entry (no MCP raw-upload/job channel).",
  ],
]);

/**
 * INV-6 burn-down (#549). Write-mapped JSON ops that DO mirror their mapped REST op's body 1:1
 * but are not yet driven by INV-6 because exercising them needs a seeded fixture graph (a parsed
 * spec, a project with packages, a template, a checkpoint, …) beyond a bare row insert — the same
 * posture INV5_READ_PENDING takes for the read universe. INV-6's completeness invariant proves no
 * write-mapped JSON op is silently absent from both the driven set and these maps.
 */
export const INV6_WRITE_PENDING: ReadonlySet<string> = new Set([
  'delete /libraries/{}/disciplines',
  'delete /libraries/{}/header-footer',
  'delete /libraries/{}/language-rules',
  'delete /packages/{}/header-footer',
  'delete /projects/{}/header-footer',
  'delete /projects/{}/language-rules',
  'delete /projects/{}/revision-nomenclature',
  'delete /projects/{}/specs/{}',
  'delete /revisions/{}/header-footer',
  'delete /specs/{}/lock',
  'delete /specs/{}/style-source',
  'patch /clients/{}',
  'patch /libraries/{}',
  'patch /numbering-profiles/{}',
  'patch /projects/{}',
  'patch /specs/{}',
  'patch /specs/{}/paragraphs/{}',
  'patch /specs/{}/paragraphs/{}/editability',
  'patch /specs/{}/paragraphs/{}/removal',
  // #545, ADR-079 follow-on — same SpecNode-mirroring posture as removal above.
  'patch /specs/{}/paragraphs/{}/acknowledgement',
  'patch /specs/{}/paragraphs/{}/comments/{}/closure',
  'patch /templates/{}',
  'post /libraries/{}/conventions/clone',
  'post /libraries/{}/numbering-profiles',
  'post /numbering-profiles/snapshot',
  'post /packages/{}/revisions',
  'post /projects/{}/checkpoints',
  'post /projects/{}/packages',
  'post /projects/{}/restore',
  'post /projects/{}/revision-nomenclature/clone',
  'post /projects/{}/specs',
  'post /reports/compare',
  'post /specs/{}/checkpoints',
  'post /specs/{}/diff',
  'post /specs/{}/finalize',
  'post /specs/{}/merge',
  'post /specs/{}/paragraphs',
  'post /specs/{}/paragraphs/{}/associations',
  'post /specs/{}/paragraphs/{}/comments/{}/accept-as-note',
  'post /specs/{}/reclassify',
  'post /specs/{}/reopen',
  'post /specs/{}/restore',
  'post /specs/{}/style-source',
  'post /templates',
  'post /templates/import',
  'post /templates/{}/rules',
  'put /libraries/{}/conventions',
  'put /libraries/{}/disciplines',
  'put /libraries/{}/divisions/{}/general-spec',
  'put /libraries/{}/header-footer',
  'put /libraries/{}/language-rules',
  'put /packages/{}/header-footer',
  'put /packages/{}/specs',
  'put /projects/{}/divisions/{}/general-spec',
  'put /projects/{}/header-footer',
  'put /projects/{}/language-rules',
  'put /projects/{}/packages/{}/required-sections',
  'put /projects/{}/required-sections',
  'put /projects/{}/revision-nomenclature',
  'put /projects/{}/sources',
  'put /revisions/{}/header-footer',
  'put /specs/{}/lock',
  'put /specs/{}/numbering-profile',
  'put /standards/{}/{}',
]);

/**
 * INV-6 ratchet baseline (#549). The write-pending burn-down (INV6_WRITE_PENDING.size) must never
 * grow past this count, mirroring INV5_READ_PENDING_BASELINE — EXCEPT when new write-mapped JSON
 * ops are genuinely added to the API surface (a real scope increase, not a coverage regression),
 * in which case the baseline moves up in lockstep with the new pending entries. Verified by direct
 * count on 2026-08-04 (#545): the set holds exactly 64 entries — the prior 62 (#627, 2026-08-03)
 * plus the two new ops this issue adds (`patch .../acknowledgement`, `patch .../comments/{}/
 * closure`), both landing straight in this pending burn-down for the same SpecNode-mirroring
 * reason `patch .../removal` already does.
 */
export const INV6_WRITE_PENDING_BASELINE = 64;
