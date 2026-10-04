export type LlmPurpose = 'decide' | 'classify' | 'compose';

export interface LlmRequest {
  purpose: LlmPurpose;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Coût réel annoncé par le fournisseur, si disponible. */
  costUsd: number | null;
  latencyMs: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Options propres à OpenRouter (coût réel dans la réponse) ; à désactiver pour Groq, Gemini, Ollama. */
  openRouterExtras?: boolean;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/**
 * Client OpenRouter (API de type chat completions). La clé ne quitte jamais l'en-tête
 * Authorization : elle n'apparaît dans aucun message d'erreur.
 */
export class OpenRouterClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          ...(this.opts.openRouterExtras === false ? {} : { 'X-Title': 'Minecraftia' }),
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          ...(this.opts.openRouterExtras === false ? {} : { usage: { include: true } }),
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (err) {
      throw new LlmError(controller.signal.aborted ? 'délai dépassé' : `réseau : ${(err as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
    let body: ChatCompletion;
    try {
      body = (await res.json()) as ChatCompletion;
    } catch {
      throw new LlmError(`réponse illisible (HTTP ${res.status})`, res.status, res.status >= 500);
    }
    if (!res.ok || body.error) {
      throw new LlmError(`HTTP ${res.status} : ${body.error?.message ?? 'erreur'}`, res.status, res.status === 429 || res.status >= 500);
    }
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LlmError('réponse sans contenu', res.status);
    return {
      text,
      model: body.model ?? req.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
      latencyMs: Date.now() - started,
    };
  }
}
