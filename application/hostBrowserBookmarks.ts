import type { BrowserBookmark } from '../domain/browserBookmark';
import { quolldeskBridge } from '../infrastructure/services/quolldeskBridge';

let cachedBookmarks: BrowserBookmark[] | undefined;

export function getCachedHostBrowserBookmarks(): BrowserBookmark[] | undefined {
  return cachedBookmarks?.map((item) => ({ ...item }));
}

export async function collectHostBrowserBookmarks(): Promise<BrowserBookmark[] | undefined> {
  const reader = quolldeskBridge.get()?.getHostBrowserBookmarks;
  if (!reader) return cachedBookmarks;
  const items = await reader();
  cachedBookmarks = items;
  return getCachedHostBrowserBookmarks();
}

export async function applyHostBrowserBookmarks(items: BrowserBookmark[]): Promise<void> {
  const writer = quolldeskBridge.get()?.applyHostBrowserBookmarks;
  if (!writer) return;
  await writer(items);
  cachedBookmarks = items;
}
