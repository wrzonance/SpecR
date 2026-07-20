import { z } from 'zod';

const ContentVersionAnchorSchema = z.preprocess((value) => {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  return value;
}, z.number().int().min(1));

/** A stored-state anchor accepted by both REST query strings and MCP input. */
export const HistoryAnchorSchema = z.union([
  z.enum(['origin', 'current']),
  z.uuid(),
  ContentVersionAnchorSchema,
]);

export type HistoryAnchorInput = z.infer<typeof HistoryAnchorSchema>;
