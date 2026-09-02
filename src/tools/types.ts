import type { ZodRawShape, z } from "zod";
import type { ShopwareClient } from "../client/index.js";
import type { Config } from "../config.js";

export interface ToolContext {
  client: ShopwareClient;
  config: Config;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape, Result = unknown> {
  name: string;
  title: string;
  /** Written for an LLM: what it does, when to use it, what it returns. */
  description: string;
  inputSchema: Shape;
  /** Write tools are only registered when write access is enabled. */
  write: boolean;
  annotations: ToolAnnotations;
  handler(input: z.output<z.ZodObject<Shape>>, ctx: ToolContext): Promise<Result>;
}

interface ToolInit<Shape extends ZodRawShape, Result> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  write?: boolean;
  annotations?: ToolAnnotations;
  handler: (input: z.output<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<Result>;
}

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function defineTool<Shape extends ZodRawShape, Result>(
  init: ToolInit<Shape, Result>,
): ToolDefinition<Shape, Result> {
  const write = init.write ?? false;
  return {
    ...init,
    write,
    annotations: { ...(write ? WRITE_ANNOTATIONS : READ_ANNOTATIONS), ...init.annotations },
  };
}

/** Shape of a dry-run response from every write tool. */
export interface DryRunResult {
  dryRun: true;
  wouldSend: { method: string; url: string; body: unknown };
}
