import {
  handleUpdateParagraph,
  handleRemoveParagraph,
  handleInsertParagraph,
  handleAcceptCommentAsNote,
  handleAcknowledgeParagraph,
  handleSetCommentClosed,
  UpdateParagraphShape,
  RemoveParagraphShape,
  InsertParagraphShape,
  AcceptCommentShape,
  AcknowledgeParagraphShape,
  SetCommentClosedShape,
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
  registerAcknowledgementTool(reg);
  registerCommentResolutionTools(reg);
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
    'insert_paragraph',
    {
      description:
        'Insert a new paragraph immediately after anchorNodeId, as its sibling (#372) — ' +
        'the WYSIWYG Enter gesture. nodeType defaults to the anchor’s own type; only ' +
        'article, pr1–pr7, and continuation are insertable (never part or note). An ' +
        'explicit nodeType must also match the anchor’s tier — its own type, ' +
        'continuation (any tier), or any insertable type after a tierless anchor, ' +
        'i.e. a note or a continuation, neither of which carries a tier (#383) — ' +
        'a mismatched tier (e.g. pr1 after an article) is rejected. Bumps the spec’s ' +
        'contentVersion; pass expectedVersion for the optimistic-concurrency check. ' +
        'Returns the created SpecNode.',
      inputSchema: InsertParagraphShape,
    },
    handleInsertParagraph
  );
}

// Split out of registerParagraphContentTools purely to keep that function
// under the repo's enforced max-lines-per-function cap (#545 pushed it over).
function registerAcknowledgementTool(reg: ToolRegistrar): void {
  reg.register(
    'acknowledge_paragraph',
    {
      description:
        'Acknowledge or un-acknowledge a note or textBox object node (#545, ADR-079 ' +
        'follow-on): affirms a specifier has read and accepted it, clearing the ' +
        'issuance-readiness gate’s specifier_note_present / body_object_present finding ' +
        'WITHOUT removing or hiding the content — it still renders exactly as before. ' +
        'Only note nodes and textBox-kind object nodes are acknowledgeable (never a ' +
        'table object). Idempotent.',
      inputSchema: AcknowledgeParagraphShape,
    },
    handleAcknowledgeParagraph
  );
}

function registerCommentResolutionTools(reg: ToolRegistrar): void {
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

  reg.register(
    'set_comment_closed',
    {
      description:
        'Close or reopen a source-document review comment on an existing spec (#545, ' +
        'ADR-079 follow-on) — the only supported path to clear the readiness gate’s ' +
        'open_comment finding. index is the zero-based position in the anchor’s ' +
        'source_facts.comments. Idempotent.',
      inputSchema: SetCommentClosedShape,
    },
    handleSetCommentClosed
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
