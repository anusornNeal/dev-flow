/**
 * Legacy fresh-process agent launch configuration was retired by DVF-0834.
 * Managed DevFlow executions and external worker synchronization are the only
 * supported execution paths. This module intentionally exposes no launcher API.
 */
export const LEGACY_AGENT_LAUNCH_RETIRED = true as const;
