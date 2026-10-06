import { assertRequestContext, assertRequestAuthorization, InvocationError, type ExecutionMode, type Permission, type RequestContext } from "./request-context.js";
import type { InvocationAdmission } from "./invocation-admission.js";

export type ToolHandler<T> = (args: unknown, context: RequestContext) => Promise<T>;
export type ToolDefinition<T> = {
  permission: Permission;
  modes: readonly ExecutionMode[];
  handler: ToolHandler<T>;
};

/** Transport-independent authorization/dispatch. Storage handlers must explicitly opt into hosted mode. */
export class ToolDispatcher<T = unknown> {
  private readonly tools: ReadonlyMap<string, Readonly<ToolDefinition<T>>>;

  constructor(tools: Record<string, ToolDefinition<T>>, private readonly options: Readonly<{ admission?: InvocationAdmission }> = {}) {
    this.options = Object.freeze({ ...options });
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
    if (input.mode === "hosted" && !this.options.admission) throw new InvocationError("admission_unavailable");
    const release = input.mode === "hosted" ? await this.options.admission!.acquire(input) : undefined;
    let result: T;
    try {
      await assertRequestAuthorization(input);
      result = await tool.handler(args, input);
      assertRequestContext(input);
    } catch (error) {
      assertRequestContext(input);
      throw error;
    } finally {
      // Aborting the request does not mean its underlying resources have stopped.
      if (release) await release();
    }
    await assertRequestAuthorization(input);
    return result;
  }
}
