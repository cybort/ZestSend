export type ChatMessage = {
  deliveryStatus?: "sending" | "received" | "read" | "error";
  id: string;
  lastAttemptedAt?: number;
  text: string;
  sender: "local" | "remote";
  sentAt: number;
};

/**
 * Local persistence utilities for ZestSend room state.
 * Uses sessionStorage (cleared when tab closes) to avoid long-term local records.
 * Keys are scoped by roomId + local slotId to prevent cross-room leakage.
 */

const STORAGE_PREFIX = "zestsend:room:";

/**
 * Generate a scoped storage key.
 * Format: zestsend:room:{roomId}:{slotId}:{namespace}
 */
function scopedKey(roomId: string, slotId: string | null, namespace: string): string {
  const slotPart = slotId ?? "unknown";
  return `${STORAGE_PREFIX}${roomId}:${slotPart}:${namespace}`;
}

/**
 * Persist chat history to sessionStorage.
 * Only stores messages up to a reasonable limit (last 500) to avoid quota issues.
 */
export function persistChatMessages(roomId: string, slotId: string | null, messages: ChatMessage[]): void {
  try {
    const key = scopedKey(roomId, slotId, "chat");
    // Keep only last 500 messages to stay within sessionStorage quota
    const limited = messages.slice(-500);
    window.sessionStorage.setItem(key, JSON.stringify(limited));
  } catch {
    // Ignore quota/private browsing errors
  }
}

/**
 * Restore chat history from sessionStorage.
 * Returns empty array if nothing stored or parse fails.
 */
export function restoreChatMessages(roomId: string, slotId: string | null): ChatMessage[] {
  try {
    const key = scopedKey(roomId, slotId, "chat");
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Validate structure
    return parsed.filter((msg) =>
      typeof msg.id === "string" &&
      typeof msg.text === "string" &&
      (msg.sender === "local" || msg.sender === "remote") &&
      typeof msg.sentAt === "number" &&
      (!msg.deliveryStatus || ["sending", "received", "read", "error"].includes(msg.deliveryStatus))
    );
  } catch {
    return [];
  }
}

/**
 * Persist file transfer snapshots to sessionStorage.
 */
export function persistFileTransfers(roomId: string, slotId: string | null, transfers: any[]): void {
  try {
    const key = scopedKey(roomId, slotId, "transfers");
    window.sessionStorage.setItem(key, JSON.stringify(transfers));
  } catch {
    // Ignore
  }
}

/**
 * Restore file transfer snapshots from sessionStorage.
 */
export function restoreFileTransfers(roomId: string, slotId: string | null): any[] {
  try {
    const key = scopedKey(roomId, slotId, "transfers");
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as any[];
  } catch {
    return [];
  }
}

/**
 * Persist canvas/collaboration state metadata (not full Y.Doc binary — too large for sessionStorage).
 * Stores only flags like "has content" for quick UI restoration.
 */
export function persistCollaborationMeta(roomId: string, slotId: string | null, meta: { hasCanvasContent: boolean }): void {
  try {
    const key = scopedKey(roomId, slotId, "collab-meta");
    window.sessionStorage.setItem(key, JSON.stringify(meta));
  } catch {
    // Ignore
  }
}

export function restoreCollaborationMeta(roomId: string, slotId: string | null): { hasCanvasContent: boolean } {
  try {
    const key = scopedKey(roomId, slotId, "collab-meta");
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return { hasCanvasContent: false };
    return JSON.parse(raw) as { hasCanvasContent: boolean };
  } catch {
    return { hasCanvasContent: false };
  }
}

/**
 * Clear all room-scoped sessionStorage entries (called on explicit leave or room full).
 */
export function clearRoomStorage(roomId: string, slotId: string | null): void {
  try {
    const prefix = scopedKey(roomId, slotId, "");
    // sessionStorage doesn't support prefix iteration; iterate all keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith(prefix)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) window.sessionStorage.removeItem(key);
  } catch {
    // Ignore
  }
}

/**
 * Persist current slotId for the room (used to find storage on refresh).
 */
export function persistSlotId(roomId: string, slotId: string): void {
  try {
    window.sessionStorage.setItem(`zestsend:room:${roomId}:currentSlot`, slotId);
  } catch {
    // Ignore
  }
}

export function restoreSlotId(roomId: string): string | null {
  try {
    return window.sessionStorage.getItem(`zestsend:room:${roomId}:currentSlot`);
  } catch {
    return null;
  }
}
