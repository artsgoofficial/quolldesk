import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';

export async function writeSystemManagerDiagnostic(
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    await quolldeskBridge.get()?.logDiagnostic?.({
      source: 'system-manager',
      message,
      extra,
    });
  } catch {
    // Diagnostics must never block the user action being diagnosed.
  }
}
