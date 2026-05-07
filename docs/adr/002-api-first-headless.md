# ADR-002: API-First Headless Architecture

## Status: Accepted

## Context

SpecR has multiple potential consumer surfaces:
- A Revit add-in (C#/.NET) that needs to push model data and receive spec updates
- A web interface for spec writers to review diffs and manage libraries
- Future: an Autodesk Platform Services (APS/Forge) cloud integration
- Future: a Word Office Add-in for inline editing

Each consumer surface has different technology requirements: the Revit add-in is C#, the web interface is likely React/TypeScript, APS is cloud-hosted. Building the core as a UI-coupled monolith would require rebuilding it for each surface.

An alternative is a desktop application (Electron, Tauri) — but this eliminates multi-user access, makes the Revit-to-spec round-trip require file export/import rather than API calls, and ties the system to one machine.

## Decision

SpecR core is a headless REST API. No UI code in the core. Every feature is an API endpoint. Consumer surfaces are clients.

The primary clients are:
1. **Revit add-in** (Phase 4) — C#/.NET calling the REST API directly from within Revit
2. **Web interface** (Phase 5) — React/TypeScript calling the REST API

## Consequences

- The API contract (defined in `openapi.yaml`) is the product boundary. All consumer surfaces are implementation details above that boundary.
- Phase 1–3 work can be verified entirely via API calls (curl, Postman, integration tests) without any UI.
- Multiple firms, multiple projects, multiple users can share one SpecR instance. Multi-tenancy is an API design concern, not a UI concern.
- The Revit add-in does not need file export/import — it calls the API directly, which eliminates a round-trip step and reduces the chance of version mismatch.
- A UI must be built separately. This is intentional: the UI is not the hard part. The inference engine and merge logic are the hard part.
