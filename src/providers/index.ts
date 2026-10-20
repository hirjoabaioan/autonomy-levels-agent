import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { RuleMockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import type { Provider } from './types.js';

type Env = Record<string, string | undefined>;

export const KEY_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
};

/** Only providers with a key set are created. DeepSeek reuses the OpenAI client with another baseURL. */
export function providersFromEnv(env: Env = process.env): Record<string, Provider> {
  const out: Record<string, Provider> = {};
  if (env.ANTHROPIC_API_KEY) out.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) out.openai = new OpenAIProvider(env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) out.gemini = new GeminiProvider(env.GEMINI_API_KEY);
  if (env.DEEPSEEK_API_KEY) out.deepseek = new OpenAIProvider(env.DEEPSEEK_API_KEY, 'deepseek', 'https://api.deepseek.com');
  return out;
}

/** `provider:model` from LLM, falling back to the built-in mock when unset or the key is missing. */
export function providerFromSpec(spec: string | undefined, env: Env = process.env): { provider: Provider; model: string } {
  const mock = { provider: new RuleMockProvider(), model: 'rule-mock' };
  if (!spec) return mock;
  const i = spec.indexOf(':');
  const name = spec.slice(0, i);
  const provider = providersFromEnv(env)[name];
  if (i < 1 || !provider) {
    console.warn(`LLM="${spec}" is not usable (expected provider:model with ${Object.values(KEY_VARS).join('/')} set); using the mock.`);
    return mock;
  }
  return { provider, model: spec.slice(i + 1) };
}
