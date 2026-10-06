# SpecR Revit Add-In

A Revit add-in (C#/.NET) that connects to a running [SpecR](../README.md) instance
through its REST API. **Phase 4c is the scaffold only** — it registers a ribbon
button and ships a typed REST client. Parameter-mapping data flow (Part 2
auto-population, change detection) arrives in later Phase 4 work.

This is a **separate C# solution**. It is independent of the repository's
TypeScript/pnpm toolchain — `pnpm` commands do not apply here.

## What's here

| File                    | Role                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SpecRAddin.csproj`     | SDK-style project, one target framework per Revit runtime (`net48` / `net8.0-windows` / `net10.0-windows`, ADR-094) |
| `global.json`           | Pins the .NET 10 SDK that builds every leg                                                                          |
| `packages.lock.json`    | NuGet lock file — CI restores in locked mode                                                                        |
| `App.cs`                | `IExternalApplication` — registers the "SpecR" ribbon tab + button                                                  |
| `HealthCheckCommand.cs` | `IExternalCommand` behind the button — pings `GET /health`                                                          |
| `SpecRClient.cs`        | Typed REST client (Refit) — `GetHealthAsync`, `GetSpecAsync`                                                        |
| `Models.cs`             | DTOs mirroring `openapi.yaml` (`SpecTree`, `SpecNode`, …)                                                           |
| `SpecRAddin.addin`      | Revit add-in manifest                                                                                               |

## Prerequisites

- **.NET 10 SDK** (`global.json` pins it; `latestFeature` roll-forward). It builds
  all three legs on Windows, macOS or Linux — the Revit API comes from NuGet
  reference packages, so **no Revit install is needed to build**, and the .NET
  Framework 4.8 reference assemblies are pulled from NuGet too.
- To **run** the add-in: Windows with Autodesk Revit 2024, 2025, 2026 or 2027.
- A running SpecR server (see the root README) reachable from the workstation.

## Build

```powershell
cd revit-addin
dotnet build -c Release
```

That builds every Revit runtime leg at once (no Revit install is consulted). To build one Revit year only (for
example to compile against the 2026 API surface):

```powershell
dotnet build -c Release -p:RevitVersion=2026 -p:NuGetLockFilePath=obj/revit2026.lock.json
```

`RevitVersion` picks both the runtime leg and the exact Revit API package; a
single-year build resolves a different package than the committed lock, so point
it at a throwaway lock path as shown (the committed `packages.lock.json` covers
the default matrix only).

The build writes one folder per leg under `bin\Release\<tfm>\` —
`SpecRAddin.dll`, its NuGet dependencies (`Refit.dll` and friends; the Revit API
is never copied) and a copy of `SpecRAddin.addin`:

| Folder                         | Revit                                      |
| ------------------------------ | ------------------------------------------ |
| `bin\Release\net48\`           | 2024                                       |
| `bin\Release\net8.0-windows\`  | 2025 and 2026 (built against the 2025 API) |
| `bin\Release\net10.0-windows\` | 2027                                       |

## Install (manual load into Revit)

1. Build (above).
2. Copy `SpecRAddin.addin` **and** every DLL from the leg folder that matches
   your Revit (table above) into:
   - `%ProgramData%\Autodesk\Revit\Addins\<year>\` (all users), or
   - `%AppData%\Autodesk\Revit\Addins\<year>\` (current user only).

   The `Assembly` path in the manifest is relative, so the manifest and DLLs must
   sit in the same folder (or edit the manifest to a full DLL path).

3. (Optional) Point the add-in at a non-default SpecR URL by setting the
   `SPECR_API_URL` environment variable before launching Revit
   (default `http://localhost:3000`).
4. Launch Revit. Revit prompts to load an unsigned add-in the first time — allow it.

## Manual verification (Phase 4c acceptance)

> CI compiles every runtime leg on each pull request (`Build (revit-addin)` job),
> but there are no automated runtime tests: the acceptance criteria below need the
> Revit host, which is Windows-only and not present in CI.

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
dependency, and produces output that drifts noisily under review.

Refit 16.x is used on every leg. System.Text.Json 10.x is referenced directly on
the `net48` leg only (Refit requires it there; the 8.x line leaves support with
.NET 8 on 2026-11-10), while the .NET 8 and .NET 10 legs use the framework's own
copy. NuGet resolves each leg independently, and `NU1605` is an explicit error so
a transitive floor can never silently outrun a direct pin.

### One target framework per Revit runtime (ADR-094)

Revit pins its .NET runtime per release, and an add-in compiled for one runtime
does not load in another:

| Revit      | Runtime            | Target framework  | Default API package                            |
| ---------- | ------------------ | ----------------- | ---------------------------------------------- |
| 2024       | .NET Framework 4.8 | `net48`           | `Nice3point.Revit.Api.*` 2024.3.60             |
| 2025, 2026 | .NET 8             | `net8.0-windows`  | 2025.4.60 (`-p:RevitVersion=2026` → 2026.4.10) |
| 2027       | .NET 10            | `net10.0-windows` | 2027.3.0                                       |

Each leg compiles against the **oldest** Revit on its runtime, which is the build
that loads in every later release on that runtime; pass `-p:RevitVersion=<year>`
when code needs a newer API. `#if REVIT2025` / `#if REVIT2025_OR_GREATER` style
constants are defined per leg (the same names the Nice3point templates generate).
There is no .NET Core 2.x leg: no Revit release ever ran on it.

Autodesk has announced a .NET 10 migration for Revit 2025/2026 ahead of .NET 8's
end of support (November 2026); when the 2025/2026 API packages are republished
for `net10.0-windows`, the `net8.0-windows` leg can be revisited.

### Revit API reference strategy

`RevitAPI.dll` / `RevitAPIUI.dll` come from the MIT-licensed
[`Nice3point.Revit.Api.*`](https://github.com/Nice3point/RevitApi) NuGet packages,
versioned by Revit year and pinned exactly in the csproj. They are
**reference assemblies only** — nothing is copied to the output, and Revit loads
its own copies at runtime, so there are no assembly-load conflicts and the Revit
SDK stays out of source control. This is what lets the add-in build on CI (a Linux
runner with no Revit) on every pull request.
