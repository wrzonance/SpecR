# ADR-094: Revit add-in multi-targets one leg per Revit runtime, with the Revit API from NuGet

## Status

Accepted — amended 2026-10-06 (#705): the `net48` leg moved from Refit 7.2.22 +
System.Text.Json 8.0.6 to Refit 16.3.0 + System.Text.Json 10.0.12, so every
leg shares one Refit line. The original per-leg split is kept below as the
rejected alternative.

## Context

Autodesk pins the .NET runtime per Revit release, and an add-in compiled for
one runtime does not load in another: Revit 2024 (and earlier back to 2021)
runs on .NET Framework 4.8, Revit 2025 and 2026 on .NET 8, Revit 2027 on
.NET 10 — Autodesk's 2027 SDK announcement states that all add-ins must be
built against the .NET 10 SDK. No Revit release has ever run on .NET Core 2.x,
and no Revit API package ships a `netcoreapp2.x` or `netstandard2.0` asset, so
there is no "core 2" leg to carry.

`revit-addin/SpecRAddin.csproj` targeted `net48` only and referenced
`RevitAPI.dll` through a `HintPath` into a local Revit 2024 install. That meant
the add-in could not be compiled anywhere Revit was not installed — CI never
built it, so dependency PRs against it (#588/#688 Refit, #589 System.Text.Json)
could only be judged by hand — and it could not load in any Revit newer than 2024.

Refit added a second constraint. Every Refit release from 9.x onward requires
System.Text.Json ≥ 9.0.9 (10.x from 10.1.7 / 11.0.0 on, 10.0.12 at 16.3.0) on
.NET Framework, while the add-in pins System.Text.Json 8.0.6 there — the pair
that is known to load in Revit 2024's process. NuGet's direct-dependency-wins
rule turns that into an NU1605 downgrade error, which is why the unconditional
"Refit → v16" bump in #688 cannot restore. A stub compile against
`Autodesk.Revit.*` placeholders showed Refit 16 + System.Text.Json 10.0.12 does
build for `net48`, but nothing proves the larger 10.x assembly set loads inside
Revit 2024, and CI cannot exercise a Revit host.

## Decision

One SDK-style project, one target framework per Revit runtime generation,
building every leg in a single `dotnet build` on a Linux runner with no Revit
installed:

| Target framework  | Revit      | Revit API package                                                         | Refit / JSON                                     |
| ----------------- | ---------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `net48`           | 2024       | `Nice3point.Revit.Api.RevitAPI` / `RevitAPIUI` 2024.3.60                  | Refit 16.3.0 + System.Text.Json 10.0.12 (direct) |
| `net8.0-windows`  | 2025, 2026 | 2025.4.60 (oldest .NET 8 Revit; `-p:RevitVersion=2026` selects 2026.4.10) | Refit 16.3.0                                     |
| `net10.0-windows` | 2027       | 2027.3.0                                                                  | Refit 16.3.0                                     |

- **Revit API from NuGet, not a `HintPath`.** The `Nice3point.Revit.Api.*`
  packages (MIT) are reference-assembly-only (`ref/<tfm>/RevitAPI.dll`), so
  nothing is copied to the output and Revit supplies the real assemblies at
  runtime. This is what lets the project restore and build with no Revit
  present. Versions are exact pins per Revit year, selected through a
  `RevitVersion` → `RevitApiVersion` table in the csproj.
- **Plain `Microsoft.NET.Sdk` with a hand-written `<TargetFrameworks>`** rather
  than the `Nice3point.Revit.Sdk` MSBuild SDK. The SDK's per-configuration
  model (`Release.R25` …) builds one Revit year per invocation and adds a
  third-party build SDK; the plain form builds all legs at once, which is what
  CI wants, and needs nothing beyond the .NET 10 SDK. The `REVIT20xx` /
  `REVIT20xx_OR_GREATER` define constants keep the Nice3point names so `#if`
  branches stay portable.
- **Oldest release per runtime is the default.** Each leg compiles against the
  oldest Revit on its runtime (2024 / 2025 / 2027), which is the build that
  loads in every later release on the same runtime. `-p:RevitVersion=<year>`
  builds one year only, for code that needs a newer API.
- **One Refit line, System.Text.Json on the serviced line.** Refit 16.3.0 on
  every leg; System.Text.Json 10.0.12 is referenced directly on `net48` only
  (Refit requires ≥ 10.0.12 there), while the .NET 8/10 legs use the
  framework's own copy — a direct reference there is pruned to nothing by the
  .NET 10 SDK (NU1510). The 8.x System.Text.Json line leaves Microsoft support
  with .NET 8 on 2026-11-10 and Refit 7.x (last release 2024-11-08) receives
  no fixes, so the conservative pair considered first (below) would have put
  the leg that talks to the SpecR API on an unserviced JSON stack within weeks.
  `NU1605` is declared as an error explicitly so a transitive floor can never
  silently outrun a direct pin again.
- **Reproducible restore.** `packages.lock.json` is committed and CI restores
  in locked mode (`--locked-mode`), consistent with the repo's lockfile policy.
  Single-year overrides resolve a different Revit API package, so they are run
  with `-p:NuGetLockFilePath=obj/<name>.lock.json` and never touch the
  committed lock. A `global.json` pins the .NET 10 SDK (`latestFeature` roll
  forward) so one SDK builds all three legs.
- **CI builds the add-in.** A `Build (revit-addin)` job on `ubuntu-latest`
  runs `dotnet restore --locked-mode` and `dotnet build -c Release`
  (`EnableWindowsTargeting` makes the `-windows` legs compile on Linux;
  `Microsoft.NETFramework.ReferenceAssemblies` is implied for `net48`).
- **Renovate.** No NuGet carve-outs: Refit and System.Text.Json follow their
  current lines on every leg. Revit API package versions are property-driven
  (`$(RevitApiVersion)`), which Renovate does not track, and are bumped by
  hand.

### Rejected: keep `net48` on Refit 7.2.22 + System.Text.Json 8.0.6

The pair the single-target project shipped with, and the first cut of this
ADR. It is the only combination with an observed load inside Revit 2024, and
NuGet's per-framework graphs would have let it coexist with Refit 16 on the
other legs. Rejected because (a) System.Text.Json 8.x is unserviced from
2026-11-10, (b) Refit 7.x is unmaintained, (c) two Refit lines mean two code
paths and permanent Renovate exceptions, and (d) the assemblies Refit 16 brings
to `net48` are strong-named and load side-by-side with whatever Revit or other
add-ins carry, so the residual risk is the ordinary add-in acceptance check,
not a structural one.

## Consequences

- The add-in builds on every PR, and dependency changes to it are judged by a
  real compile instead of by hand. #688 is superseded: Refit 16 is on every
  leg.
- Output is `bin/<Configuration>/<tfm>/`, one folder per Revit runtime,
  whether the build goes through the solution or the project; the install step
  copies the folder matching the Revit year.
- The `net48` leg now ships the System.Text.Json 10.x assembly set
  (`System.Text.Json`, `System.IO.Pipelines`, `System.Threading.Channels`,
  `Microsoft.Bcl.*` …) beside the add-in. These are strong-named and load
  side-by-side in Revit 2024's process; the manual Health Check in
  `revit-addin/README.md` is the acceptance test for that host, as it is for
  every other leg.
- Autodesk has announced a .NET 10 migration for Revit 2025/2026 ahead of
  .NET 8's end of support (November 2026). When those updates ship and the
  2025/2026 API packages are republished for `net10.0-windows`, the
  `net8.0-windows` leg can be dropped (or kept for un-updated installs) —
  re-check the package TFMs then.
- The compile is verified in CI; loading inside each Revit host still needs the
  manual acceptance checklist in `revit-addin/README.md`, because the Revit
  runtime is Windows-only and absent from CI.
