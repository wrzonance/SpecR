# SpecR

Headless API service for CSI MasterFormat specification document automation with round-trip DOCX support.

## What Is This

SpecR treats construction specification documents as structured data with true parent/child paragraph relationships — not opaque Word files. It parses DOCX specifications into a canonical AST, stores them in a database, and can regenerate them with full numbering fidelity. It supports git-style 3-way merge when edited documents come back from reviewers.

## Status

**Research phase.** See [`docs/research-executive-summary.md`](docs/research-executive-summary.md) for the full landscape analysis.

No code has been written yet.

## Goals

- Parse any firm's existing DOCX specifications into structured data (company-agnostic)
- Infer paragraph hierarchy from OOXML's flat paragraph model
- Generate DOCX with exact CSI multilevel numbering
- Round-trip documents through manual editing without data loss
- Accept BIM model data to auto-populate Part 2 (Products) sections
- Support multi-firm paragraph libraries with inheritance
- All CSI divisions from day one

## Reference Data

- `docs/references/UFGS/` — Unified Facilities Guide Specifications (.SEC format, public domain)
- `docs/references/ARCAT/README.md` — Download instructions for ARCAT guide specs (copyrighted, not included)
- `docs/references/MANUFACTURER_CPI/README.md` — Download instructions for CPI specs (copyrighted, not included)

## License

TBD (will be open source)
