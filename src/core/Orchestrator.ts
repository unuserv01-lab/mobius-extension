// Orchestrator — the Core. Runs locally in the service worker (P1).
// Owns: task intake, permission gates, context, routing, subagent lifecycle,
// and the ONLY write path into MemoryStore (P5).
import { DEFAULT_MEMORY_TTL_SECONDS, DEFAULT_TEMP_TTL_SECONDS, STORAGE_KEYS } from '../config/constants';
import { AgentFactory } from '../agent/AgentFactory';
import { AIRouter } from '../ai/AIRouter';
import { ContextManager } from './ContextManager';
import { MemoryStore } from './MemoryStore';
import { PermissionManager } from './PermissionManager';
import { TaskRouter } from './TaskRouter';
import type { MobiusSettings, MobiusTask, TaskResult } from './types';

export class Orchestrator {
  private permissions = new PermissionManager();
  private memory = new MemoryStore();
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
    };
  }

  /** Main entry: handle one user task end-to-end (prompt section 6). */
  async handleTask(task: MobiusTask): Promise<TaskResult> {
    const settings = await this.getSettings();
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
  getPermissionManager(): PermissionManager {
    return this.permissions;
  }
  getAIRouter(): AIRouter {
    return this.aiRouter;
  }
}
