// Which optional API capabilities the connected SpecR build serves.
//
// The demo was built against a richer ("mockup island") API than `main` ships.
// Rather than call endpoints that 404, each panel checks the relevant flag and
// degrades to a clear "not available in this build" state. As an endpoint lands
// on `main`, flip its flag to true — no panel rewrite required.
export const API_FEATURES = {
  listSpecsGlobal: false, // GET /specs (intentionally never added — use scoped listing)
  libraries: true, // GET /libraries, GET /libraries/:id/specs            (landed #227)
  libraryWrites: true, // POST /libraries/clients, PATCH /libraries/:id        (landed #233)
  projectsList: true, // GET /projects                                       (landed #229)
  projectSettings: true, // PATCH /projects/:id {name}                          (landed)
  projectSources: true, // PUT /projects/:id/sources                            (landed #235)
  specDelete: false, // DELETE /specs/:id                                   (Phase 4)
  paragraphDelete: false, // DELETE /specs/:id/paragraphs/:nodeId               (Phase 4, hard delete)
  paragraphRemoval: true, // PATCH /specs/:id/paragraphs/:nodeId/removal        (landed #251 — soft, reversible)
  paragraphCreate: true, // POST /specs/:id/paragraphs (insert after anchor)      (landed #372)
  openComments: true, // GET /specs|projects/:id/open-comments              (landed #262/#272)
  coordination: true, // coordination-report + required-sections            (landed #239/#241)
  submittalRegister: true, // POST submittal-register + product-driven findings (landed #263)
  impliedRelated: false, // hidden: false-positive inference (single "control" token) — see #327
  umbrellaCallout: true, // umbrella_not_called_out coordination finding (landed #264)
  numberingProfiles: true, // numbering-profile CRUD + DOCX snapshot + ingress (landed #299/#317/#320)
  compareReport: true, // POST /reports/compare — grounded comparison matrix        (landed ADR-047)
  compareAlignment: false, // compare alignment/include request options            (#384 — flip when landed)
};
