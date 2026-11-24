// SubAgent — temporary worker (P2). Created per task, destroyed when done.
// A SubAgent gathers context, calls the AIRouter, performs DOM work through
// the content script, and REPORTS the result to the Core. It never writes
// MemoryStore directly (P5) and never outlives its task (P6).
import type { AIRouter } from '../ai/AIRouter';
import type { PermissionManager } from '../core/PermissionManager';
import type { TaskContext } from '../core/ContextManager';
import type { MobiusTask, TaskResult } from '../core/types';
import { PromptBuilder } from '../ai/PromptBuilder';
import { AgentScope } from './AgentScope';

export type SubAgentKind = 'reply' | 'summarize' | 'chat';

export class SubAgent {
  readonly id: string;
  readonly kind: SubAgentKind;
  private scope: AgentScope;
  private aiRouter: AIRouter;
  private permissions: PermissionManager;
  private task: MobiusTask;
  private context: TaskContext;
  private insertIntoPage: boolean;
  private destroyed = false;

  constructor(
    kind: SubAgentKind,
    task: MobiusTask,
    context: TaskContext,
    aiRouter: AIRouter,
    permissions: PermissionManager,
    tempTtlSeconds: number,
    insertIntoPage: boolean,
  ) {
    this.id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.kind = kind;
    this.task = task;
    this.context = context;
    this.aiRouter = aiRouter;
    this.permissions = permissions;
    this.insertIntoPage = insertIntoPage;
    this.scope = new AgentScope(tempTtlSeconds);
  }

  async run(): Promise<TaskResult> {
    const signal = this.scope.start();
    try {
      if (this.kind === 'reply') return await this.runReply(signal);
      if (this.kind === 'summarize') return await this.runSummarize(signal);
      return await this.runChat(signal);
    } finally {
      // Always clean up even on error — no lingering workers (P6).
      this.scope.cleanup();
    }
  }

  /** MVP flow (a): WhatsApp Web smart reply. */
  private async runReply(signal: AbortSignal): Promise<TaskResult> {
    const tabId = this.context.tabId;
    if (typeof tabId !== 'number') {
      return this.fail('No active tab — open WhatsApp Web and try again.');
    }
    // 1. Read the last incoming message via the content script (DomReader).
    const last = await this.sendToTab(tabId, { type: 'MOBIUS_READ_WA' });
    if (!last?.ok || !last.text) {
      return this.fail(
        last?.error ?? 'Could not read a message on this tab. Make sure a WhatsApp Web chat is open and "Read Page / DOM Context" is enabled.',
      );
    }
    this.scope.tempStore.set('lastMessage', last.text);
    if (signal.aborted) return this.fail('Task aborted.');

    // 2. Draft the reply on-device first (AIRouter decides, cloud only if allowed).
    const prompt = PromptBuilder.whatsappReply(last.text, last.sender, this.task.input);
    const gen = await this.aiRouter.generate(this.task.id, prompt, { needsHeavyReasoning: false, pageTextChars: last.text.length });
    if (!gen.ok) return this.fail(gen.error ?? 'AI generation failed.');
    const draft = gen.text.trim();
    this.scope.tempStore.set('draft', draft);

    // 3. Insert the draft into the WhatsApp input (or show it for manual copy).
    let inserted = false;
    if (this.insertIntoPage && (await this.permissions.isAllowed('domActions'))) {
      const res = await this.sendToTab(tabId, { type: 'MOBIUS_INSERT_REPLY', text: draft });
      inserted = Boolean(res?.ok);
    }
    const engineLabel =
      gen.engine === 'cloud'
        ? 'via Cloud Gemini'
        : gen.engine === 'local-server'
          ? 'via local server'
          : gen.engine === 'local-fallback'
            ? 'via local extractive fallback'
            : 'Locally via Gemini Nano';
    return {
      taskId: this.task.id,
      ok: true,
      engine: gen.engine,
      text: draft,
      provenance: inserted
        ? `Done (Processed ${engineLabel}) — draft inserted into WhatsApp Web`
        : `Done (Processed ${engineLabel}) — draft ready, copy it manually (DOM actions are OFF)`,
    };
  }

  /** MVP flow (b): active-page summarizer. */
  private async runSummarize(signal: AbortSignal): Promise<TaskResult> {
    const tabId = this.context.tabId;
    let pageText = this.context.pageText ?? this.task.pageText;
    if (!pageText && typeof tabId === 'number') {
      const res = await this.sendToTab(tabId, { type: 'MOBIUS_READ_PAGE' });
      if (res?.ok && res.text) pageText = res.text;
    }
    if (!pageText) {
      return this.fail('Could not read this page. Enable "Read Page / DOM Context" in Settings and reload the page.');
    }
    if (signal.aborted) return this.fail('Task aborted.');
    this.scope.tempStore.set('pageText', pageText);

    const prompt = PromptBuilder.summarize(pageText, this.context.url, this.task.input);
    const gen = await this.aiRouter.generate(this.task.id, prompt, {
      needsHeavyReasoning: pageText.length > 2000,
      pageTextChars: pageText.length,
    });
    if (!gen.ok) return this.fail(gen.error ?? 'AI generation failed.');
    return {
      taskId: this.task.id,
      ok: true,
      engine: gen.engine,
      text: gen.text.trim(),
      provenance: `Summary (${gen.engine === 'cloud' ? 'Cloud Gemini' : gen.engine === 'on-device' ? 'Gemini Nano on-device' : gen.engine === 'local-server' ? 'local server' : 'local extractive fallback'})`,
    };
  }

  /** Free-form chat with the current page as context. */
  private async runChat(signal: AbortSignal): Promise<TaskResult> {
    const prompt = PromptBuilder.chat(this.task.input, this.context);
    const gen = await this.aiRouter.generate(this.task.id, prompt, { needsHeavyReasoning: false, pageTextChars: 0 });
    if (signal.aborted) return this.fail('Task aborted.');
    if (!gen.ok) return this.fail(gen.error ?? 'AI generation failed.');
    return {
      taskId: this.task.id,
      ok: true,
      engine: gen.engine,
      text: gen.text.trim(),
      provenance: `Answered (${gen.engine === 'cloud' ? 'Cloud Gemini' : gen.engine === 'on-device' ? 'Gemini Nano on-device' : gen.engine === 'local-server' ? 'local server' : 'local extractive fallback'})`,
    };
  }

  /** P6: destroy the worker — abort + wipe temp data. Called by the Orchestrator. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scope.cleanup();
  }

  private async sendToTab(tabId: number, message: Record<string, unknown>): Promise<{ ok: boolean; text?: string; sender?: string; error?: string } | undefined> {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as { ok: boolean; text?: string; sender?: string; error?: string };
    } catch {
      return { ok: false, error: 'Content script did not respond (reload the tab and try again).' };
    }
  }

  private fail(message: string): TaskResult {
    return { taskId: this.task.id, ok: false, engine: 'none', text: '', provenance: 'Failed', error: message };
  }
}
