import {
  handleListLibraryStandards,
  handleListProjectStandards,
  handleRecordStandardVerification,
  ListLibraryStandardsShape,
  ListProjectStandardsShape,
  RecordStandardVerificationShape,
} from './standards-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

const ROLLUP_DESCRIPTION =
  'One-call standards rollup for a whole {scope} (#446). Returns the distinct ' +
  'standards cited in scope — each with orgCode, standardCode, citationCount, ' +
  'citingSpecs (specId + section), capped paragraph anchors, and the joined ' +
  'registry verdict (status, currentVersion, sourceUrl, lastVerifiedAt) — plus ' +
  'findings for any cited standard the registry marks superseded/withdrawn, and ' +
  'summary counts. Record a verdict with record_standard_verification.';

/** Standards registry tools (#446, ADR-064): two read-tier rollups + one
 *  write-tier verdict upsert. Contract-bound to the REST surface (ADR-044). */
export function registerStandardsTools(reg: ToolRegistrar): void {
  reg.register(
    'list_library_standards',
    {
      description: ROLLUP_DESCRIPTION.replace('{scope}', 'library'),
      inputSchema: ListLibraryStandardsShape,
    },
    handleListLibraryStandards
  );

  reg.register(
    'list_project_standards',
    {
      description: ROLLUP_DESCRIPTION.replace('{scope}', 'project'),
      inputSchema: ListProjectStandardsShape,
    },
    handleListProjectStandards
  );

  reg.register(
    'record_standard_verification',
    {
      description:
        'Record a standards verification verdict (#446, ADR-064). Upserts the ' +
        'registry record keyed on (orgCode, standardCode) — orgCode normalized to ' +
        'uppercase — and stamps last_verified_at on every write. PUT-replace: omitted ' +
        'optional fields (status/currentVersion/sourceUrl/title/notes) reset to null, ' +
        'status defaults to unknown. The verdict is reflected in the next standards rollup.',
      inputSchema: RecordStandardVerificationShape,
    },
    handleRecordStandardVerification
  );
}
