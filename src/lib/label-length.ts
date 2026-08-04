/**
 * Shared UNICODE CODE POINT bound for a caller-supplied actor/user label
 * (#642, ADR-091). Lives in `lib/` (not `api/` or `ast/`) because it is
 * imported by three modules that must not depend on each other:
 * `src/api/users.ts` (POST /users), `src/ast/actor-schemas.ts`
 * (`ActorLabelSchema`, reused by six MCP tool shapes), and
 * `src/mcp/users-handlers.ts` (`ResolveUserShape.label`, which does not
 * reuse the REST validator). One constant, three surfaces, no drift.
 */
export const MAX_LABEL_LENGTH = 200;
