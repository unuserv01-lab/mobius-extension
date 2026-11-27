// Orchestrator — the Core. Runs locally in the service worker (P1).
// Owns: task intake, permission gates, context, routing, subagent lifecycle,
// and the ONLY write path into MemoryStore (P5).
import { DEFAULT_CHAT_RETENTION_SECONDS, DEFAULT_MEMORY_TTL_SECONDS, DEFAULT_TEMP_TTL_SECONDS, STORAGE_KEYS } from '../config/constants';
import { BRIDGE_HEARTBEAT_INTERVAL_MS, postTaskHeartbeat } from './BridgeClient';
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
   * type/url/actions plus approved=true. (v9.1) approved=true alone proves
   * nothing: the resubmission must also echo the approvalId from the hold,
   * which the extension verifies against chrome.storage.session — same
   * payload fingerprint, unexpired (10 min), and consumed (deleted) before
   * execution, so one approval can never run twice. A forged or replayed
   * approval fails with 'approval tidak valid atau sudah dipakai' and runs
   * zero actions. The permission gates still apply on top: approved=true
   * with domActions OFF fails honestly.
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

    // Heartbeat (best-effort): while this task runs, extend the bridge lease
    // every 20 s so a long task is not requeued mid-flight. Stopped in
    // finish(), i.e. as soon as the result exists (the poller posts it right
    // after this returns). A heartbeat failure never fails the task.
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    heartbeatTimer = setInterval(() => {
      void postTaskHeartbeat(task.id);
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);

    const finish = async (result: BrowserTaskResult): Promise<TaskResult> => {
      stopHeartbeat();
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
      // Single-use approval (v9.1, fail closed): the id is only useful
      // because it is recorded here with the fingerprint of the exact
      // payload. The phone's resubmission must echo this id AND the same
      // type/url/actions; anything else is rejected without running a
      // single action. If the record itself cannot be stored, there is no
      // approval to honour — fail instead of handing out a useless id.
      try {
        await storeApproval(approvalId, computeBrowserTaskFingerprint(payload));
      } catch {
        return finish({
          status: 'failed',
          type,
          url: payload.url ?? '',
          title: '',
          steps,
          message: 'Gagal menyimpan persetujuan, coba lagi.',
          error: 'Gagal menyimpan persetujuan, coba lagi.',
        });
      }
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

    // --- Approved resubmission (v9.1): approved=true alone proves nothing.
    // The echoed approvalId must exist in storage.session, be unexpired,
    // and fingerprint this exact payload. consumeApproval() deletes the
    // entry BEFORE any execution below, so the same approval can never run
    // twice. Any failure here runs ZERO actions: no navigation, no click,
    // no typing — the task ends right here.
    if (mutating.length > 0 && payload.approved === true) {
      const ok = await consumeApproval(payload.approvalId, computeBrowserTaskFingerprint(payload));
      if (!ok) {
        return finish({
          status: 'failed',
          type,
          url: payload.url ?? '',
          title: '',
          steps,
          message: 'approval tidak valid atau sudah dipakai',
          error: 'approval tidak valid atau sudah dipakai',
        });
      }
    }

    // --- Permission gates (on top of approval). ---
    if (mutating.length > 0 && !(await this.permissions.isAllowed('domActions'))) {
      return fail(`domActions permission is off — ${this.permissions.denialMessage('domActions')}`);
    }
    const readsPage = type === 'browser_read' || actions.some((a) => a.tool === 'readScreen' || a.tool === 'extract' || a.tool === 'findText');
    if (readsPage && !(await this.permissions.isAllowed('readPage'))) {
      return fail(`readPage permission is off — ${this.permissions.denialMessage('readPage')}`);
    }

    // --- Double-execution guard (v9.1, mutating tasks only): a re-claimed
    // task (attempts > 1 — the bridge requeued it after a lease expiry)
    // whose taskId is already recorded must NOT run again — the outcome of
    // the first run is unknown. A legitimate phone resubmission is a NEW
    // taskId, so it is never blocked by this. The record is written BEFORE
    // any navigation or action below, so even a worker death mid-run leaves
    // the task marked.
    if (mutating.length > 0) {
      try {
        if ((task.attempts ?? 1) > 1 && (await isBrowserTaskExecuted(task.id))) {
          return finish({
            status: 'failed',
            type,
            url: payload.url ?? '',
            title: '',
            steps,
            message: 'Hasil tidak diketahui, cek manual di laptop',
            error: 'Hasil tidak diketahui, cek manual di laptop',
          });
        }
        await markBrowserTaskExecuted(task.id);
      } catch {
        return finish({
          status: 'failed',
          type,
          url: payload.url ?? '',
          title: '',
          steps,
          message: 'Gagal mencatat tugas, coba lagi.',
          error: 'Gagal mencatat tugas, coba lagi.',
        });
      }
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

// ---------------------------------------------------------------------------
// Single-use approval (v9.1) — fail closed.
//
// The old gate only checked payload.approved === true, and the approvalId
// handed out with 'awaiting_approval' was never stored, so anyone holding
// the bridge token could forge approved:true and skip the phone dialog,
// and one approval could be replayed forever. Now:
//
//   - hold: the approvalId is recorded in chrome.storage.session together
//     with a fingerprint of the EXACT payload (type+url+actions) and a
//     10-minute expiry. Session storage — not an in-memory Map — because
//     the MV3 worker can die mid-wait; a missing entry means "not approved".
//   - resubmission: approved=true is only honoured when the echoed
//     approvalId exists, has not expired, and fingerprints the same payload.
//     The entry is DELETED before any execution, so it can never run twice.
//     Anything else fails with 'approval tidak valid atau sudah dipakai'
//     and runs ZERO actions (no navigation, no click, no typing).
// ---------------------------------------------------------------------------

/** chrome.storage.session key for { approvalId -> StoredApproval }. */
export const APPROVAL_SESSION_KEY = 'mobius_browser_approvals';
/** An approval lives for one phone round-trip: 10 minutes (the bridge TTL). */
export const APPROVAL_TTL_MS = 10 * 60_000;
/** chrome.storage.session key for { taskId -> executedAt } (double-run guard). */
export const EXECUTED_TASKS_SESSION_KEY = 'mobius_executed_browser_tasks';
/** Executed-task records older than the bridge TTL can never be re-claimed. */
const EXECUTED_TASKS_TTL_MS = 10 * 60_000;

/** One stored approval: what payload it covers, and until when. */
export interface StoredApproval {
  fingerprint: string;
  expiresAt: number;
}

/**
 * Deterministic canonical JSON: object keys sorted recursively, so the same
 * payload stringifies identically no matter the key order in the JSON the
 * phone sent. Arrays keep their order (action order matters). `undefined`
 * values are dropped from objects and become null in arrays, like
 * JSON.stringify. Pure — safe to unit-test from Node.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v === undefined ? null : v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
  }
  return 'null';
}

/**
 * Fingerprint of a browser-task payload: canonical string of type + url +
 * actions ONLY. `approved` is deliberately excluded — the hold carries
 * approved=false/absent and the resubmission approved=true for the same
 * task, so including it would break the match. A resubmission with the same
 * approvalId but different actions/URL fingerprints differently and fails.
 * Pure — safe to unit-test from Node.
 */
export function computeBrowserTaskFingerprint(payload: { type: string; url?: string; actions?: BrowserAction[] }): string {
  return canonicalStringify({ type: payload.type, url: payload.url ?? '', actions: payload.actions ?? [] });
}

/**
 * Pure check: is this stored approval still usable for this fingerprint?
 * False when the entry is missing (never stored / already consumed / worker
 * state lost), expired, or fingerprints a different payload. Pure — safe to
 * unit-test from Node.
 */
export function isApprovalEntryValid(entry: StoredApproval | undefined, fingerprint: string, now: number = Date.now()): boolean {
  if (!entry) return false;
  if (typeof entry.expiresAt !== 'number' || now >= entry.expiresAt) return false;
  return entry.fingerprint === fingerprint;
}

async function readApprovalMap(): Promise<Record<string, StoredApproval>> {
  try {
    const data = await chrome.storage.session.get(APPROVAL_SESSION_KEY);
    const map = data[APPROVAL_SESSION_KEY] as Record<string, StoredApproval> | undefined;
    return map && typeof map === 'object' ? map : {};
  } catch {
    // Unreadable store = no approvals (fail closed: verification then fails).
    return {};
  }
}

async function writeApprovalMap(map: Record<string, StoredApproval>): Promise<void> {
  await chrome.storage.session.set({ [APPROVAL_SESSION_KEY]: map });
}

/** Record a held-back approval (called before returning 'awaiting_approval'). */
async function storeApproval(approvalId: string, fingerprint: string): Promise<void> {
  const map = await readApprovalMap();
  map[approvalId] = { fingerprint, expiresAt: Date.now() + APPROVAL_TTL_MS };
  await writeApprovalMap(map);
}

/**
 * Consume a single-use approval. Returns true only when the entry exists,
 * has not expired, and fingerprints the exact payload — and deletes the
 * entry BEFORE returning true, so the same approvalId can never execute
 * twice. A fingerprint mismatch keeps the entry (the phone may still send
 * the correct resubmission); an expired entry is pruned. Never throws:
 * any storage failure means "not approved" (fail closed).
 */
async function consumeApproval(approvalId: string | undefined, fingerprint: string): Promise<boolean> {
  if (typeof approvalId !== 'string' || approvalId.length === 0) return false;
  try {
    const map = await readApprovalMap();
    const entry = map[approvalId];
    if (!isApprovalEntryValid(entry, fingerprint)) {
      if (entry && typeof entry.expiresAt === 'number' && Date.now() >= entry.expiresAt) {
        delete map[approvalId];
        await writeApprovalMap(map).catch(() => undefined);
      }
      return false;
    }
    delete map[approvalId];
    await writeApprovalMap(map);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Double-execution guard (v9.1) — a mutating task re-claimed from the bridge
// (attempts > 1 after a lease expiry) must never run twice: the outcome of
// the first run is unknown, and repeating a mutation blindly (e.g. a second
// purchase) is worse than failing honestly. Records live in
// chrome.storage.session (same worker-death reasoning as approvals). A
// legitimate phone resubmission is a NEW taskId, so it is never blocked.
// ---------------------------------------------------------------------------

async function readExecutedTasks(): Promise<Record<string, number>> {
  try {
    const data = await chrome.storage.session.get(EXECUTED_TASKS_SESSION_KEY);
    const map = data[EXECUTED_TASKS_SESSION_KEY] as Record<string, number> | undefined;
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

async function isBrowserTaskExecuted(taskId: string): Promise<boolean> {
  const map = await readExecutedTasks();
  return typeof map[taskId] === 'number';
}

/** Record a mutating task as executed (call BEFORE any action runs). */
async function markBrowserTaskExecuted(taskId: string): Promise<void> {
  const map = await readExecutedTasks();
  const now = Date.now();
  for (const [id, at] of Object.entries(map)) {
    if (typeof at !== 'number' || now - at > EXECUTED_TASKS_TTL_MS) delete map[id];
  }
  map[taskId] = now;
  await chrome.storage.session.set({ [EXECUTED_TASKS_SESSION_KEY]: map });
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
