import { randomUUID } from 'crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import type { ChatMessage, ChatSession, ChatSessionKind } from '../../shared/types'
import {
  getChatIndexPath,
  getChatSessionFilePath,
  getChatsDir,
  getStoreFilePath
} from './app-paths'

interface ChatIndex {
  sessions: ChatSession[]
  /** 每台服务器当前激活的会话 */
  activeByServer: Record<string, string>
  migratedFromStore?: boolean
}

interface SessionFile {
  session: ChatSession
  messages: ChatMessage[]
}

function emptyIndex(): ChatIndex {
  return { sessions: [], activeByServer: {} }
}

export class ChatSessionStore {
  private index: ChatIndex

  constructor() {
    getChatsDir()
    this.index = this.loadIndex()
    this.migrateLegacyChatsIfNeeded()
  }

  reload(): void {
    getChatsDir()
    this.index = this.loadIndex()
    this.migrateLegacyChatsIfNeeded()
  }

  private loadIndex(): ChatIndex {
    const path = getChatIndexPath()
    if (!existsSync(path)) return emptyIndex()
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ChatIndex
      return {
        sessions: parsed.sessions || [],
        activeByServer: parsed.activeByServer || {},
        migratedFromStore: parsed.migratedFromStore
      }
    } catch {
      return emptyIndex()
    }
  }

  private saveIndex(): void {
    writeFileSync(getChatIndexPath(), JSON.stringify(this.index, null, 2), 'utf8')
  }

  private readSessionFile(sessionId: string): SessionFile | null {
    const path = getChatSessionFilePath(sessionId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SessionFile
    } catch {
      return null
    }
  }

  private writeSessionFile(data: SessionFile): void {
    writeFileSync(getChatSessionFilePath(data.session.id), JSON.stringify(data, null, 2), 'utf8')
  }

  /** 把旧 store.json 里按 serverId 存的 chats 迁成独立会话文件 */
  private migrateLegacyChatsIfNeeded(): void {
    if (this.index.migratedFromStore) return
    const storePath = getStoreFilePath()
    if (!existsSync(storePath)) {
      this.index.migratedFromStore = true
      this.saveIndex()
      return
    }
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as {
        chats?: Record<string, ChatMessage[]>
      }
      const chats = raw.chats || {}
      for (const [serverId, messages] of Object.entries(chats)) {
        if (!messages?.length) continue
        const already = this.index.sessions.some((s) => s.serverId === serverId)
        if (already) continue
        const firstUser = messages.find((m) => m.role === 'user')
        const title = firstUser?.content?.slice(0, 40) || '历史会话'
        const now = Date.now()
        const session: ChatSession = {
          id: randomUUID(),
          serverId,
          title,
          createdAt: messages[0]?.createdAt || now,
          updatedAt: messages[messages.length - 1]?.createdAt || now,
          messageCount: messages.length
        }
        this.writeSessionFile({ session, messages })
        this.index.sessions.push(session)
        if (!this.index.activeByServer[serverId]) {
          this.index.activeByServer[serverId] = session.id
        }
      }
      // 清空 store 中的 chats，避免继续膨胀
      if (Object.keys(chats).length > 0) {
        raw.chats = {}
        writeFileSync(storePath, JSON.stringify(raw, null, 2), 'utf8')
      }
    } catch (err) {
      console.warn('[chat-session-store] 迁移旧聊天失败', err)
    }
    this.index.migratedFromStore = true
    this.saveIndex()
  }

  listSessions(serverId: string): ChatSession[] {
    return this.index.sessions
      .filter((s) => s.serverId === serverId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getActiveSessionId(serverId: string): string | null {
    const id = this.index.activeByServer[serverId]
    if (id && this.index.sessions.some((s) => s.id === id)) return id
    const latest = this.listSessions(serverId)[0]
    return latest?.id ?? null
  }

  setActiveSession(serverId: string, sessionId: string): boolean {
    const session = this.index.sessions.find((s) => s.id === sessionId && s.serverId === serverId)
    if (!session) return false
    this.index.activeByServer[serverId] = sessionId
    this.saveIndex()
    return true
  }

  createSession(
    serverId: string,
    title = '新会话',
    kind: ChatSessionKind = 'ops'
  ): ChatSession {
    const now = Date.now()
    const session: ChatSession = {
      id: randomUUID(),
      serverId,
      title: title.slice(0, 80) || '新会话',
      kind,
      createdAt: now,
      updatedAt: now,
      messageCount: 0
    }
    this.writeSessionFile({ session, messages: [] })
    this.index.sessions.push(session)
    this.index.activeByServer[serverId] = session.id
    this.saveIndex()
    return { ...session }
  }

  listByKind(kind: ChatSessionKind): ChatSession[] {
    return this.index.sessions
      .filter((s) => (s.kind || 'ops') === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ ...s }))
  }

  /** 确保服务器至少有一个激活会话 */
  ensureActiveSession(serverId: string): ChatSession {
    const activeId = this.getActiveSessionId(serverId)
    if (activeId) {
      const found = this.index.sessions.find((s) => s.id === activeId)
      if (found) return found
    }
    return this.createSession(serverId)
  }

  getMessages(sessionId: string): ChatMessage[] {
    const file = this.readSessionFile(sessionId)
    return file?.messages || []
  }

  appendMessage(sessionId: string, message: ChatMessage): ChatMessage[] {
    const file = this.readSessionFile(sessionId)
    if (!file) throw new Error('会话不存在')
    file.messages.push(message)
    // 单会话文件也可裁剪，防止无限增长
    if (file.messages.length > 500) {
      file.messages = file.messages.slice(-500)
    }
    file.session.updatedAt = Date.now()
    file.session.messageCount = file.messages.length
    // 首条用户消息自动当标题
    if (
      (file.session.title === '新会话' || file.session.title === '部署会话') &&
      message.role === 'user' &&
      message.content.trim()
    ) {
      file.session.title = message.content.trim().slice(0, 40)
    }
    this.writeSessionFile(file)
    const idx = this.index.sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) this.index.sessions[idx] = { ...file.session }
    this.saveIndex()
    return file.messages
  }

  clearMessages(sessionId: string): void {
    const file = this.readSessionFile(sessionId)
    if (!file) return
    file.messages = []
    file.session.messageCount = 0
    file.session.updatedAt = Date.now()
    this.writeSessionFile(file)
    const idx = this.index.sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) this.index.sessions[idx] = { ...file.session }
    this.saveIndex()
  }

  renameSession(sessionId: string, title: string): ChatSession | null {
    const file = this.readSessionFile(sessionId)
    if (!file) return null
    file.session.title = title.trim().slice(0, 80) || file.session.title
    file.session.updatedAt = Date.now()
    this.writeSessionFile(file)
    const idx = this.index.sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) this.index.sessions[idx] = { ...file.session }
    this.saveIndex()
    return { ...file.session }
  }

  getSession(sessionId: string): ChatSession | null {
    const meta = this.index.sessions.find((s) => s.id === sessionId)
    if (meta) return { ...meta }
    const file = this.readSessionFile(sessionId)
    return file ? { ...file.session } : null
  }

  /** 部署会话：对话中绑定/切换目标服务器 */
  rebindSessionServer(sessionId: string, serverId: string): ChatSession {
    const file = this.readSessionFile(sessionId)
    if (!file) throw new Error('会话不存在')
    const prev = file.session.serverId
    file.session.serverId = serverId
    file.session.updatedAt = Date.now()
    this.writeSessionFile(file)

    const idx = this.index.sessions.findIndex((s) => s.id === sessionId)
    if (idx >= 0) this.index.sessions[idx] = { ...file.session }

    if (this.index.activeByServer[prev] === sessionId) {
      delete this.index.activeByServer[prev]
    }
    this.index.activeByServer[serverId] = sessionId
    this.saveIndex()
    return { ...file.session }
  }

  deleteSession(sessionId: string): boolean {
    const meta = this.index.sessions.find((s) => s.id === sessionId)
    if (!meta) return false
    this.index.sessions = this.index.sessions.filter((s) => s.id !== sessionId)
    if (this.index.activeByServer[meta.serverId] === sessionId) {
      const next = this.listSessions(meta.serverId)[0]
      if (next) this.index.activeByServer[meta.serverId] = next.id
      else delete this.index.activeByServer[meta.serverId]
    }
    this.saveIndex()
    const path = getChatSessionFilePath(sessionId)
    if (existsSync(path)) unlinkSync(path)
    return true
  }

  deleteSessionsByServer(serverId: string): void {
    const ids = this.index.sessions.filter((s) => s.serverId === serverId).map((s) => s.id)
    for (const id of ids) this.deleteSession(id)
  }
}

let chatStore: ChatSessionStore | null = null

export function getChatStore(): ChatSessionStore {
  if (!chatStore) chatStore = new ChatSessionStore()
  return chatStore
}

export function reloadChatStore(): ChatSessionStore {
  if (chatStore) chatStore.reload()
  else chatStore = new ChatSessionStore()
  return chatStore
}
