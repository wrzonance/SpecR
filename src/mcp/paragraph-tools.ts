import {
  handleUpdateParagraph,
  handleRemoveParagraph,
  handleAcceptCommentAsNote,
  UpdateParagraphShape,
  RemoveParagraphShape,
  AcceptCommentShape,
} from './paragraph-handlers.js';
import {
  handleListAssociations,
  handleCreateAssociation,
  handleDeleteAssociation,
  ParagraphRefShape,
  CreateAssociationShape,
  DeleteAssociationShape,
} from './association-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerParagraphTools(reg: ToolRegistrar): void {
  registerParagraphContentTools(reg);
  registerAssociationTools(reg);
}

function registerParagraphContentTools(reg: ToolRegistrar): void {
  reg.register(
    'update_paragraph',
    {
      description:
        'Replace a single paragraph’s text in place (ADR-009), bumping the spec’s ' +
        'contentVersion. Pass expectedVersion (the contentVersion you read) for an ' +
        'optimistic-concurrency check — a stale value is rejected so a concurrent edit ' +
        'is never clobbered. The node must belong to the spec.',
      inputSchema: UpdateParagraphShape,
    },
    handleUpdateParagraph
  );

  reg.register(
    'remove_paragraph',
    {
      description:
        'Reversibly remove or restore a body paragraph (#251, ADR-022). removed:true ' +
        'suppresses it from the owner-facing DOCX/Markdown renders while keeping the row, ' +
        'its subtree, and contained cross-references intact; removed:false reverses it. ' +
        'A structural heading (part/article) or note node is rejected — only body ' +
        'paragraphs are render-suppressible. Idempotent.',
      inputSchema: RemoveParagraphShape,
    },
    handleRemoveParagraph
  );

  reg.register(
    'accept_comment_as_note',
    {
      description:
        'Materialize a captured margin comment as a note paragraph immediately after its ' +
        'anchor (ADR-022 D4) — never a silent tree mutation. Returns { noteId } whether the ' +
        'note was newly created or already existed (idempotent — a repeat never mints a ' +
        'duplicate). index is the zero-based position in the anchor’s source_facts.comments.',
      inputSchema: AcceptCommentShape,
    },
    handleAcceptCommentAsNote
  );
}

function registerAssociationTools(reg: ToolRegistrar): void {
  reg.register(
    'list_associations',
    {
      description:
        'List the external-content associations for a paragraph (DMS documents or URLs ' +
        'linked to it). Link + provenance only — never the licensed bytes (ADR-019).',
      inputSchema: ParagraphRefShape,
    },
    handleListAssociations
  );

  reg.register(
    'create_association',
    {
      description:
        'Associate external content with a paragraph: either a complete DMS pair ' +
        '(externalProvider + externalId) or a url must be provided, plus a label. Stores ' +
        'link + provenance only, never the licensed bytes (ADR-019).',
      inputSchema: CreateAssociationShape,
    },
    handleCreateAssociation
  );

  reg.register(
    'delete_association',
    {
      description:
        'Remove an external-content association from a paragraph (hard delete of the link ' +
        'row). Requires specId, nodeId, and the associationId from list_associations. ' +
        'Destructive: exposed only when the destructive tier is enabled.',
      inputSchema: DeleteAssociationShape,
    },
    handleDeleteAssociation
  );
}
