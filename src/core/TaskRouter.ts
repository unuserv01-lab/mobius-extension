// TaskRouter — intent -> subagent type (P: workflow step 3).
// Keyword-based first pass (fast, local, no AI call); the Orchestrator can
// ask OnDeviceAI to refine the intent when the keyword pass is ambiguous.
import type { TaskIntent } from './types';

export type SubAgentType = 'reply' | 'summarize' | 'chat';

export class TaskRouter {
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
