import type { LogEntry, LogRole, RichContent } from "./types";

/** A folded item returned by MSP `session/read`. Unknown additive fields are ignored. */
export interface SessionHistoryItem {
  itemId?: unknown;
  turnId?: unknown;
  kind?: unknown;
  status?: unknown;
  revision?: unknown;
  text?: unknown;
  content?: unknown;
  displayText?: unknown;
  summary?: unknown;
  visibleOutput?: unknown;
  fallbackText?: unknown;
  message?: unknown;
  tool?: unknown;
  args?: unknown;
  objective?: unknown;
  role?: unknown;
  subagentId?: unknown;
  childSessionId?: unknown;
  depth?: unknown;
  recordedAt?: unknown;
  result?: { summary?: unknown; text?: unknown };
  commandId?: unknown;
  /** `userShell`: command text is part of the durable item, alongside output. */
  commandText?: unknown;
  /** Opaque host reference for lazily loading a large tool output. */
  outputRef?: unknown;
  modelVisibleContent?: unknown;
}

/** A durable notification returned by MSP `view/page`.
 *
 * The protocol intentionally keeps the event method beside its params. We
 * only use the item lifecycle events here; session/turn bookkeeping remains
 * owned by the live event reducer and must never become transcript noise.
 */
export interface PagedHistoryEvent {
  method?: unknown;
  params?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize flat session/read rows and raw MSP wrappers to one item shape. */
function normalizeHistoryItem(raw: unknown): SessionHistoryItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const outer = raw as Record<string, unknown>;
  const nested = typeof outer.item === "object" && outer.item !== null && !Array.isArray(outer.item)
    ? outer.item as Record<string, unknown>
    : null;
  const item = nested === null ? { ...outer } : { ...outer, ...nested };
  const aliases: Array<[string, string]> = [
    ["itemId", "item_id"],
    ["turnId", "turn_id"],
    ["commandText", "command_text"],
    ["outputRef", "output_ref"],
    ["modelVisibleContent", "model_visible_content"],
    ["recordedAt", "recorded_at"],
  ];
  for (const [canonical, alias] of aliases) {
    if (item[canonical] === undefined && item[alias] !== undefined) item[canonical] = item[alias];
  }
  if (item.kind === undefined) item.kind = item.itemKind ?? item.type;
  return item as SessionHistoryItem;
}

function outputReference(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct !== undefined) return direct;
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as { uri?: unknown; id?: unknown };
  return stringValue(object.uri) ?? stringValue(object.id);
}

function richContent(value: unknown): RichContent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, 16).flatMap((raw): RichContent[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof item[key] === "string" && (item[key] as string).trim().length > 0
        ? (item[key] as string).trim().slice(0, 240)
        : undefined;
    const type = text("type");
    const mediaType = text("mediaType") ?? text("media_type");
    const path = text("path");
    const sourceToolName = text("sourceToolName") ?? text("source_tool_name");
    if (!type || !mediaType || !path || !sourceToolName) return [];
    const dimension = (key: string): number | undefined => {
      const n = item[key];
      return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 10000 ? n : undefined;
    };
    const width = dimension("width");
    const height = dimension("height");
    return [{ type, mediaType, path, sourceToolName, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }];
  });
  return items.length > 0 ? items : undefined;
}

/** Normalize additive host aliases before choosing a transcript lane. */
function canonicalKind(raw: string): string {
  const compact = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (compact) {
    case "reasoning":
    case "analysis":
    case "reasoningsummary":
      return "reasoning";
    case "toolcall":
      return "toolCall";
    case "usershell":
      return "userShell";
    case "usermessage":
      return "userMessage";
    case "agentmessage":
      return "agentMessage";
    case "subagent":
      return "subagent";
    case "compaction":
      return "compaction";
    default:
      return raw;
  }
}

function itemText(item: SessionHistoryItem, kind: string): string {
  if (kind === "reasoning") {
    if (Array.isArray(item.summary)) {
      const parts = item.summary.filter((part): part is string => typeof part === "string");
      if (parts.length > 0) return parts.join("\n\n");
    }
    return stringValue(item.text) ?? stringValue(item.content) ?? stringValue(item.fallbackText) ?? "";
  }
  if (kind === "toolCall" || kind === "userShell") {
    const output =
      stringValue(item.visibleOutput) ??
      stringValue(item.message) ??
      stringValue(item.text) ??
      stringValue(item.content) ??
      stringValue(item.fallbackText);
    if (kind === "userShell") {
      const command = stringValue(item.commandText);
      if (command !== undefined && output !== undefined) return `$ ${command}\n${output}`;
      if (command !== undefined) return `$ ${command}`;
    }
    if (output !== undefined) return output;
    const tool = stringValue(item.tool);
    const args = stringValue(item.args);
    if (tool !== undefined && args !== undefined) return `${tool}: ${args}`;
    return tool ?? args ?? "";
  }
  if (kind === "subagent") {
    const result = item.result;
    return (
      stringValue(result?.summary) ??
      stringValue(result?.text) ??
      stringValue(item.text) ??
      stringValue(item.objective) ??
      stringValue(item.fallbackText) ??
      ""
    );
  }
  return (
    stringValue(item.displayText) ??
    stringValue(item.text) ??
    stringValue(item.content) ??
    stringValue(item.message) ??
    stringValue(item.fallbackText) ??
    ""
  );
}

function roleForKind(kind: string): LogRole | null {
  switch (kind) {
    case "userMessage":
      return "user";
    case "agentMessage":
      return "assistant";
    case "reasoning":
      return "thinking";
    case "toolCall":
    case "userShell":
      return "tool";
    case "subagent":
      return "subagent";
    case "compaction":
      return "system";
    default:
      return null;
  }
}

function timestamp(item: SessionHistoryItem, fallback: number): number {
  const parsed = stringValue(item.recordedAt);
  if (parsed !== undefined) {
    const value = Date.parse(parsed);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

/** Convert durable MSP items to the same log lanes used by the live stream. */
export function historyItemsToLogEntries(items: unknown[], now = Date.now()): LogEntry[] {
  const entries: LogEntry[] = [];
  items.forEach((raw, index) => {
    const item = normalizeHistoryItem(raw);
    if (item === null) return;
    const rawKind = stringValue(item.kind);
    const itemId = stringValue(item.itemId);
    const turnId = stringValue(item.turnId);
    if (rawKind === undefined || itemId === undefined) return;
    const kind = canonicalKind(rawKind);
    const role = roleForKind(kind);
    if (role === null) return;
    const text = itemText(item, kind);
    const metadata = richContent(item.modelVisibleContent);
    const outputRef = outputReference(item.outputRef);
    // Image/document items may intentionally carry no visible text. Keep the
    // lane when the host supplied either a lazy output reference or rich
    // metadata so the renderer can offer its preview affordance.
    if (text.length === 0 && metadata === undefined && outputRef === undefined) return;
    const normalizedStatus = stringValue(item.status)?.trim().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_");
    const entry: LogEntry = {
      id: `history:${itemId}`,
      ts: timestamp(item, now + index),
      role,
      text,
      itemId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(outputRef === undefined ? {} : { outputRef }),
      ...(metadata === undefined ? {} : { richContent: metadata }),
      open: normalizedStatus === "in_progress" || normalizedStatus === "running" || normalizedStatus === "started",
      ...(role === "tool" && normalizedStatus === "failed" ? { failed: true } : {}),
    };
    const revision = typeof item.revision === "number" && Number.isFinite(item.revision)
      ? item.revision
      : undefined;
    if (revision !== undefined) entry.itemRevision = revision;
    const child = stringValue(item.childSessionId);
    const agent = stringValue(item.subagentId);
    const objective = stringValue(item.objective);
    const subagentRole = stringValue(item.role);
    const depth = typeof item.depth === "number" && Number.isFinite(item.depth) ? item.depth : undefined;
    const clientMessageId = stringValue(item.commandId);
    if (child !== undefined) entry.childSessionId = child;
    if (agent !== undefined) entry.agentId = agent;
    if (objective !== undefined) entry.objective = objective;
    if (subagentRole !== undefined) entry.subagentRole = subagentRole;
    if (depth !== undefined) entry.depth = depth;
    // A server command id is useful as a durable idempotency hint when an
    // older local entry has no item id yet. It is intentionally kept in the
    // existing clientMessageId slot only for user items.
    if (role === "user" && clientMessageId !== undefined) entry.clientMessageId = clientMessageId;
    entries.push(entry);
  });
  return entries;
}

/**
 * Convert the durable item lifecycle events served by `view/page` into the
 * same folded item projection used by `session/read`.
 *
 * A page can contain multiple revisions of one item (for example an open
 * `item/started` followed by `item/updated` and `item/completed`). Keep the
 * highest revision, while retaining arrival order for items whose revision is
 * absent on an older compatible host. This function is deliberately pure so
 * paging and gap-recovery tests can exercise it without a browser runtime.
 */
export function historyEventsToLogEntries(events: unknown[], now = Date.now()): LogEntry[] {
  const byItem = new Map<string, { item: SessionHistoryItem; index: number; revision?: number }>();
  events.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) return;
    const event = raw as PagedHistoryEvent;
    const method = typeof event.method === "string" ? event.method : "";
    if (method !== "item/started" && method !== "item/updated" && method !== "item/completed") return;
    if (typeof event.params !== "object" || event.params === null) return;
    const params = event.params as Record<string, unknown>;
    if (typeof params.item !== "object" || params.item === null) return;
    const item = normalizeHistoryItem(params.item);
    if (item === null) return;
    const itemId = stringValue(item.itemId);
    if (itemId === undefined) return;
    const revision = typeof item.revision === "number" && Number.isFinite(item.revision)
      ? item.revision
      : undefined;
    const previous = byItem.get(itemId);
    if (
      previous !== undefined &&
      previous.revision !== undefined &&
      revision !== undefined &&
      revision <= previous.revision
    ) return;
    byItem.set(itemId, { item, index, revision });
  });
  return historyItemsToLogEntries(
    [...byItem.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ item }) => item),
    now,
  );
}

/** Read inline items from either the normal history envelope or a snapshot. */
export function extractHistoryItems(history: unknown): unknown[] {
  if (typeof history !== "object" || history === null) return [];
  const envelope = history as { items?: unknown; snapshot?: unknown };
  if (Array.isArray(envelope.items)) return envelope.items;
  if (typeof envelope.snapshot !== "object" || envelope.snapshot === null) return [];
  const snapshot = envelope.snapshot as { state?: unknown };
  if (typeof snapshot.state !== "object" || snapshot.state === null) return [];
  const state = snapshot.state as { items?: unknown };
  return Array.isArray(state.items) ? state.items : [];
}


