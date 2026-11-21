import { z } from 'zod';
import type { QuollDeskBridge } from '../quollAgent/executor';
import type { ExecutorContext } from '../quollAgent/executor';
import type { AIPermissionMode, WebSearchConfig } from '../types';
import type { ToolOutputStore } from './toolOutputStore';
import type { ToolResultDedup } from './toolResultDedup';
import type { CompactionTrace } from './types';
import type { AgentKind } from '../agentKinds';
import type { PromptContextSnapshot } from './promptContextSnapshot';

export const quollRuntimeContextSchema = z.object({
  chatSessionId: z.string(),
  turnId: z.string(),
  agentKind: z.enum(['sidebar', 'global']),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  userGoal: z.string().optional(),
  permissionMode: z.enum(['observer', 'confirm', 'auto']),
  scopeType: z.enum(['terminal', 'workspace', 'global', 'database']),
  delegated: z.boolean().optional(),
  scopeLabel: z.string().optional(),
  lastCompaction: z.custom<CompactionTrace>().optional(),
  lastStepAdjusted: z.boolean().optional(),
  promptContext: z.custom<PromptContextSnapshot>().optional(),
});

export type QuollRuntimeContext = z.infer<typeof quollRuntimeContextSchema>;

export const quollToolContextSchema = z.object({
  bridge: z.custom<QuollDeskBridge>(),
  chatSessionId: z.string().optional(),
  permissionMode: z.enum(['observer', 'confirm', 'auto']),
  commandBlocklist: z.array(z.string()).optional(),
  webSearchConfig: z.custom<WebSearchConfig>().optional(),
  getExecutorContext: z.custom<() => ExecutorContext>(),
  toolOutputStore: z.custom<ToolOutputStore>().optional(),
  toolResultDedup: z.custom<ToolResultDedup>().optional(),
});

export type QuollToolContext = z.infer<typeof quollToolContextSchema>;

export function createInitialQuollRuntimeContext(input: {
  chatSessionId: string;
  turnId: string;
  agentKind?: AgentKind;
  providerId?: string;
  modelId?: string;
  userGoal?: string;
  permissionMode: AIPermissionMode;
  scopeType: 'terminal' | 'workspace' | 'global' | 'database';
  delegated?: boolean;
  scopeLabel?: string;
  promptContext?: PromptContextSnapshot;
}): QuollRuntimeContext {
  return {
    chatSessionId: input.chatSessionId,
    turnId: input.turnId,
    agentKind: input.agentKind ?? 'sidebar',
    delegated: input.delegated,
    providerId: input.providerId,
    modelId: input.modelId,
    userGoal: input.userGoal,
    permissionMode: input.permissionMode,
    scopeType: input.scopeType,
    scopeLabel: input.scopeLabel,
    promptContext: input.promptContext,
  };
}

export function toolDepsFromContext(context: QuollToolContext): import('../shared/toolExecutors').ToolDeps {
  return {
    bridge: context.bridge,
    context: context.getExecutorContext,
    commandBlocklist: context.commandBlocklist,
    permissionMode: context.permissionMode,
    webSearchConfig: context.webSearchConfig,
    chatSessionId: context.chatSessionId,
  };
}
