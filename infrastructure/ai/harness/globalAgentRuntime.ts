import { AgentRuntime } from './agentRuntime';
import { registerAgentRuntimeCleanup } from './agentRuntimeHandle';
import { quollTurnDriver } from './turnDrivers/quollTurnDriver';
import { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';

export const globalAgentRuntime = new AgentRuntime({
  drivers: [quollTurnDriver, externalSdkTurnDriver],
});
registerAgentRuntimeCleanup(globalAgentRuntime);

export function getAgentRuntime(): AgentRuntime {
  return globalAgentRuntime;
}
