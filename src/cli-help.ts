export const CLI_HELP = `Commands:
  /help                     Show this command list.
  /new                      Clear chat history and summary; keep long-term memory.
  /session list             List saved conversations.
  /session inspect <name>    Show saved conversation size without loading it.
  /session save <name>       Save chat and summary under a new name.
  /session load <name>       Replace chat context with a saved conversation.
  /session delete <name>     Delete one saved file; keep active chat and memory.
  /investigate <owner/repo> <question>  Gather bounded repository evidence and answer.
  /plan <owner/repo> <question>  Propose up to three read-only investigation steps.
  /tools                    List available tools and their approval requirements.
  /tools <name>             Show a tool's description and input schema.
  /memories                 Inspect stored long-term memories.
  /memory search <query>    Search long-term memory (may use local models).
  /memory consolidate       Consolidate stored memories.
  /memory rescore           Recalculate memory scores.
  /memory delete <id>        Delete one long-term memory.
  /memory clear             Delete all long-term memories; keep current chat context.
  /exit                     Quit Aira.

Lines starting with / are treated as commands; unknown commands show help guidance.
Commands run between conversation turns. /help makes no model request.
/new starts fresh chat context, but saved long-term memories can still be retrieved.`;
