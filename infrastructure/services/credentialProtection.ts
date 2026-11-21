import { quolldeskBridge } from "./quolldeskBridge";

export const getCredentialProtectionAvailability = async (): Promise<boolean | null> => {
  const bridge = quolldeskBridge.get();
  if (!bridge?.credentialsAvailable) return null;

  try {
    return await bridge.credentialsAvailable();
  } catch {
    return null;
  }
};
