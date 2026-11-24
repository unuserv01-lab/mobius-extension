// AgentFactory — creates exactly one temporary SubAgent per task (P2).
import type { AIRouter } from '../ai/AIRouter';
import type { PermissionManager } from '../core/PermissionManager';
import type { TaskContext } from '../core/ContextManager';
import type { MobiusTask } from '../core/types';
import { SubAgent, type SubAgentKind } from './SubAgent';

export class AgentFactory {
  private aiRouter: AIRouter;
  private permissions: PermissionManager;

  constructor(aiRouter: AIRouter, permissions: PermissionManager) {
    this.aiRouter = aiRouter;
    this.permissions = permissions;
  }

  create(
    kind: SubAgentKind,
    task: MobiusTask,
    context: TaskContext,
    tempTtlSeconds: number,
    insertIntoPage: boolean,
  ): SubAgent {
    return new SubAgent(kind, task, context, this.aiRouter, this.permissions, tempTtlSeconds, insertIntoPage);
  }
}
