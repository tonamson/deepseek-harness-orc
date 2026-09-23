import type { Context } from '@deepseek-ai/cordis'

/**
 * ORC Host composition entry.
 *
 * Task 1 establishes the publishable bundle skeleton only: the single Loader
 * row `orc-host` mounts this module. Later tasks add the settings bridge, the
 * provider and CLI adapters, the ORC service, the model-facing tool, and the
 * Remote host from this one entry point.
 */
export function apply(_ctx: Context): void {}
