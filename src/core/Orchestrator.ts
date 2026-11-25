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
import type { BrowserAction, BrowserStepResult, BrowserTaskPayload, BrowserTaskResult, MobiusSettings, MobiusTask, TaskResult } from './types';

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

    // Browser takeover (v9): a structured task from the bridge never goes
    // through skill match or LLM routing — it runs deterministically below.
    if (task.browserTask) {
      return this.handleBrowserTask(task, settings);
    }

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

  /**
   * Browser takeover (v9): run a structured task from the phone through
   * WebSkillTools and report back a BrowserTaskResult JSON (as TaskResult
   * text — the pollers post it verbatim to the bridge).
   *
   * APPROVAL PROTOCOL (fail closed): a task whose actions include a mutating
   * tool (clickText / typeText / submit — DOM_MUTATING_TOOLS) does NOT
   * execute AT ALL unless payload.approved === true. Not even the navigation
   * runs. The extension returns status 'awaiting_approval' with a plain
   * description of every held-back action; the phone shows its approval
   * dialog and, if the user agrees, sends a NEW task with the same
   * type/url/actions plus approved=true. The permission gates still apply
   * on top: approved=true with domActions OFF fails honestly.
   *
   * HONESTY: a navigation that fails, an element that is not found, or a
   * read with no matches ends the run at that step with status 'failed' —
   * steps already done are reported, nothing is claimed that did not happen.
   * Only short summaries (never page content) go to the router log.
   */
  private async handleBrowserTask(task: MobiusTask, settings: MobiusSettings): Promise<TaskResult> {
    const started = Date.now();
    const payload = task.browserTask as BrowserTaskPayload;
    const type = payload.type;
    const steps: BrowserStepResult[] = [];
    const tools = new WebSkillTools();
    let collectedText = '';

    const finish = async (result: BrowserTaskResult): Promise<TaskResult> => {
      const summary = `${type}${result.url ? ` — ${result.url}` : ''}: ${result.message}`;
      await this.aiRouter.log({
        taskId: task.id,
        taskSummary: summary.slice(0, 80),
        engine: 'skill',
        reason: `browser ${type}, ${result.steps.length} steps, ${result.status}`,
        latencyMs: Date.now() - started,
        cloudAllowed: await this.permissions.isAllowed('cloudAI'),
        payloadSummary: `browser ${type}, ${result.steps.length} steps, ${result.status}`,
      });
      const retention = settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS;
      await this.chatHistory.add('user', `[browser] ${summary.slice(0, 120)}`, retention);
      await this.chatHistory.add('assistant', result.message.slice(0, 200), retention);
      return {
        taskId: task.id,
        ok: result.status === 'done',
        engine: 'skill',
        text: JSON.stringify(result),
        provenance: 'Browser task (remote, via bridge)',
        error: result.status === 'failed' ? result.error : undefined,
      };
    };

    const fail = (error: string): Promise<TaskResult> =>
      this.activeTabInfo().then(({ url, title }) =>
        finish({ status: 'failed', type, url, title, steps, message: error, error }),
      );

    // --- Validation: fail before touching the browser. ---
    if ((type === 'browser_navigate' || type === 'browser_read') && !payload.url) {
      return finish({ status: 'failed', type, url: '', title: '', steps, message: `${type} needs a url.`, error: `${type} needs a url.` });
    }
    if (type === 'browser_act' && (!payload.actions || payload.actions.length === 0)) {
      return finish({ status: 'failed', type, url: payload.url ?? '', title: '', steps, message: 'browser_act needs at least one action.', error: 'browser_act needs at least one action.' });
    }
    const actions = payload.actions ?? [];

    // --- Approval gate: mutating actions without approved=true run NOTHING. ---
    // (v8.1) Each held-back action carries its tier (submit = sensitive,
    // click/type = moderate) so the phone can decide whether the approval
    // may be remembered, and a stable approvalId so the phone's resubmission
    // can be linked to this hold (see bridge/README.md).
    const mutating = actions.filter((a) => DOM_MUTATING_TOOLS.has(a.tool));
    if (mutating.length > 0 && payload.approved !== true) {
      const pendingActions = mutating.map((a) => ({
        tool: a.tool,
        description: describeBrowserAction(a),
        tier: browserActionTier(a.tool),
      }));
      const what = pendingActions.map((p) => p.description).join('; ');
      const approvalId = crypto.randomUUID();
      // Plain language, no protocol jargon: the phone shows this message
      // verbatim in the approval dialog (ID+EN via i18n).
      const message = payload.url
        ? tf('awaitingApprovalAt', { what, url: payload.url })
        : tf('awaitingApproval', { what });
      return finish({
        status: 'awaiting_approval',
        type,
        url: payload.url ?? '',
        title: '',
        steps,
        pendingActions,
        approvalId,
        message,
      });
    }

    // --- Permission gates (on top of approval). ---
    if (mutating.length > 0 && !(await this.permissions.isAllowed('domActions'))) {
      return fail(`domActions permission is off — ${this.permissions.denialMessage('domActions')}`);
    }
    const readsPage = type === 'browser_read' || actions.some((a) => a.tool === 'readScreen' || a.tool === 'extract' || a.tool === 'findText');
    if (readsPage && !(await this.permissions.isAllowed('readPage'))) {
      return fail(`readPage permission is off — ${this.permissions.denialMessage('readPage')}`);
    }

    // --- Navigate first (when a URL was given). ---
    if (payload.url) {
      const nav = await tools.call('navigate', { url: payload.url });
      steps.push({ tool: 'navigate', ok: nav.success, message: nav.message });
      if (!nav.success) return fail(`Could not open ${payload.url}: ${nav.message}`);
    }

    // --- Run the steps. browser_read always reads the page; browser_act runs
    // its actions in order and stops at the first failed step. ---
    const runList: BrowserAction[] = type === 'browser_read' ? [{ tool: 'readScreen', limit: '200' }, ...actions] : actions;
    for (const action of runList) {
      if (type === 'browser_navigate') break;
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(action)) {
        if (k === 'tool' || v === undefined) continue;
        args[k] = String(v);
      }
      const out = await tools.call(action.tool, args);
      steps.push({ tool: action.tool, ok: out.success, message: out.message });
      if (out.data?.text) collectedText += `${out.data.text}\n`;
      if (out.data?.matches) collectedText += `${out.data.matches}\n`;
      if (!out.success) {
        return fail(`Step '${action.tool}' failed: ${out.message}`);
      }
    }

    const { url, title } = await this.activeTabInfo();
    const doneCount = steps.filter((s) => s.ok).length;
    return finish({
      status: 'done',
      type,
      url,
      title,
      steps,
      text: collectedText ? collectedText.slice(0, 2000) : undefined,
      message:
        type === 'browser_navigate'
          ? `Opened ${url}${title ? ` — ${title}` : ''}.`
          : `${type} selesai: ${doneCount}/${steps.length} langkah OK${title ? ` — ${title}` : ''}.`,
    });
  }

  /** URL + title of the active tab ('' when there is no tab — never throws). */
  private async activeTabInfo(): Promise<{ url: string; title: string }> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      return { url: tab?.url ?? '', title: tab?.title ?? '' };
    } catch {
      return { url: '', title: '' };
    }
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

/** Risk tier of one browser action (v8.1 — mirrors ActionGate on Android).
 * submit sends something: sensitive, always ask, never remember forever.
 * clickText / typeText / whatsappOpenChat change state reversibly: moderate,
 * the phone MAY remember the approval. Reads never reach this function. */
function browserActionTier(tool: string): 'moderate' | 'sensitive' {
  return tool === 'submit' ? 'sensitive' : 'moderate';
}

/** Plain-language description of one action, for the approval dialog on the
 * phone (pendingActions[].description). Values are capped at 80 chars so the
 * awaiting_approval result stays small; the phone already holds the full
 * task, this is only what the user reads before approving. ID+EN via i18n. */
function describeBrowserAction(action: BrowserAction): string {
  const cap = (v: unknown): string => {
    const s = String(v ?? '');
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  };
  switch (action.tool) {
    case 'clickText':
      return tf('actClickText', { text: cap(action.text) });
    case 'typeText':
      return tf('actTypeText', { text: cap(action.text) });
    case 'submit':
      return t('actSubmit');
    case 'navigate':
      return tf('actNavigate', { url: cap(action.url) });
    case 'scroll':
      return t('actScroll');
    case 'back':
      return t('actBack');
    case 'home':
      return t('actHome');
    default:
      return action.tool;
  }
}
