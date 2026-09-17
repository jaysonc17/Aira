import type { Interface } from "node:readline";
import type { ToolInput } from "./tool.js";

export interface ToolApprovalRequest {
  name: string;
  input: ToolInput;
}

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;

export function requestToolApproval(
  rl: Interface,
  request: ToolApprovalRequest,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      rl.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const closed = () => {
      cleanup();
      resolve(false);
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    rl.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      rl.question(
        `\nApprove tool ${JSON.stringify(request.name)} with arguments ${JSON.stringify(request.input)}? Type yes to run: `,
        { signal },
        (answer) => {
          cleanup();
          resolve(answer.trim().toLowerCase() === "yes");
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
