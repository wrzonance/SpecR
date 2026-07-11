import {
  handleListUsers,
  handleGetUser,
  handleResolveUser,
  UserIdShape,
  ResolveUserShape,
} from './users-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerUserTools(reg: ToolRegistrar): void {
  reg.register(
    'list_users',
    {
      description:
        'List users (id, label, createdAt), ordered by label. Source of the userId ' +
        'argument for get_user. ADR-052 D6 — actor identity substrate.',
      inputSchema: {},
    },
    handleListUsers
  );

  reg.register(
    'get_user',
    {
      description: 'Return a single user by UUID. Returns isError when the UUID is not found.',
      inputSchema: UserIdShape,
    },
    handleGetUser
  );

  reg.register(
    'resolve_user',
    {
      description:
        'Resolve a user by exact-match label, creating one if none exists yet (ADR-052 D6). ' +
        'Idempotent — a repeat call with the same label returns the same user.id. label is ' +
        'case-sensitive and not yet authenticated identity (spoofable pre-#43).',
      inputSchema: ResolveUserShape,
    },
    handleResolveUser
  );
}
