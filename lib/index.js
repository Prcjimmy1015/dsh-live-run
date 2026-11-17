/**
 * dsh-live-run — node half.
 *
 * Everything the panel needs is already published by the running client:
 * the session conversation snapshot (tool calls + results), the client jobs
 * service (live command output), and better-sidebar's tab registrar. So this
 * half only carries the Cordis plugin identity; there is no host route, no
 * RPC, and no build step.
 */

/** Stable Cordis plugin name (must match the manifest id). */
export const name = 'dsh-live-run'

/** No host service is required to mount the panel. */
export const inject = []

/**
 * Host plugin body: nothing to wire.
 * The browser half shipped through `exports["./client"]` registers the tab.
 */
export function apply() {}
