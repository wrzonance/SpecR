// Which optional API capabilities the connected SpecR build serves.
//
// The demo was built against a richer ("mockup island") API than `main` ships.
// Rather than call endpoints that 404, each panel checks the relevant flag and
// degrades to a clear "not available in this build" state. As an endpoint lands
// on `main`, flip its flag to true — no panel rewrite required.
export const API_FEATURES = {
  listSpecsGlobal: false, // GET /specs (intentionally never added — use scoped listing)
  libraries: true, // GET /libraries, GET /libraries/:id/specs            (landed #227)
  libraryWrites: false, // POST /libraries/clients, PATCH /libraries/:id       (Phase 3)
  projectsList: true, // GET /projects                                       (landed #229)
  projectSettings: false, // PATCH /projects/:id                                 (Phase 4)
  projectSources: false, // PUT /projects/:id/sources                           (Phase 3)
  specDelete: false, // DELETE /specs/:id                                   (Phase 4)
  paragraphDelete: false, // DELETE /specs/:id/paragraphs/:nodeId               (Phase 4)
  coordination: false, // coordination-report + required-sections            (Phase 4)
};
