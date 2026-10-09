import { z } from "zod";
import type { SessionMemory } from "../memory/session-memory.js";
import { errorResult, textResult, type ToolResult } from "./types.js";

const RememberSchema = z.object({
  text: z.string().min(1).describe("Short fact or note to remember for later turns."),
  topic: z.string().optional().describe("Optional topic label for grouping."),
  tags: z.array(z.string()).optional().describe("Optional tags for search."),
  session: z.string().optional().describe("Optional session id to scope the note."),
});

const RecallSchema = z.object({
  query: z.string().optional().describe("Optional search text. Omit to list recent notes."),
  topic: z.string().optional().describe("Optional topic filter."),
  session: z.string().optional().describe("Optional session filter."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum notes to return (default 10)."),
});

const ForgetSchema = z.object({
  id: z.string().min(1).describe("Note id to delete."),
});

export function createMemoryHandlers({ sessionMemory }: { sessionMemory: SessionMemory }) {
  return {
    async remember(args: unknown): Promise<ToolResult> {
      try {
        const { text, topic, tags, session } = RememberSchema.parse(args);
        const note = sessionMemory.remember(text, { topic, tags, session });
        return textResult(`Remembered (id=${note.id}, topic=${note.topic}, session=${note.session}): ${note.text}`);
      } catch (error) {
        return errorResult(`Failed to remember: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async recall(args: unknown): Promise<ToolResult> {
      const { query, topic, session, limit = 10 } = RecallSchema.parse(args ?? {});
      const filter = { topic, session, limit };
      const notes = query && query.trim()
        ? sessionMemory.search(query, filter)
        : sessionMemory.list(filter);

      const stats = sessionMemory.getStats();
      if (notes.length === 0) {
        return textResult(`No memory notes matched. (${stats.count} notes stored across ${stats.sessions} sessions)`);
      }

      const lines = notes.map((note, index) =>
        `${index + 1}. [${note.id}] (${note.topic}${note.tags.length ? `, ${note.tags.join(",")}` : ""}) ${note.text}`
      );
      return textResult(`Session memory (${stats.count} notes total):\n\n${lines.join("\n")}`);
    },

    async forget(args: unknown): Promise<ToolResult> {
      const { id } = ForgetSchema.parse(args);
      const deleted = sessionMemory.delete(id);
      return {
        content: [{ type: "text", text: deleted ? `Deleted note ${id}` : `No note found with id ${id}` }],
        isError: deleted ? undefined : true,
      };
    },
  };
}
