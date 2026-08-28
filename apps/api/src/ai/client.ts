import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Statisches Modell-Routing (Kapitel 13): welche Aufgabe auf welchem Modell
 * läuft, steht in der Konfiguration – nicht in einer Laufzeitentscheidung.
 * Das macht Kosten und Verhalten vorhersagbar.
 */
export type AiTask = 'drafting' | 'classify';

function modelFor(task: AiTask): string {
  return task === 'drafting' ? config.AI_MODEL_DRAFTING : config.AI_MODEL_CLASSIFY;
}

export interface CompletionOptions {
  task: AiTask;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class AiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AiError';
  }
}

export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  const model = modelFor(options.task);
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: options.maxTokens ?? 1500,
      temperature: options.temperature ?? 0.4,
      system: options.system,
      messages: [{ role: 'user', content: options.user }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) throw new AiError('Das Modell hat keinen Text zurückgegeben');

    return {
      text,
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    logger.error({ err, model, task: options.task }, 'KI-Aufruf fehlgeschlagen');
    throw err instanceof AiError ? err : new AiError('KI-Aufruf fehlgeschlagen', err);
  }
}

/**
 * Fordert eine JSON-Antwort an und parst sie robust.
 * Modelle setzen gelegentlich einen Codeblock drumherum – das wird toleriert,
 * statt den ganzen Aufruf daran scheitern zu lassen.
 */
export async function completeJson<T>(options: CompletionOptions): Promise<{ data: T; model: string }> {
  const result = await complete({
    ...options,
    system: `${options.system}\n\nAntworte ausschließlich mit gültigem JSON, ohne erklärenden Text davor oder danach.`,
  });

  const cleaned = result.text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return { data: JSON.parse(cleaned) as T, model: result.model };
  } catch {
    // Zweiter Versuch: das äußerste JSON-Objekt aus dem Text herausschneiden.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { data: JSON.parse(cleaned.slice(start, end + 1)) as T, model: result.model };
      } catch {
        /* fällt unten durch */
      }
    }
    throw new AiError(`Antwort war kein gültiges JSON: ${cleaned.slice(0, 200)}`);
  }
}
