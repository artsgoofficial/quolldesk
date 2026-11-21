export class BridgeUnavailableError extends Error {
  constructor(message = "QuollDesk bridge unavailable") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export const quolldeskBridge = {
  get(): QuollDeskBridge | undefined {
    return typeof window !== 'undefined' ? window.quolldesk : undefined;
  },

  require(): QuollDeskBridge {
    const bridge = window.quolldesk;
    if (!bridge) throw new BridgeUnavailableError();
    return bridge;
  },
};
