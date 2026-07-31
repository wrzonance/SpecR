// examples/web_ui_demo/chat-loop.mjs
// The provider-agnostic chat loop. It speaks only the session interface, so it
// works identically on OpenAI and Anthropic and is unit-testable with a fake.

// Collapse duplicate navigation anchors and cap the payload so a broad answer
// cannot flood the UI.
export function dedupeAnchors(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    if (!a || typeof a.section !== 'string' || a.section === '') continue;
    const key = `${a.section}|${a.specId ?? ''}|${a.paragraphId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 50) break;
  }
  return out;
}

export async function runChat({ session, execTool, maxRounds }) {
  const toolCalls = [];
  let focusAnchors = [];

  for (let round = 0; round < maxRounds; round++) {
    const { text, toolCalls: calls } = await session.send();
    if (!calls || calls.length === 0) {
      return { reply: text || '', toolCalls, focus: { anchors: dedupeAnchors(focusAnchors) } };
    }
    const results = [];
    for (const call of calls) {
      const { text: resultText, ok, anchors } = await execTool(call);
      toolCalls.push({ name: call.name, ok });
      if (ok && anchors.length > 0) focusAnchors = anchors; // last enriched answer wins
      results.push({ id: call.id, text: resultText });
    }
    session.addToolResults(results);
  }

  // Round cap reached — force a closing answer with new tool calls suppressed.
  const final = await session.finalize();
  return {
    reply: final.text || 'Reached the tool-call limit.',
    toolCalls,
    focus: { anchors: dedupeAnchors(focusAnchors) },
  };
}
