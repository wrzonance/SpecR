# SpecR Revit Add-In

A Revit add-in (C#/.NET) that connects to a running [SpecR](../README.md) instance
through its REST API. **Phase 4c is the scaffold only** — it registers a ribbon
button and ships a typed REST client. Parameter-mapping data flow (Part 2
auto-population, change detection) arrives in later Phase 4 work.

This is a **separate C# solution**. It is independent of the repository's
TypeScript/pnpm toolchain — `pnpm` commands do not apply here.

## What's here

| File | Role |
| --- | --- |
| `SpecRAddin.csproj` | SDK-style project targeting the Revit 2024 runtime (.NET Framework 4.8) |
| `App.cs` | `IExternalApplication` — registers the "SpecR" ribbon tab + button |
| `HealthCheckCommand.cs` | `IExternalCommand` behind the button — pings `GET /health` |
| `SpecRClient.cs` | Typed REST client (Refit) — `GetHealthAsync`, `GetSpecAsync` |
| `Models.cs` | DTOs mirroring `openapi.yaml` (`SpecTree`, `SpecNode`, …) |
| `SpecRAddin.addin` | Revit add-in manifest |

## Prerequisites

- Windows with **Autodesk Revit 2024** installed (the add-in loads `RevitAPI.dll`
  / `RevitAPIUI.dll` from the install directory).
- **.NET SDK** (the .NET Framework 4.8 targeting pack must be installed; it ships
  with the Visual Studio "Desktop development with C++/.NET" workloads, or the
  standalone targeting pack).
- A running SpecR server (see the root README) reachable from the workstation.

## Build

```powershell
cd revit-addin
dotnet build -c Release
```

If Revit is installed somewhere non-standard, point the build at it:

```powershell
dotnet build -c Release -p:RevitVersion=2024 -p:RevitApiDir="D:\Autodesk\Revit 2024"
```

The build writes `SpecRAddin.dll` (plus `Refit.dll`, `System.Text.Json.dll`, and
the other NuGet dependencies) and a copy of `SpecRAddin.addin` to `bin\Release\`.

## Install (manual load into Revit)

1. Build (above).
2. Copy `SpecRAddin.addin` **and** every DLL from `bin\Release\` into:
   - `%ProgramData%\Autodesk\Revit\Addins\2024\` (all users), or
   - `%AppData%\Autodesk\Revit\Addins\2024\` (current user only).

   The `Assembly` path in the manifest is relative, so the manifest and DLLs must
   sit in the same folder (or edit the manifest to a full DLL path).
3. (Optional) Point the add-in at a non-default SpecR URL by setting the
   `SPECR_API_URL` environment variable before launching Revit
   (default `http://localhost:3000`).
4. Launch Revit. Revit prompts to load an unsigned add-in the first time — allow it.

## Manual verification (Phase 4c acceptance)

> No automated tests: the acceptance criteria require the Revit runtime, which is
> Windows-only and not present in CI.

- [ ] Add-in loads in Revit 2024 without error (no startup `TaskDialog` warning).
- [ ] A **SpecR** ribbon tab with a **Health Check** button appears.
- [ ] With SpecR running, clicking **Health Check** shows a dialog reporting
      `Database: connected` and the server uptime.
- [ ] With SpecR stopped, the button reports a clear "could not reach SpecR" error
      rather than crashing.
- [ ] (Client smoke test) `SpecRClient.GetSpecAsync("<spec-uuid>")` returns a
      populated `SpecTree` against a dev server holding that spec.

## Design decisions

### Refit (not NSwag)

The client surface is tiny (two endpoints today, a handful tomorrow). **Refit** lets
us hand-write a small, readable interface that maps directly onto `openapi.yaml`,
with no codegen step in the build and no large generated file to review on every
contract change. **NSwag** would generate a complete client from `openapi.yaml`,
but that is far more code than this scaffold needs, adds a build-time generation
dependency, and produces output that drifts noisily under review. Refit also targets
`netstandard2.0`, so it loads cleanly under Revit 2024's .NET Framework 4.8 runtime.

### Target framework: `net48`

Revit 2024 runs on **.NET Framework 4.8**, so the add-in targets `net48`. The
project parameterizes the Revit version (`-p:RevitVersion=…`) for the install path,
but the framework is fixed per Revit major release.

### Revit API reference strategy

`RevitAPI.dll` / `RevitAPIUI.dll` are referenced from the local Revit install via
`HintPath` with **`Private=false`** (copy-local off). Revit loads its own copies at
runtime; shipping ours would cause assembly-load conflicts. This is the idiomatic
Revit add-in pattern and keeps the Revit SDK out of source control.

### Targeting other Revit versions

Revit **2025 and 2026** moved to **.NET 8** (`net8.0-windows`) and Revit
**2027** to **.NET 10** (`net10.0-windows`), each with a different API surface
(Autodesk is also migrating 2025/2026 to .NET 10 as .NET 8 leaves Microsoft
support in November 2026). To support those, multi-target the project
(`<TargetFrameworks>net48;net8.0-windows;net10.0-windows</TargetFrameworks>`)
and select the matching `RevitApiDir` per target framework. That work is out of
scope for the Phase 4c scaffold, which establishes the Revit 2024 baseline.
