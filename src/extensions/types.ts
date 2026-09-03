import type { ToolDefinition } from "../tools/types.js";

/**
 * A tool that only exists when specific extensions are installed in the shop.
 * The core server stays vendor neutral: nothing here is registered, described or mentioned
 * unless the shop actually has the matching extension active.
 */
export interface ExtensionTool {
  /** Technical plugin names that must all be installed and active. */
  requires: string[];
  tool: ToolDefinition;
}

/** One vendor's set of plugin-aware tools. */
export interface ExtensionPack {
  /** Stable id, used in logs and generated docs. */
  id: string;
  label: string;
  /** Where the extensions come from, shown in the generated docs. */
  url: string;
  tools: ExtensionTool[];
}
