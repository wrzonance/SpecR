import {
  handleListClients,
  handleGetClient,
  handleCreateClient,
  ClientIdShape,
  CreateClientShape,
} from './clients-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerClientTools(reg: ToolRegistrar): void {
  reg.register(
    'list_clients',
    {
      description:
        'List clients (id, name, libraryId, timestamps), ordered by name. Source of the ' +
        'clientId argument for get_client and update_project.',
      inputSchema: {},
    },
    handleListClients
  );

  reg.register(
    'get_client',
    {
      description:
        'Return a single client by UUID, including its associated active projects ' +
        '(each a full project summary with sources). Returns isError when the UUID is not found.',
      inputSchema: ClientIdShape,
    },
    handleGetClient
  );

  reg.register(
    'create_client',
    {
      description:
        'Create a client (ADR-054) — an organizational entity that groups projects. name is ' +
        'unique (isError on collision). An optional libraryId links the client to its client-tier ' +
        'master library; an unknown libraryId is an isError. Associate projects via update_project.',
      inputSchema: CreateClientShape,
    },
    handleCreateClient
  );
}
