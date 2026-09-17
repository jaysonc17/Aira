import { abortable, createDeadline } from "../cancellation.js";

export interface GenerateRequest {
  signal?: AbortSignal;
  prompt: string;

  maxTokens?: number;

  thinking?: boolean;

  systemPrompt?: string;

  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface AIModel {
  generate(request: GenerateRequest): Promise<string>;
}

interface MLXResponse {
  choices?: Array<{
    message?: {
      role?: string;

      content?: string;

      reasoning?: string;
    };
  }>;
}

export class LocalModel implements AIModel {
  constructor(
    private readonly model: string,

    private readonly baseURL = "http://127.0.0.1:8080/v1",
  ) {}

  async generate(request: GenerateRequest): Promise<string> {
    const deadline = createDeadline(120_000, request.signal);
    try {
      return await abortable(
        () => this.generateResponse({ ...request, signal: deadline.signal }),
        deadline.signal,
      );
    } finally {
      deadline.dispose();
    }
  }

  private async generateResponse(request: GenerateRequest): Promise<string> {
    const prompt = request.thinking
      ? request.prompt
      : `/no_think\n${request.prompt}`;

    const messages = [
      ...(request.systemPrompt
        ? [
            {
              role: "system" as const,

              content: request.systemPrompt,
            },
          ]
        : []),

      ...(request.history ?? []),

      {
        role: "user" as const,

        content: prompt,
      },
    ];

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      ...(request.signal ? { signal: request.signal } : {}),

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: this.model,

        messages,

        max_tokens: request.maxTokens ?? 1000,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `MLX server returned ${response.status}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as MLXResponse;

    return data.choices?.[0]?.message?.content ?? "";
  }
}
