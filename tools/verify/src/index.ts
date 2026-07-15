// Placeholder entry point for the visual round-trip verification harness
// (issue #150). Real implementation (api-client, harness server, render/diff
// pipeline) lands across the follow-up tasks in this build plan; this file
// exists so `pnpm --dir tools/verify build`/`lint` have real TS source to
// exercise while the package is being scaffolded.
export const VERIFY_HARNESS_VERSION = '0.1.0';
