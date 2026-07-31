// examples/web_ui_demo/report-handler.mjs
// POST /report (#353): streams the agent's tool-calling steps live as
// newline-delimited JSON (one object per line: step | usage | done | error).
// Reuses the same MCP + LLM plumbing as /chat, but hands the model only
// read-only tools — see report-bridge.mjs's runReport for the loop itself.
import { runReport } from './report-bridge.mjs';
import { createSession } from './providers/index.mjs';
import { readBoundedBody } from './http-utils.mjs';

function reportEmitter(res) {
  return (obj) => res.write(`${JSON.stringify(obj)}\n`);
}

function parseReportRequest(payload, maxRequestChars) {
  const request = payload?.request;
  if (typeof request !== 'string' || request.trim() === '')
    return { error: 'request text required' };
  if (request.length > maxRequestChars) return { error: 'request too long' };
  const rawLabel = payload?.scope?.label;
  const scope =
    typeof rawLabel === 'string' && rawLabel.trim() !== '' ? { label: rawLabel } : undefined;
  return { request, scope };
}

// Read + JSON-parse the bounded request body, or a message for the caller to
// stream back as an `error` event.
async function readReportPayload(req, maxBodyBytes) {
  try {
    const raw = await readBoundedBody(req, maxBodyBytes);
    return { payload: raw ? JSON.parse(raw.toString('utf8')) : null };
  } catch (err) {
    return {
      error: err?.code === 'BODY_TOO_LARGE' ? 'request body too large' : 'invalid JSON body',
    };
  }
}

// `provider` is one PROVIDERS entry and `bridge` is the createMcpBridge(apiBase)
// result, both resolved once at boot in server.mjs and injected here.
export function createReportHandler({ provider, bridge, limits, maxBodyBytes, maxRequestChars }) {
  return async function handleReport(req, res) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = reportEmitter(res);
    if (!provider.hasKey) {
      emit({
        type: 'error',
        code: 'no-key',
        error: `${provider.keyName} not configured on the demo server`,
      });
      res.end();
      return;
    }
    const { payload, error: bodyError } = await readReportPayload(req, maxBodyBytes);
    if (bodyError) {
      emit({ type: 'error', error: bodyError });
      res.end();
      return;
    }
    const { request, scope, error } = parseReportRequest(payload, maxRequestChars);
    if (error) {
      emit({ type: 'error', error });
      res.end();
      return;
    }
    try {
      const result = await runReport({
        request,
        scope,
        emit,
        limits,
        deps: {
          listTools: bridge.listMcpTools,
          createSession: (opts) =>
            createSession({ ...opts, provider: provider.name, config: provider.config }),
          execTool: bridge.execToolCall,
        },
      });
      emit({ type: 'done', ...result, provider: provider.name, model: provider.model });
    } catch (err) {
      emit({ type: 'error', error: `report failed: ${err.message}` });
    } finally {
      res.end();
    }
  };
}
