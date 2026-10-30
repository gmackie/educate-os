import { check, oneOf, text } from './safety.mjs';
import { TAGS } from './domain.mjs';

/** Generates an explicitly opted-in suggestion from role tags, without accepting private state. */
export async function suggest(input, config = process.env, fetcher = fetch) {
  check(input.allowNetwork === true && input.allowExpense === true, 'LLM disabled: explicit --allow-network and --allow-expense are required');
  const endpoint = new URL(text(config.LAUNCH_OPS_LLM_URL, 'LLM chat-completions URL', 1000));
  check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'LLM URL must be HTTPS without credentials or query');
  const model = text(config.LAUNCH_OPS_LLM_MODEL, 'LLM model', 120);
  check(typeof config.LAUNCH_OPS_LLM_KEY === 'string' && config.LAUNCH_OPS_LLM_KEY.length > 0, 'LLM key is required');
  const council = oneOf(input.council, ['educator', 'technical'], 'council');
  check(Array.isArray(input.tags) && input.tags.length <= TAGS.length, 'Invalid role tags');
  const tags = input.tags.map(t => oneOf(t, TAGS, 'role tag'));
  const response = await fetcher(endpoint.href, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.LAUNCH_OPS_LLM_KEY}` },
    body: JSON.stringify({ model, temperature: 0.2, max_tokens: 400, messages: [
      { role: 'system', content: 'Suggest a short advisory invitation paragraph for human review. EducateOS is open source; the core runs in the organization\'s own Cloudflare account. Seek feedback, never purchase intent. Do not claim certifications, outcomes, integrations, district approval, partnerships, compensation or meeting commitments. No tools or actions. No personal data. Return plain text only.' },
      { role: 'user', content: JSON.stringify({ council, publicRoleTags: tags }) },
    ] }),
  });
  check(response.ok, 'LLM provider request failed; no retry was made');
  // Bound streaming size before decoding. Never include provider errors/headers in output.
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; check(size <= 32_000, 'LLM response too large'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return { status: 'untrusted-suggestion-human-review-required', suggestion: text(value.choices?.[0]?.message?.content, 'LLM suggestion', 6000), disclosure: 'Only council and allowlisted tags were transmitted. Provider charges may apply. No contact, ticket, evidence, or private-state content was transmitted.' };
}
