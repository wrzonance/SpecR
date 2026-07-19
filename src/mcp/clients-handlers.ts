import { z } from 'zod';
import {
  createClient,
  listClients,
  getClient,
  updateClient,
  ClientLibraryNotFoundError,
} from '../db/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';
import { SectionNumberFormatSchema } from '../lib/section-number.js';

export const ClientIdShape = {
  clientId: z.uuid().describe('Client UUID (from list_clients)'),
};
const ClientIdArgs = z.object(ClientIdShape);

export const UpdateClientShape = {
  ...ClientIdShape,
  sectionNumberFormat: SectionNumberFormatSchema.describe(
    'Firm-tier default used when a project has no section-number-format override'
  ),
};
const UpdateClientArgs = z.object(UpdateClientShape);

export const CreateClientShape = {
  name: z.string().min(1).describe('Client name (unique)'),
  libraryId: z
    .uuid()
    .optional()
    .describe("Optional link to the client's client-tier master library"),
  sectionNumberFormat: SectionNumberFormatSchema.optional().describe(
    'Firm-tier default (defaults to canonical)'
  ),
};
const CreateClientArgs = z.object(CreateClientShape);

const NAME_TAKEN_ERROR = 'a client with that name already exists';

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListClients(): Promise<ToolResult> {
  try {
    return ok(await listClients());
  } catch (err) {
    return internalError(err, 'list_clients');
  }
}

export async function handleGetClient(args: unknown): Promise<ToolResult> {
  const parsed = ClientIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid get_client input: clientId must be a UUID');
  try {
    const client = await getClient(parsed.data.clientId);
    if (!client) return toolError(`client not found: id=${parsed.data.clientId}`);
    return ok(client);
  } catch (err) {
    return internalError(err, 'get_client');
  }
}

export async function handleCreateClient(args: unknown): Promise<ToolResult> {
  const parsed = CreateClientArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid create_client input: ${issues(parsed.error)}`);
  }
  const { name, libraryId, sectionNumberFormat } = parsed.data;
  const input = {
    name,
    ...(libraryId ? { libraryId } : {}),
    ...(sectionNumberFormat ? { sectionNumberFormat } : {}),
  };
  try {
    return ok(await createClient(input));
  } catch (err) {
    // Client error (bad libraryId) — surface without logging.
    if (err instanceof ClientLibraryNotFoundError) return toolError(err.message);
    if (getPgCode(err) === '23505') return toolError(NAME_TAKEN_ERROR);
    return internalError(err, 'create_client');
  }
}

export async function handleUpdateClient(args: unknown): Promise<ToolResult> {
  const parsed = UpdateClientArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid update_client input: ${issues(parsed.error)}`);
  try {
    const client = await updateClient(parsed.data.clientId, {
      sectionNumberFormat: parsed.data.sectionNumberFormat,
    });
    return client ? ok(client) : toolError(`client not found: id=${parsed.data.clientId}`);
  } catch (err) {
    return internalError(err, 'update_client');
  }
}
