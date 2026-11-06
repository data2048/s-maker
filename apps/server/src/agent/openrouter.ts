// Client for OpenRouter's OpenAI-compatible API. The URL is fixed by configuration, never by user input.
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask for a JSON object as the answer. */
  json?: boolean;
  signal?: AbortSignal;
  /** Stream the answer: called with all the text so far, each time more arrives. */
  onText?(textSoFar: string): void;
}

/** What a provider reports about a response. Only counts: the text of a model's thinking is never read. */
export interface ResponseInfo {
  promptTokens: number;
  completionTokens: number;
  /** Null when the provider does not say. */
  reasoningTokens: number | null;
  cachedTokens: number | null;
  finishReason: string | null;
}

export interface ChatResult extends ResponseInfo {
  content: string;
  model: string;
  costUsd: number;
}

export interface LlmClient {
  readonly enabled: boolean;
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Model ids that exist right now. */
  listModels(): Promise<string[]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    /** True when another attempt or another model may help. */
    public readonly retryable: boolean,
    /** What the failed attempts cost: a model can charge for an answer it never finished. */
    public readonly costUsd: number = 0,
    /** About the last response, if there was one: why an answer came back empty, for example. */
    public readonly info: ResponseInfo | null = null,
    /** The provider's own words, for the admin's log. */
    public readonly providerMessage: string | null = null,
  ) {
    super(message);
  }
}

interface ChatResponse {
  error?: { message?: string; code?: number };
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: Usage;
}

/** Reads a server-sent stream into the same shape as a plain response. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<ChatResponse> {
  const out: ChatResponse = {};
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;
  const handle = (line: string) => {
    // Other lines are comments that keep the connection open.
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let chunk: ChatResponse & {
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
    };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
    if (chunk.error) out.error = chunk.error;
    if (chunk.model) out.model = chunk.model;
    if (chunk.usage) out.usage = chunk.usage;
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      content += delta;
      onText(content);
    }
  };
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handle);
  }
  handle(buffer);
  out.choices = [{ message: { content }, finish_reason: finishReason }];
  return out;
}

const TIMEOUT_MS = 150_000;
const RETRIES = 2;

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Without a reported cost, count a high price so that the limits stay on the safe side. */
const costOf = (usage: Usage | undefined): number =>
  usage
    ? (usage.cost ?? ((usage.prompt_tokens ?? 0) * 2 + (usage.completion_tokens ?? 0) * 10) / 1_000_000)
    : 0;

const infoOf = (data: ChatResponse): ResponseInfo => ({
  promptTokens: data.usage?.prompt_tokens ?? 0,
  completionTokens: data.usage?.completion_tokens ?? 0,
  reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
  finishReason: data.choices?.[0]?.finish_reason ?? null,
});

export function createOpenRouterClient(opts: {
  apiKey: string | undefined;
  baseUrl: string;
  publicUrl: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): LlmClient {
  const doFetch = opts.fetch ?? fetch;
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${opts.apiKey ?? ''}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': opts.publicUrl,
    'X-Title': 's-maker',
  });

  return {
    enabled: !!opts.apiKey,

    async chat(req) {
      if (!opts.apiKey) throw new LlmError('The agent is not configured on this server', false);
      let last: LlmError | null = null;
      let spent = 0;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 1500) * attempt));
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await doFetch(`${opts.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: headers(),
            signal,
            body: JSON.stringify({
              model: req.model,
              messages: req.messages,
              max_tokens: req.maxTokens,
              temperature: req.temperature ?? 0.4,
              usage: { include: true },
              // Models may think before answering; we only need the answer.
              reasoning: { exclude: true },
              ...(req.json ? { response_format: { type: 'json_object' } } : {}),
              ...(req.onText ? { stream: true } : {}),
            }),
          });
        } catch (e) {
          if (req.signal?.aborted) throw new LlmError('Cancelled', false, spent);
          last = new LlmError(
            e instanceof Error && e.name === 'TimeoutError'
              ? 'The model took too long to answer'
              : 'Could not reach the model provider',
            true,
            spent,
          );
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          last = new LlmError(`The model provider is busy (${res.status})`, true, spent);
          continue;
        }
        if (res.status === 401 || res.status === 403)
          throw new LlmError('The API key was rejected by OpenRouter', false, spent);
        if (res.status === 402) throw new LlmError('The OpenRouter key is out of credit', false, spent);
        if (!res.ok) throw new LlmError(`The model request failed (${res.status})`, true, spent);

        const data: ChatResponse | null =
          req.onText && res.body
            ? await readStream(res.body, req.onText).catch(() => null)
            : await (res.json() as Promise<ChatResponse>).catch(() => null);
        if (req.signal?.aborted) throw new LlmError('Cancelled', false, spent);
        // Paid for even when the answer turns out to be unusable.
        spent += costOf(data?.usage);
        // OpenRouter also reports provider errors with status 200.
        if (!data || data.error) {
          last = new LlmError(
            'The model provider returned an error',
            true,
            spent,
            data ? infoOf(data) : null,
            data?.error?.message?.slice(0, 500) ?? null,
          );
          continue;
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          // Usually the token limit was used up on thinking, before the answer began.
          last = new LlmError('The model returned an empty answer', true, spent, infoOf(data));
          continue;
        }
        return {
          content,
          model: data.model ?? req.model,
          ...infoOf(data),
          costUsd: spent,
        };
      }
      throw last ?? new LlmError('The model request failed', true);
    },

    async listModels() {
      const res = await doFetch(`${opts.baseUrl}/models`, { headers: headers() });
      if (!res.ok) throw new LlmError(`Could not list models (${res.status})`, true);
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    },
  };
}
