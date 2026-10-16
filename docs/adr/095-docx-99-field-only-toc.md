# ADR-095: preserve field-only manual tables of contents with docx 9.9

## Status

Accepted

## Context

The docx 9.9 update in #713 automatically populates a table of contents from
headings when no content is supplied. It also adds generated heading bookmarks.
SpecR's ADR-017 contract leaves TOC entries and pagination to Word, and equivalent
manual generation calls previously produced identical content parts.

## Decision

Supply one empty paragraph through the public `contentChildren` option and
explicitly mark the TOC field dirty. This retains the field and its Heading1-only
switches while leaving its result empty for Word to update. Do not remove duplicate
section titles from assertions or normalize away generated bookmark differences.

## Consequences

Manuals retain their existing Word-update behavior. Applications that do not update
fields still show an empty TOC until Word updates it. The dependency's new layout
and TOC population capabilities remain available for a separately designed change.
Regression tests pin the empty dirty field, title order and equivalent output.
