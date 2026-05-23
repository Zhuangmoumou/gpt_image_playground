import type { AgentConversation } from '../../src/types'
import { db, type AgentStateRow } from '../db/client'

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function listAgentConversations(userId: string): AgentConversation[] {
  const row = db.prepare('SELECT * FROM agent_state WHERE user_id = ?').get(userId) as AgentStateRow | undefined
  return parseJson(row?.conversations_json ?? null, [])
}

export function replaceAgentConversations(userId: string, conversations: AgentConversation[]) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO agent_state (user_id, conversations_json, updated_at)
    VALUES (@user_id, @conversations_json, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      conversations_json = excluded.conversations_json,
      updated_at = excluded.updated_at
  `).run({
    user_id: userId,
    conversations_json: JSON.stringify(conversations),
    updated_at: now,
  })

  return listAgentConversations(userId)
}
