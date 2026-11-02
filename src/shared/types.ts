/** Minimal, browser-independent transcript types adapted from Muse Desktop (MIT). */
export type LogRole = "user" | "assistant" | "thinking" | "subagent" | "system" | "tool";

export interface RichContent {
  type: string;
  mediaType: string;
  path: string;
  sourceToolName: string;
  width?: number;
  height?: number;
}

export interface LogEntry {
  id: string;
  ts: number;
  role: LogRole;
  text: string;
  agentId?: string;
  itemId?: string;
  turnId?: string;
  itemRevision?: number;
  outputRef?: string;
  richContent?: RichContent[];
  open?: boolean;
  childSessionId?: string;
  objective?: string;
  subagentRole?: string;
  depth?: number;
  clientMessageId?: string;
  failed?: boolean;
}
