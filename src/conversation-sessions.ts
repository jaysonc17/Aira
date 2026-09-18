import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import type {
  ConversationMemory,
  ConversationSnapshot,
} from "./conversation-memory.js";

const validName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const maximumBytes = 1_048_576;
const validate = new Ajv({ strict: true }).compile({
  type: "object",
  additionalProperties: false,
  required: ["version", "messages"],
  properties: {
    version: { const: 1 },
    messages: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "content", "createdAt"],
        properties: {
          role: { enum: ["user", "assistant"] },
          content: { type: "string" },
          createdAt: { type: "string", minLength: 1 },
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["content", "updatedAt", "summarizedMessageCount"],
      properties: {
        content: { type: "string" },
        updatedAt: { type: "string", minLength: 1 },
        summarizedMessageCount: { type: "integer", minimum: 0 },
      },
    },
  },
});

export class ConversationSessions {
  constructor(private readonly directory = ".aira/sessions") {}

  private path(name: string): string {
    if (!validName.test(name))
      throw new Error(
        "Session names must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.",
      );
    return join(this.directory, `${name}.json`);
  }

  async save(name: string, memory: ConversationMemory): Promise<void> {
    const path = this.path(name);
    const snapshot = memory.snapshot();
    if (!validate(snapshot))
      throw new Error("Conversation cannot be saved: invalid snapshot");
    const content = JSON.stringify(snapshot, null, 2) + "\n";
    if (Buffer.byteLength(content) > maximumBytes)
      throw new Error("Session exceeds the 1 MiB limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.directory, `.save-${randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // Linking publishes a complete file atomically and fails if the name
      // already exists. Rename would silently overwrite an existing session.
      await link(temporaryPath, path);
    } finally {
      // A leftover temporary file is not a listed or loadable session.
      await unlink(temporaryPath).catch((error: unknown) => {
        console.warn("Could not remove temporary session file:", error);
      });
    }
  }

  async load(name: string, memory: ConversationMemory): Promise<void> {
    const snapshot = await this.readSnapshot(name);
    // Only replace active state after reading and validation succeed.
    memory.restore(snapshot);
  }

  async inspect(name: string) {
    const snapshot = await this.readSnapshot(name);
    return {
      name,
      messageCount: snapshot.messages.length,
      messageCharacters: snapshot.messages.reduce(
        (count, message) => count + message.content.length,
        0,
      ),
      summaryCharacters: snapshot.summary?.content.length ?? 0,
      summarizedMessageCount: snapshot.summary?.summarizedMessageCount ?? 0,
      lastMessageAt: snapshot.messages.at(-1)?.createdAt ?? null,
    };
  }

  private async readSnapshot(name: string): Promise<ConversationSnapshot> {
    const file = await open(this.path(name), "r");
    let content: string;
    try {
      if ((await file.stat()).size > maximumBytes)
        throw new Error("Session exceeds the 1 MiB limit");
      content = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const snapshot: unknown = JSON.parse(content);
    if (!validate(snapshot))
      throw new Error("Invalid or unsupported conversation session");
    return snapshot as ConversationSnapshot;
  }

  async delete(name: string): Promise<boolean> {
    const path = this.path(name);
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.directory, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".json") &&
            validName.test(entry.name.slice(0, -5)),
        )
        .map((entry) => entry.name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export async function handleSessionCommand(
  input: string,
  sessions: ConversationSessions,
  memory: ConversationMemory,
): Promise<string | null> {
  if (!/^\/session(?:\s|$)/.test(input)) return null;
  const [, action, name, ...extra] = input.split(/\s+/);
  if (action === "list" && !name) {
    const names = await sessions.list();
    return names.length
      ? `Saved conversations:\n${names.join("\n")}`
      : "No saved conversations.";
  }
  if (action === "delete" && name && !extra.length) {
    return (await sessions.delete(name))
      ? `Deleted saved conversation: ${name}. Active chat and long-term memory are unchanged.`
      : `Saved conversation not found: ${name}.`;
  }
  if (action === "inspect" && name && !extra.length) {
    const info = await sessions.inspect(name);
    return [
      `Session: ${info.name}`,
      `Recent messages: ${info.messageCount} (${info.messageCharacters} characters)`,
      `Summary: ${info.summaryCharacters} characters covering ${info.summarizedMessageCount} earlier messages`,
      `Last message: ${info.lastMessageAt ?? "none"}`,
      "Active conversation unchanged. Use /session load <name> to resume.",
    ].join("\n");
  }
  if (name && !extra.length && (action === "save" || action === "load")) {
    if (action === "save") {
      await sessions.save(name, memory);
      return `Saved conversation: ${name}.`;
    }
    await sessions.load(name, memory);
    return `Loaded conversation: ${name}. Active chat context replaced; long-term memory is unchanged.`;
  }
  return "Usage: /session list | /session inspect <name> | /session save <name> | /session load <name> | /session delete <name>";
}
