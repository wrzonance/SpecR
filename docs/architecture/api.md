# API Design

> ↩ [Architecture index](../../ARCHITECTURE.md)

All responses follow `ApiResponse<T>`:
```typescript
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: { total: number; page: number; limit: number }
}
```

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/parse` | multipart: `file` (.docx/.sec/.txt/.pdf), `section?`, `title?`, `numberingProfileId?` | `202 { jobId }` — async; poll `GET /parse/jobs/:jobId` for result |
| GET | `/parse/jobs/:jobId` | — | `{ jobId, status, progress, result?, error? }` |
| GET | `/specs/:id` | — | `CsiTree` |
| PATCH | `/specs/:id` | `{ title?, section? }` | `{ specId, title, section }` |
| POST | `/specs/:id/generate` | `{ templateId? }` | DOCX buffer (octet-stream) |
| POST | `/specs/:id/diff` | multipart: `file` (edited .docx) | `{ added[], modified[], deleted[], conflicts[] }` |
| POST | `/specs/:id/merge` | `{ accept: string[], diff: DiffResult }` | `{ applied: number, rejected: number }` |
| GET | `/libraries/:libraryId/divisions/:division/general-spec` | — | `DivisionGeneralSpecResult` |
| PUT | `/libraries/:libraryId/divisions/:division/general-spec` | `{ generalSpecId }` or `{ status: "not_applicable" }` | `DivisionGeneralSpecResult` |
| GET | `/projects/:id/divisions/:division/general-spec` | — | `DivisionGeneralSpecResult` |
| PUT | `/projects/:id/divisions/:division/general-spec` | `{ generalSpecId }` or `{ status: "not_applicable" }` | `DivisionGeneralSpecResult` |
| POST | `/mcp` | MCP JSON-RPC request | MCP JSON-RPC response (Streamable HTTP transport) |
| GET | `/mcp` | — | `405 Method Not Allowed` |
| DELETE | `/mcp` | (requires `mcp-session-id` header) | `204` terminated · `400`/`404` if header missing/unknown |

The table above is the original MVP surface. `openapi.yaml` is the authoritative, CI-enforced contract (rendered live at `GET /docs` via Scalar, served raw at `GET /openapi.yaml`). Endpoint groups added since the MVP:

- **Spec lifecycle:** `DELETE /specs/:id` (soft-withdraw) + `/specs/:id/restore`; advisory locks (`GET/PUT/DELETE /specs/:id/lock`); reversible paragraph removal; single-paragraph `PATCH`.
- **Onboarding & editability:** `PATCH .../editability`, `POST /specs/:id/reclassify`, `POST /specs/:id/finalize` & `/reopen`, `POST .../comments/:index/accept-as-note`, external-content associations, `POST/DELETE /specs/:id/style-source`, numbering-profile assignment.
- **Projects:** `GET /projects` (list), `PATCH /projects/:id` (rename + `sectionNumberFormat`), `DELETE /projects/:id` + `/restore`, `PUT /projects/:id/sources`.
- **Coordination / E&O:** required-sections (project + package), `GET /projects/:id/coordination-report`, `POST /projects/:id/submittal-register`, `GET /specs/:id/open-comments` & `GET /projects/:id/open-comments`.
- **Libraries:** `GET /libraries`, `POST /libraries/clients`, `PATCH /libraries/:id`, `GET /libraries/:id/specs`, async `POST /libraries/:id/import`, convention profiles, numbering profiles.
- **Revisions & templates:** `POST /revisions/:id/generate` (issued/addendum manuals), revision-nomenclature profiles, style-template CRUD + `POST /templates/import`.
