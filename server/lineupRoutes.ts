// Lineup's own routes (not Tunarr's): saved programming templates and the
// AI programming assistant. They share the proxy's pipeline (method allowlist,
// Origin check, JSON bodies, optional sign-in) but answer from the companion.
import { aiFailure, buildUserMessage, callModel, gatherContext, MAX_PROMPT_CHARS, resolveProposal, SYSTEM_PROMPT, type AiConfig } from './ai.js';
import { validateTemplate } from './templateSchema.js';
import { newTemplateId, StoreError, type TemplateStore } from './templateStore.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { fail, json, UpstreamError } from './upstream.js';

export type LineupRoute =
  | { name: 'templates'; methods: string[] }
  | { name: 'template'; methods: string[]; id: string }
  | { name: 'ai-status'; methods: string[] }
  | { name: 'ai-template'; methods: string[] };

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function matchLineupRoute(path: string): LineupRoute | { invalid: string } | null {
  if (path === '/templates') return { name: 'templates', methods: ['GET', 'POST'] };
  if (path === '/ai') return { name: 'ai-status', methods: ['GET'] };
  if (path === '/ai/template') return { name: 'ai-template', methods: ['POST'] };
  const match = /^\/templates\/([^/]+)$/.exec(path);
  if (match) return TEMPLATE_ID.test(match[1]) ? { name: 'template', methods: ['PUT', 'DELETE'], id: match[1] } : { invalid: 'Template id is not valid.' };
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Context = { config: ProxyConfig; target: TunarrTarget; method: string; body: unknown };

export async function handleLineupRoute(route: LineupRoute, { config, target, method, body }: Context): Promise<ProxyResponse> {
  const store = config.templates as TemplateStore | undefined;
  try {
    switch (route.name) {
      case 'templates': {
        if (!store) return fail(503, 'store_off', 'Saving templates is not available on this server.');
        if (method === 'GET') return json(200, await store.list());
        const checked = validateTemplate({ ...(isObject(body) ? body : {}), id: newTemplateId() });
        if ('error' in checked) return fail(400, 'invalid_template', checked.error);
        return json(201, await store.save(checked.template));
      }
      case 'template': {
        if (!store) return fail(503, 'store_off', 'Saving templates is not available on this server.');
        if (method === 'DELETE') {
          return (await store.remove(route.id)) ? json(200, { deleted: true }) : fail(404, 'not_found', 'That template is not saved.');
        }
        const checked = validateTemplate({ ...(isObject(body) ? body : {}), id: route.id });
        if ('error' in checked) return fail(400, 'invalid_template', checked.error);
        return json(200, await store.save(checked.template));
      }
      case 'ai-status': {
        const ai = config.ai;
        if (!ai || 'off' in ai) return json(200, { enabled: false, message: ai && 'off' in ai ? ai.off : 'AI is not set up on this server.' });
        return json(200, { enabled: true, provider: ai.provider, model: ai.model });
      }
      case 'ai-template': {
        const ai = config.ai;
        if (!ai || 'off' in ai) return fail(503, 'ai_off', ai && 'off' in ai ? ai.off : 'AI is not set up on this server.');
        if (!isObject(body)) return fail(400, 'invalid_request', 'Send { "prompt", "channelId"?, "includeLibrary"?, "baseTemplate"? }.');
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt || prompt.length > MAX_PROMPT_CHARS) return fail(400, 'invalid_request', `Write a prompt (up to ${MAX_PROMPT_CHARS} characters).`);
        if (body.channelId !== undefined && (typeof body.channelId !== 'string' || !CHANNEL_ID.test(body.channelId))) return fail(400, 'invalid_request', 'Channel id is not valid.');
        let base: unknown;
        if (body.baseTemplate !== undefined) {
          const checked = validateTemplate(body.baseTemplate);
          if ('error' in checked) return fail(400, 'invalid_request', `Base template: ${checked.error}`);
          // The model gets the plan only, not saved sources or bookkeeping.
          const plan: Partial<typeof checked.template> = { ...checked.template };
          delete plan.defaults;
          delete plan.custom;
          delete plan.updatedAt;
          base = plan;
        }
        const context = await gatherContext(config, target, { channelId: body.channelId as string | undefined, library: body.includeLibrary !== false });
        const raw = await callModel(ai as AiConfig, SYSTEM_PROMPT, buildUserMessage(prompt, context, base));
        const proposal = resolveProposal(raw, context, newTemplateId('ai'));
        if ('error' in proposal) return fail(502, 'ai_invalid', proposal.error);
        return json(200, proposal);
      }
    }
  } catch (error) {
    if (error instanceof StoreError) return fail(error.status, error.code, error.message);
    if (error instanceof UpstreamError) throw error;
    const failure = aiFailure(error);
    return fail(failure.status, failure.code, failure.message);
  }
}
