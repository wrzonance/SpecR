import {
  handleIssuePackageRevision,
  handleGetRevision,
  handleListPackageRevisions,
  IssuePackageRevisionShape,
  GetRevisionShape,
  ListPackageRevisionsShape,
} from './package-revision-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerPackageRevisionTools(reg: ToolRegistrar): void {
  reg.register(
    'list_package_revisions',
    {
      description:
        'List a design package’s issued revisions as light summaries (metadata only), ordered by ' +
        'sortOrder — the per-package issuance clock (50% DD … IFC, addenda, bulletins). Read a ' +
        'single revision’s frozen trees with get_revision. Returns isError when the package UUID ' +
        'is not found.',
      inputSchema: ListPackageRevisionsShape,
    },
    handleListPackageRevisions
  );

  reg.register(
    'get_revision',
    {
      description:
        'Read an issued package revision by UUID — the immutable snapshot: revision metadata plus ' +
        'every member spec’s frozen paragraph tree (in membership order). Note: the response can ' +
        'be large (a full tree per member). Returns isError when the revision UUID is not found.',
      inputSchema: GetRevisionShape,
    },
    handleGetRevision
  );

  reg.register(
    'issue_package_revision',
    {
      description:
        'Issue an immutable revision of a design package: freeze a snapshot of every member spec’s ' +
        'tree and flip the members to "issued". Provide a `type` from the project’s revision ' +
        'nomenclature (e.g. "addendum", "bulletin") plus optional date, sortOrder, and an open ' +
        'attributes bag (number/title/phase/…). Returns a light revision summary (read the frozen ' +
        'trees with get_revision). isError when the package is unknown, a member cannot be ' +
        'snapshotted, the type is not in the nomenclature, or the revision already exists.',
      inputSchema: IssuePackageRevisionShape,
    },
    handleIssuePackageRevision
  );
}
