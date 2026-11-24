// TaskRouter — intent -> subagent type (P: workflow step 3).
// Keyword-based first pass (fast, local, no AI call); the Orchestrator can
// ask OnDeviceAI to refine the intent when the keyword pass is ambiguous.
// Skills are matched FIRST (same keyword scoring as Android SkillRegistry):
// a clear skill match runs deterministically, no LLM involved.
import { SkillRegistry, type SkillMatch } from './SkillRegistry';
import type { TaskIntent } from './types';

export type SubAgentType = 'reply' | 'summarize' | 'chat';

const FILLER_WORDS = [
  'tolong', 'mohon', 'cari', 'cek', 'carikan', 'tolong cari', 'tolong cek',
  'di', 'untuk', 'harga', 'harganya', 'berapa', 'dong', 'ya', 'saja', 'aja',
  'please', 'find', 'check', 'search', 'for', 'the', 'price', 'of',
];

/** Strip trigger phrases + filler words; what is left is the skill's query. */
function extractQuery(input: string, skillTriggers: string[]): string | null {
  let text = ` ${input.toLowerCase().trim()} `;
  const triggers = [...skillTriggers].sort((a, b) => b.length - a.length);
  for (const trigger of triggers) {
    text = text.split(trigger.toLowerCase()).join(' ');
  }
  let query = text.replace(/[?,!.]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const filler of FILLER_WORDS) {
    const re = new RegExp(`^(${filler}\\s+)+`, 'i');
    query = query.replace(re, '').trim();
  }
  // Trailing fillers left after trigger removal ("sepatu nike di shopee" -> "sepatu nike di").
  for (const filler of ['di', 'dong', 'ya', 'saja', 'aja', 'please']) {
    const re = new RegExp(`(\\s+${filler})+$`, 'i');
    query = query.replace(re, '').trim();
  }
  return query.length >= 2 ? query : null;
}

export class TaskRouter {
  private skills = new SkillRegistry();

  /** Keyword skill match + extracted params. Null = no clear match (LLM fallback). */
  matchSkill(input: string): { match: SkillMatch; params: Record<string, string> } | null {
    const match = this.skills.match(input);
    if (!match) return null;
    const query = extractQuery(input, match.skill.triggers);
    if (!query) return null;
    const params: Record<string, string> = {};
    const required = match.skill.params.find((p) => p.required);
    if (required) params[required.name] = query;
    return { match, params };
  }

  route(input: string, url?: string): { intent: TaskIntent; agentType: SubAgentType; confidence: number } {
    const text = input.toLowerCase().trim();
    const isWhatsApp = (url ?? '').includes('web.whatsapp.com');

    // Explicit WhatsApp reply request, or "reply" on a WhatsApp tab.
    if (/\b(reply|balas|jawab)\b/.test(text) && (isWhatsApp || /\bwhatsapp\b/.test(text))) {
      return { intent: 'wa-reply', agentType: 'reply', confidence: 0.95 };
    }
    if (isWhatsApp && /\b(reply|balas|jawab|draft)\b/.test(text)) {
      return { intent: 'wa-reply', agentType: 'reply', confidence: 0.9 };
    }
    // Summarize the active page.
    if (/\b(summar(y|ise|ize)|ringkas|tl;dr|tldr|intinya|poin penting)\b/.test(text)) {
      return { intent: 'summarize', agentType: 'summarize', confidence: 0.95 };
    }
    // "Summarize this page" implied by being asked about the page.
    if (/\b(this page|halaman ini|artikel ini|page)\b/.test(text)) {
      return { intent: 'summarize', agentType: 'summarize', confidence: 0.8 };
    }
    // Default: free-form chat with page context.
    return { intent: 'chat', agentType: 'chat', confidence: 0.6 };
  }
}
