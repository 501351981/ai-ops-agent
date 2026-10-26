import { BrowserWindow } from 'electron'
import type { MonitorBundle, MonitorDataEvent } from '../../shared/types'
import { getMonitorStore } from './monitor-store'
import { getSshManager } from './ssh-manager'
import { assessCommandRisk } from '../tools'

interface ActivePoll {
  serverId: string
  timer: NodeJS.Timeout | null
  window: BrowserWindow | null
  /** 进行中的采集；并发 tick 直接复用，避免「上一次尚未完成」误报 */
  inFlight: Promise<MonitorDataEvent> | null
}

function extractJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // continue
    }
  }
  const trimmed = stdout.trim()
  const parsed = JSON.parse(trimmed) as unknown
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  throw new Error('采集脚本未输出有效 JSON 对象')
}

export class MonitorService {
  private polls = new Map<string, ActivePoll>()

  getBundle(serverId: string): MonitorBundle | null {
    return getMonitorStore().get(serverId)
  }

  start(serverId: string, window: BrowserWindow | null): boolean {
    const bundle = getMonitorStore().get(serverId)
    if (!bundle) return false

    const existing = this.polls.get(serverId)
    if (existing) {
      existing.window = window
      if (!existing.timer) this.schedule(existing, bundle.manifest.intervalSec)
      // 已在跑则不重复开火，等当前结果即可
      if (!existing.inFlight) void this.tick(serverId)
      return true
    }

    const poll: ActivePoll = {
      serverId,
      timer: null,
      window,
      inFlight: null
    }
    this.polls.set(serverId, poll)
    this.schedule(poll, bundle.manifest.intervalSec)
    void this.tick(serverId)
    return true
  }

  stop(serverId: string): void {
    const poll = this.polls.get(serverId)
    if (!poll) return
    if (poll.timer) clearInterval(poll.timer)
    this.polls.delete(serverId)
  }

  stopAll(): void {
    for (const id of [...this.polls.keys()]) this.stop(id)
  }

  /** 立即刷新一次（若已有采集在飞，等待同一结果） */
  async refreshOnce(serverId: string, window?: BrowserWindow | null): Promise<MonitorDataEvent> {
    if (window) {
      const poll = this.polls.get(serverId)
      if (poll) poll.window = window
      else {
        this.polls.set(serverId, {
          serverId,
          timer: null,
          window,
          inFlight: null
        })
      }
    }
    return this.tick(serverId)
  }

  private schedule(poll: ActivePoll, intervalSec: number): void {
    if (poll.timer) clearInterval(poll.timer)
    const ms = Math.min(300, Math.max(2, intervalSec)) * 1000
    poll.timer = setInterval(() => {
      void this.tick(poll.serverId)
    }, ms)
  }

  private emit(serverId: string, event: MonitorDataEvent): void {
    const poll = this.polls.get(serverId)
    const win = poll?.window
    if (win && !win.isDestroyed()) {
      win.webContents.send(`monitor:data:${serverId}`, event)
    }
  }

  private async tick(serverId: string): Promise<MonitorDataEvent> {
    let poll = this.polls.get(serverId)
    if (!poll) {
      poll = { serverId, timer: null, window: null, inFlight: null }
      this.polls.set(serverId, poll)
    }

    if (poll.inFlight) return poll.inFlight

    const run = this.runCollect(serverId)
    poll.inFlight = run
    try {
      return await run
    } finally {
      if (this.polls.get(serverId) === poll) poll.inFlight = null
    }
  }

  private async runCollect(serverId: string): Promise<MonitorDataEvent> {
    const collectedAt = Date.now()
    const bundle = getMonitorStore().get(serverId)
    if (!bundle) {
      const event: MonitorDataEvent = {
        serverId,
        ok: false,
        error: '未配置监控看板',
        collectedAt
      }
      this.emit(serverId, event)
      return event
    }

    try {
      const risk = assessCommandRisk(bundle.collectScript)
      if (risk.blocked || risk.riskLevel === 'high') {
        const event: MonitorDataEvent = {
          serverId,
          ok: false,
          error: `采集脚本被拒绝: ${risk.reason || '高风险命令'}`,
          collectedAt
        }
        this.emit(serverId, event)
        return event
      }

      const b64 = Buffer.from(bundle.collectScript, 'utf8').toString('base64')
      const runCmd = `echo '${b64}' | (base64 -d 2>/dev/null || base64 -D) | bash`
      const result = await getSshManager().exec(serverId, runCmd)
      if (result.code !== 0 && !result.stdout.trim()) {
        const event: MonitorDataEvent = {
          serverId,
          ok: false,
          error: result.stderr.slice(0, 500) || `命令退出码 ${result.code}`,
          collectedAt
        }
        this.emit(serverId, event)
        return event
      }

      const data = extractJsonLine(result.stdout)
      const event: MonitorDataEvent = { serverId, ok: true, data, collectedAt }
      this.emit(serverId, event)
      return event
    } catch (err) {
      const event: MonitorDataEvent = {
        serverId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        collectedAt
      }
      this.emit(serverId, event)
      return event
    }
  }
}

let instance: MonitorService | null = null

export function getMonitorService(): MonitorService {
  if (!instance) instance = new MonitorService()
  return instance
}
