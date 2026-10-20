/**
 * OpenRouter client: JSON-only responses, temperature 0 and two retries with
 * backoff. Step 2 ships only the typed surface; step 4 implements it.
 */

export interface ModelCall {
  /** OpenRouter model id, for example deepseek/deepseek-v4.1-flash-1017. */
  model: string;
  system: string;
  user: string;
}

export interface ModelOptions {
  /** OPENROUTER_API_KEY. Read from the shell environment by the CLI. */
  apiKey?: string;
  maxOutputTokens?: number;
  /** Retries after the first attempt. Spec default: 2. */
  retries?: number;
}

export interface ModelResult {
  /** Raw JSON text returned by the model. Validated by FindingSchema. */
  raw: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export async function callModel(
  _call: ModelCall,
  _options: ModelOptions = {},
): Promise<ModelResult> {
  throw new Error("callModel is not implemented yet (bugbot step 4)");
}

export function parseJsonResponse(_raw: string): unknown {
  throw new Error("parseJsonResponse is not implemented yet (bugbot step 4)");
}
