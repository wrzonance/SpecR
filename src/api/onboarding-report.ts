// The onboarding-report editability summarizer now lives in src/lib so both the
// REST report (this layer) and the MCP get_onboarding_report tool (#140) share one
// implementation without the MCP module reaching into src/api. Re-exported here to
// preserve the existing REST import path.
export { summarizeEditability, LOW_CONFIDENCE_THRESHOLD } from '../lib/editability-summary.js';
