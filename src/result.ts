import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SandboxError } from './sandbox.js';
import { ConfigError } from './config.js';

/** Hard ceiling on a single tool payload, so one call cannot flood the model. */
export const MAX_TOOL_CHARS = 60_000;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/**
 * Caps text at `limit` characters on a line boundary and appends a marker the
 * model can act on, instead of silently cutting mid-token.
 */
export function capText(text: string, limit = MAX_TOOL_CHARS): Truncated {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  const lastNewline = head.lastIndexOf('\n');
  const body = lastNewline > limit * 0.5 ? head.slice(0, lastNewline) : head;
  return {
    text: `${body}\n\n[truncated: ${text.length - body.length} of ${text.length} characters omitted; narrow the request with path/line arguments]`,
    truncated: true
  };
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text: capText(text).text }] };
}

export function okJson(data: unknown): CallToolResult {
  return ok(JSON.stringify(data, null, 2));
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Converts a thrown value into a tool error. Sandbox and config failures are
 * expected policy outcomes and are reported verbatim; anything else is an
 * internal fault and keeps its constructor name for diagnosis.
 */
export function failFrom(err: unknown): CallToolResult {
  if (err instanceof SandboxError) return fail(`${err.code}: ${err.message}`);
  if (err instanceof ConfigError) return fail(`CONFIG: ${err.message} (${err.file})`);
  if (err instanceof Error) return fail(`${err.name}: ${err.message}`);
  return fail(`UNKNOWN: ${String(err)}`);
}

/** Wraps a tool handler so no thrown error ever kills the MCP connection. */
export function guard<A>(
  handler: (args: A) => Promise<CallToolResult>
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      return failFrom(err);
    }
  };
}
