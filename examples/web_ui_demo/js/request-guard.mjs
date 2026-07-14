// Monotonic stale-response guard — shared by any module that memoizes an
// async resource (scoring.js's loaded report, header-footer-editor.js's
// draft, header-footer.js's mounted editor, ...) and needs the LATEST
// request's outcome to always win, even when an EARLIER request resolves
// after it (out-of-order network responses). Originally lived inline in
// scoring.js (WS2, #424); extracted here once header-footer-editor.js and
// header-footer.js (#477) needed the exact same primitive, to avoid a third
// copy of this concurrency logic drifting out of sync (code.md's DRY bar:
// 3+ genuine call sites).
//
// next() issues a token for a new in-flight request; bump() invalidates
// whatever is in flight WITHOUT issuing a new token — used when the caller
// tears down the resource this guard belongs to entirely (nothing selected
// anymore, a memoized editor is being discarded because its scope is no
// longer visible) so a still-pending, now-ownerless response can never be
// applied; isCurrent() reports whether a token is still the newest issued.
export function createRequestGuard() {
  let current = 0;
  return {
    next: () => (current += 1),
    bump: () => {
      current += 1;
    },
    isCurrent: (token) => token === current,
  };
}
