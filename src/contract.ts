export interface GatewayTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: { readonly readOnlyHint: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
}

/** One call the model made to a gateway tool, as the session's harness passed it on. */
export interface GatewayCall {
  readonly tool: string;
  readonly arguments: unknown;
}

/** One piece of a gateway call's result, as MCP gives it: text, or a base64 image. */
export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** A gateway call's result. */
export interface ToolReply {
  readonly success: boolean;
  readonly content: readonly ToolContent[];
}


export interface DirectoryApprovalRequest {
  readonly root: string;
  readonly directory: string;
  readonly access: 'read-only' | 'full';
  readonly reason: string;
}
/** Trusted transport context, never populated from model-supplied tool arguments. */
export interface ToolCallContext {
  readonly signal?: AbortSignal;
  readonly requestDirectoryApproval?: (request: DirectoryApprovalRequest) => Promise<boolean>;
}

export interface BuiltInTool {
  readonly tool: GatewayTool;
  /** Answers one call by the tool's own rules; a refusal is a `success: false` reply. */
  call(args: Readonly<Record<string, unknown>>, context?: ToolCallContext): Promise<ToolReply>;
  /** Ends what it still has running, as the session ends; nothing by default. */
  close?(): Promise<void>;
}
