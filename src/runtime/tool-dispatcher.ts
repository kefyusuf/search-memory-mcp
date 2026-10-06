import { assertRequestContext, InvocationError, type ExecutionMode, type Permission, type RequestContext } from "./request-context.js";

export type ToolHandler<T> = (args: unknown, context: RequestContext) => Promise<T>;
export type ToolDefinition<T> = {
  permission: Permission;
  modes: readonly ExecutionMode[];
  handler: ToolHandler<T>;
};

/** Transport-independent authorization/dispatch. Storage handlers must explicitly opt into hosted mode. */
export class ToolDispatcher<T = unknown> {
  private readonly tools: ReadonlyMap<string, Readonly<ToolDefinition<T>>>;

  constructor(tools: Record<string, ToolDefinition<T>>) {
    this.tools = new Map(Object.entries(tools).map(([name, tool]) => [name,
      Object.freeze({ ...tool, modes: Object.freeze([...tool.modes]) }),
    ]));
  }

  async call(name: string, args: unknown, input: unknown): Promise<T> {
    assertRequestContext(input);
    const tool = this.tools.get(name);
    if (!tool) throw new InvocationError("unknown_tool");
    if (!input.permissions.includes(tool.permission)) throw new InvocationError("forbidden");
    if (!tool.modes.includes(input.mode)) throw new InvocationError("execution_mode_unavailable");
    return tool.handler(args, input);
  }
}
