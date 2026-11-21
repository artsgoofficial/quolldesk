import type { ToolApprovalStatus } from 'ai';
import type { AIPermissionMode } from '../types';
import { requestApproval as defaultRequestApproval } from '../shared/approvalGate';
import { resolveCapabilityId } from './permissionGrants';
import quollToolSpecs from './generated/quollToolSpecs.json';

// Annotated as the callable constituent of the AI SDK's ToolApprovalConfiguration
// union. The full union (with TOOLS=Record<string, never>) is variance-fragile:
// widening QuollRuntimeContext.scopeType flips TS into reporting ToolSet-vs-
// Record contravariance on the SDK's per-tool object constituent. A minimal
// structural function type stays assignable in both directions.
type QuollToolApprovalFunction = (options: {
  toolCall: { toolCallId: string; toolName: string; input?: unknown };
}) => Promise<ToolApprovalStatus | undefined> | ToolApprovalStatus | undefined;

type QuollToolPolicySpec = {
  toolName: string;
  capabilityId: string;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
    bypassesObserverBlock?: boolean;
  };
};

const policyByToolName = new Map<string, QuollToolPolicySpec>(
  (quollToolSpecs as QuollToolPolicySpec[]).map((spec) => [spec.toolName, spec]),
);

function needsUserApproval(
  toolName: string,
  permissionMode: AIPermissionMode,
): boolean {
  if (permissionMode !== 'confirm') return false;
  const spec = policyByToolName.get(toolName);
  if (!spec) return false;
  return spec.policy.write && !spec.policy.bypassesApproval;
}

export function buildQuollToolApproval(input: {
  permissionMode: AIPermissionMode;
  chatSessionId?: string;
  requestApproval?: typeof defaultRequestApproval;
}): QuollToolApprovalFunction {
  const { permissionMode, chatSessionId, requestApproval = defaultRequestApproval } = input;

  return async ({ toolCall }) => {
    const spec = policyByToolName.get(toolCall.toolName);
    if (!spec?.policy.write) {
      return undefined;
    }

    if (permissionMode === 'observer' && !spec.policy.bypassesObserverBlock) {
      return { type: 'denied' as const, reason: 'Observer mode blocks write operations.' };
    }

    if (!needsUserApproval(toolCall.toolName, permissionMode)) {
      return undefined;
    }

    const args = (toolCall.input ?? {}) as Record<string, unknown>;
    const approved = await requestApproval(
      toolCall.toolCallId,
      toolCall.toolName,
      args,
      chatSessionId,
      undefined,
      spec.capabilityId ?? resolveCapabilityId(toolCall.toolName),
    );

    if (approved) {
      return { type: 'approved' as const };
    }
    return { type: 'denied' as const, reason: 'User denied tool execution.' };
  };
}
