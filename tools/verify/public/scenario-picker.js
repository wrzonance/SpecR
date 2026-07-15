// Header/footer fixture scenario picker (#305 task 7/7, decision 9's
// cuttable UI). A thin sibling to harness.js: POSTs a scenarioId to
// POST /api/header-footer-fixtures, then reuses harness.js's own
// window.__pollRun / window.__resetPaneState (same RunStore, same GET
// /api/runs/:runId poll loop, same pane-loading/diff-loading logic) rather
// than duplicating any of it. Kept as its own small file, not appended to
// harness.js, so the two entry points (main upload form vs. catalog fixture
// picker) stay independently readable — see CLAUDE.md's "many small files"
// convention.
(function () {
  'use strict';

  // Mirrors fixtures/header-footer-scenarios.ts's HEADER_FOOTER_SCENARIOS
  // ids exactly — this page has no endpoint to fetch the catalog from, so
  // the 5 ids are hardcoded here, same posture as harness.js's own
  // hardcoded viewportWidth mirror.
  var SCENARIO_IDS = ['default', 'first', 'even', 'fields', 'restartPerSpec'];

  function populateOptions(select) {
    SCENARIO_IDS.forEach(function (id) {
      var option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    });
  }

  function handleStartScenario() {
    var select = document.getElementById('scenario-select');
    var scenarioId = select.value;
    window.__resetPaneState();
    fetch('/api/header-footer-fixtures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: scenarioId }),
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        if (!body.success) throw new Error(body.error || 'failed to start scenario run');
        window.__pollRun(body.data.runId);
      })
      .catch(function (err) {
        document.getElementById('run-status').textContent =
          'failed to start scenario run: ' + String((err && err.message) || err);
      });
  }

  var select = document.getElementById('scenario-select');
  if (select) populateOptions(select);
  var button = document.getElementById('start-scenario-button');
  if (button) button.addEventListener('click', handleStartScenario);
})();
