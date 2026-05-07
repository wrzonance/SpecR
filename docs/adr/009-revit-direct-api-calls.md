# ADR-009: Revit Add-In Calls SpecR API Directly

## Status: Accepted (Phase 4 — not yet implemented)

## Context

Integrating Revit model data with specification documents has two architectural options:

**Option A: File export/import**
Revit exports data (CSV, JSON, IFC) → user manually uploads to SpecR → SpecR processes → user downloads DOCX → user opens in Word.

**Option B: Direct API calls**
Revit add-in (C#/.NET) calls SpecR REST API directly from within Revit → SpecR processes → add-in confirms → spec is updated in database.

Option A requires more manual steps, introduces version mismatch risk (exported file may be stale by the time it's uploaded), and breaks the round-trip model — the spec writer must remember to re-export after every Revit model change.

The Autodesk Platform Services (APS/Forge) approach (cloud-hosted integration via Autodesk's cloud infrastructure) is a longer-term goal that does not affect the API design — APS would call the same SpecR REST API, just from Autodesk's cloud rather than from within the Revit desktop application.

## Decision

The Revit integration is implemented as a Revit add-in (C#/.NET) that calls the SpecR REST API directly. No file export/import step. The add-in:

1. Reads Revit model parameters (family types, equipment instances, parameters)
2. Maps them to SpecR paragraph UUIDs via the parameter mapping schema
3. Calls `PATCH /specs/:id/paragraphs/:nodeId` with updated text for each changed parameter
4. Shows a summary of what will change before committing

The SpecR API design must support this workflow:
- Paragraphs must be individually updatable via their UUID
- The API must accept partial updates (not require full spec replacement)
- Change previews (show what would change without committing) must be a supported operation

## Consequences

- The SpecR server must be network-accessible from the Revit workstation. For on-premises deployments, this means a local server or internal network deployment. Cloud deployment is also valid.
- Authentication and authorization (not in MVP) must be designed for machine-to-machine calls from the Revit add-in, not just human browser sessions.
- The Revit add-in is a separate project in a separate repository (C#/.NET). It depends on the SpecR OpenAPI spec (`openapi.yaml`). Changes to the API contract must not break the add-in silently — OpenAPI versioning and backward compatibility matter once the add-in exists.
- APS/Forge integration (Phase 6) would replace or augment the desktop add-in, calling the same API endpoints from Autodesk's cloud. The API design is cloud-integration-ready from day one.
