/**
 * Default agent ID used when a caller does not name one.
 *
 * Set CORTEX_DEFAULT_AGENT_ID in your environment to pick your own agent's ID.
 * Read at call time so values loaded by dotenv are honored.
 */
export function defaultAgentId(): string {
  const fromEnv = process.env.CORTEX_DEFAULT_AGENT_ID?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "default";
}
