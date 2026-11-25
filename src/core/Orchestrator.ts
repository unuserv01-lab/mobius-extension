// Orchestrator — the Core. Runs locally in the service worker (P1).
// Owns: task intake, permission gates, context, routing, subagent lifecycle,
// and the ONLY write path into MemoryStore (P5).
import { DEFAULT_CHAT_RETENTION_SECONDS, DEFAULT_MEMORY_TTL_SECONDS, DEFAULT_TEMP_TTL_SECONDS, STORAGE_KEYS } from '../config/constants';
import { AgentFactory } from '../agent/AgentFactory';
import { AIRouter } from '../ai/AIRouter';
import { ChatHistory } from './ChatHistory';
import { ContextManager } from './ContextManager';
import { loadLanguage, t, tf } from './i18n';
import { MemoryStore } from './MemoryStore';
import { PermissionManager } from './PermissionManager';
import { SkillRunner } from './SkillRunner';
import { TaskRouter } from './TaskRouter';
import { DOM_MUTATING_TOOLS, WebSkillTools } from './WebSkillTools';
import type { Skill } from './Skill';
import type { MobiusSettings, MobiusTask, TaskResult } from './types';

export class Orchestrator {
  private permissions = new PermissionManager();
  private memory = new MemoryStore();
  private chatHistory = new ChatHistory();
  private contextManager = new ContextManager();
  private taskRouter = new TaskRouter();
  private aiRouter = new AIRouter(this.permissions);
  private agentFactory = new AgentFactory(this.aiRouter, this.permissions);

  async getSettings(): Promise<MobiusSettings> {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings] as Partial<MobiusSettings> | undefined;
    return {
      memoryTtlSeconds: stored?.memoryTtlSeconds ?? DEFAULT_MEMORY_TTL_SECONDS,
      tempTtlSeconds: stored?.tempTtlSeconds ?? DEFAULT_TEMP_TTL_SECONDS,
      chatRetentionSeconds: stored?.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS,
    };
  }

  /** Main entry: handle one user task end-to-end (prompt section 6). */
  async handleTask(task: MobiusTask): Promise<TaskResult> {
    await loadLanguage();
    const settings = await this.getSettings();

    // Skills first: a clear keyword match runs deterministically (no LLM).
    const skillMatch = this.taskRouter.matchSkill(task.input);
    if (skillMatch) {
      return this.runSkill(task, skillMatch.match.skill, skillMatch.match.score, skillMatch.params, settings);
    }

    const route = this.taskRouter.route(task.input, task.url);

    // Permission gates (P8) — degrade gracefully, never crash.
    if ((route.intent === 'wa-reply' || route.intent === 'summarize') && !(await this.permissions.isAllowed('readPage'))) {
      return this.fail(task, 'none', this.permissions.denialMessage('readPage'));
    }
    if (route.intent === 'wa-reply' && !(await this.permissions.isAllowed('domActions'))) {
      // Degraded mode: draft is produced but NOT inserted — user copies it manually.
      return this.runWithAgent(task, route.agentType, settings, /* insertIntoPage */ false);
    }

    return this.runWithAgent(task, route.agentType, settings, /* insertIntoPage */ true);
  }

  /** Deterministic skill run (no LLM): navigate the web, read, extract. */
  private async runSkill(
    task: MobiusTask,
    skill: Skill,
    score: number,
    params: Record<string, string>,
    settings: MobiusSettings,
  ): Promise<TaskResult> {
    const started = Date.now();
    const summary = task.input.slice(0, 80).replace(/\s+/g, ' ');
    if (!(await this.permissions.isAllowed('readPage'))) {
      return this.fail(task, 'none', `${t('skillNeedsReadPage')} ${this.permissions.denialMessage('readPage')}`);
    }
    // v8 (audit ChatGPT): a skill that clicks, types or submits mutates the
    // page — it needs domActions. Checked BEFORE any step runs, so a denied
    // skill is refused whole, never run halfway. Navigation (navigate / back /
    // home) is not gated: it only changes which page is shown, never modifies
    // page content or submits anything (see DOM_MUTATING_TOOLS). The shipped
    // shopee/tokopedia skills use no mutating tool, so they are unaffected.
    if (skill.steps.some((s) => DOM_MUTATING_TOOLS.has(s.tool)) && !(await this.permissions.isAllowed('domActions'))) {
      return this.fail(task, 'none', `${t('skillNeedsDomActions')} ${this.permissions.denialMessage('domActions')}`);
    }
    const outcome = await new SkillRunner().run(skill, params, new WebSkillTools());
    const cloudAllowed = await this.permissions.isAllowed('cloudAI');
    await this.aiRouter.log({
      taskId: task.id,
      taskSummary: summary,
      engine: 'skill',
      reason: tf('skillMatched', { skill: skill.name, score }),
      latencyMs: Date.now() - started,
      cloudAllowed,
      payloadSummary: `skill ${skill.id}, ${outcome.steps.length} steps, ${outcome.success ? 'ok' : outcome.partial ? 'partial' : 'failed'}`,
    });
    const text = outcome.success
      ? this.formatSkillResult(skill.name, outcome.vars)
      : tf('skillFailed', { message: outcome.message });
    const result: TaskResult = {
      taskId: task.id,
      ok: outcome.success,
      engine: 'skill',
      text,
      provenance: `Skill: ${skill.name} (deterministic, local)`,
      error: outcome.success ? undefined : outcome.message,
    };
    // Same persistence as agent tasks: chat history + core memory.
    await this.chatHistory.add('user', task.input, settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS);
    await this.chatHistory.add('assistant', text, settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS);
    if (result.ok && (await this.permissions.isAllowed('memory'))) {
      await this.memory.add({
        type: 'task_result',
        content: `${task.input.slice(0, 120)} -> ${text.slice(0, 200)} [skill:${skill.id}]`,
        source: `${task.id}/skill:${skill.id}`,
        ttlSeconds: settings.memoryTtlSeconds,
      });
    }
    return result;
  }

  /** "Shopee price search — sepatu nike\nRp120.000\nRp135.500…" from skill vars. */
  private formatSkillResult(skillName: string, vars: Record<string, string>): string {
    const prices = vars['prices.matches'] ?? vars.prices ?? '';
    const query = vars.query ? ` — ${vars.query}` : '';
    if (prices) {
      const lines = prices.split('\n').filter(Boolean);
      return `${skillName}${query}\n${lines.map((p) => `• ${p}`).join('\n')}`;
    }
    return `${tf('skillDone', { skill: skillName })}${query}`;
  }

  private async runWithAgent(
    task: MobiusTask,
    agentType: 'reply' | 'summarize' | 'chat',
    settings: MobiusSettings,
    insertIntoPage: boolean,
  ): Promise<TaskResult> {
    // Recent task summaries give the agent light local context (no memory sent to cloud).
    const recent = (await this.memory.list()).slice(0, 5).map((e) => e.content);
    const context = await this.contextManager.build(task.tabId, task.pageText, recent);

    const agent = this.agentFactory.create(agentType, task, context, settings.tempTtlSeconds, insertIntoPage);
    let result: TaskResult;
    try {
      result = await agent.run();
    } catch (err) {
      result = this.fail(task, 'none', err instanceof Error ? err.message : String(err));
    } finally {
      // P6: task done = runtime stopped. SubAgent is destroyed here, always.
      agent.destroy();
    }

    // P5: the CORE decides what is stored — the subagent only reported.
    if (result.ok && (await this.permissions.isAllowed('memory'))) {
      await this.memory.add({
        type: 'task_result',
        content: `${task.input.slice(0, 120)} -> ${result.text.slice(0, 200)} [${result.engine}]`,
        source: `${task.id}/${agentType}`,
        ttlSeconds: settings.memoryTtlSeconds,
      });
    }
    // Chat history (v7): the user's own conversation, persisted across
    // side-panel reopen, under the retention setting.
    const retention = settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS;
    await this.chatHistory.add('user', task.input, retention);
    if (result.text) await this.chatHistory.add('assistant', result.text, retention);
    return result;
  }

  private fail(task: MobiusTask, engine: TaskResult['engine'], message: string): TaskResult {
    return {
      taskId: task.id,
      ok: false,
      engine,
      text: '',
      provenance: 'Failed',
      error: message,
    };
  }

  // Exposed for the service worker / side panel.
  getMemoryStore(): MemoryStore {
    return this.memory;
  }
  getChatHistory(): ChatHistory {
    return this.chatHistory;
  }
  getPermissionManager(): PermissionManager {
    return this.permissions;
  }
  getAIRouter(): AIRouter {
    return this.aiRouter;
  }
}
