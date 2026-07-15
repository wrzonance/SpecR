// Shared Express route-param coercion for this harness's route handlers.
//
// Express 5's ParamsDictionary types a captured segment as `string | string[]`
// (to accommodate repeating params elsewhere in an app) — none of this
// harness's routes declare a repeating param, so a string[] here can only mean
// a malformed request; treat it the same as "absent" rather than passing an
// array where a single runId/filename string is expected.
export function stringParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
