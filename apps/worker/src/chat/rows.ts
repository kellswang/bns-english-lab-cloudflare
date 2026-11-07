/** 聊天相关行类型。 */
export interface ChatConversationRow {
  id: string;
  owner_id: string;
  title: string;
  model: string;
  thinking: string;
  status: string;
  active_leaf_id: string | null;
  summary: string | null;
  summary_upto_id: string | null;
  summary_leaf_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  status: "complete" | "streaming" | "stopped" | "failed" | "interrupted";
  model: string | null;
  thinking: string | null;
  attachments: string;
  usage: string;
  request_id: string | null;
  cost_usd: number | null;
  cost_status: string;
  cost_checked_at: string | null;
  duration_ms: number | null;
  error: string | null;
  reasoning_summary: string | null;
  client_request_id: string | null;
  stop_requested: number;
  created_at: string;
  finished_at: string | null;
}
