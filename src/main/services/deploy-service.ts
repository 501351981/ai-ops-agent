import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import type {
  DeployRun,
  DeployRunRequest,
  DeployRunStepResult,
  DeployStreamEvent,
  DeploymentRecipe,
  ToolConfirmRequest
} from '../../shared/types'
import { assessCommandRisk } from '../tools'
import { getStore } from './credential-store'
import { getDeployStore } from './deploy-store'
import { getSshManager } from './ssh-manager'

/**
 * 对话沉淀常见伪命令：upload_file <本机路径> => <远端路径>
 * 零 Token 执行时走 SFTP，不能当远程 shell。
 */
function parseUploadStep(command: string): { localPath: string; remotePath: string } | null {
  const m = command
    .trim()
    .match(/^upload_file\s+(.+?)\s*=>\s*(.+)$/i)
  if (!m) return null
  return { localPath: m[1].trim(), remotePath: m[2].trim() }
}

interface PendingConfirm {
  runId: string
  resolve: (approved: boolean) => void
}

interface ActiveDeploy {
  aborted: boolean
  runId: string
  projectId: string
  serverId: string
}

const TAIL_LIMIT = 4000

function tail(text: string, limit = TAIL_LIMIT): string {
  if (!text) return ''
  return text.length <= limit ? text : text.slice(-limit)
}

/** 简单 {{key}} 模板替换；值为字符串时原样插入 */
export function renderTemplate(
  template: string,
  params: Record<string, string | number | boolean>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in params)) return `{{${key}}}`
    return String(params[key])
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateParams(
  recipe: DeploymentRecipe,
  params: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const merged: Record<string, string | number | boolean> = { ...params }
  for (const def of recipe.params) {
    if (merged[def.key] === undefined || merged[def.key] === '') {
      if (def.defaultValue !== undefined) merged[def.key] = def.defaultValue
    }
    if (def.required && (merged[def.key] === undefined || merged[def.key] === '')) {
      throw new Error(`缺少必填参数: ${def.label || def.key}`)
    }
  }
  return merged
}

export class DeployService {
  private pendingConfirms = new Map<string, PendingConfirm>()
  private active = new Map<string, ActiveDeploy>()

  respondConfirm(requestId: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(requestId)
    if (pending) {
      pending.resolve(approved)
      this.pendingConfirms.delete(requestId)
    }
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId)
    if (run) run.aborted = true
    for (const [id, pending] of this.pendingConfirms) {
      if (pending.runId === runId) {
        pending.resolve(false)
        this.pendingConfirms.delete(id)
      }
    }
    return !!run
  }

  cancelProject(projectId: string): void {
    for (const [runId, run] of this.active) {
      if (run.projectId === projectId) this.cancel(runId)
    }
  }

  private emit(win: BrowserWindow | null, runId: string, event: Omit<DeployStreamEvent, 'runId'>): void {
    if (win && !win.isDestroyed()) {
      win.webContents.send(`deploy:stream:${runId}`, { ...event, runId })
    }
  }

  private persist(run: DeployRun): DeployRun {
    return getDeployStore().saveRun(run)
  }

  private waitConfirm(
    req: ToolConfirmRequest,
    win: BrowserWindow | null,
    active: ActiveDeploy
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (active.aborted) {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(req.requestId)
        resolve(false)
      }, 5 * 60 * 1000)

      this.pendingConfirms.set(req.requestId, {
        runId: active.runId,
        resolve: (approved) => {
          clearTimeout(timer)
          resolve(approved)
        }
      })
      this.emit(win, active.runId, { type: 'confirm', confirm: req })
    })
  }

  private async execWithTimeout(
    serverId: string,
    command: string,
    timeoutSec: number | undefined,
    onData?: (chunk: string) => void
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const ssh = getSshManager()
    const timeoutMs = Math.max(5, timeoutSec || 300) * 1000
    const execPromise = ssh.exec(serverId, command, {
      onData: (chunk) => onData?.(chunk)
    })
    let timer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`命令超时（${timeoutMs / 1000}s）`)), timeoutMs)
    })
    try {
      return await Promise.race([execPromise, timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private shouldConfirmStep(
    stepRisk: 'low' | 'medium' | 'high',
    requireConfirm: boolean | undefined,
    _autoConfirmLowRisk: boolean | undefined,
    renderedCommand: string
  ): { needsConfirm: boolean; riskLevel: 'low' | 'medium' | 'high'; reason?: string; blocked?: boolean } {
    const assessed = assessCommandRisk(renderedCommand)
    if (assessed.blocked) {
      return { needsConfirm: true, riskLevel: 'high', reason: assessed.reason, blocked: true }
    }
    const riskLevel =
      stepRisk === 'high' || assessed.riskLevel === 'high'
        ? 'high'
        : stepRisk === 'medium' || assessed.riskLevel === 'medium'
          ? 'medium'
          : 'low'

    // 模板一键发布：默认一路跑完，不逐步弹窗；仅步骤显式勾了「每次确认」才打断
    if (requireConfirm === true) {
      return { needsConfirm: true, riskLevel, reason: assessed.reason }
    }
    return { needsConfirm: false, riskLevel, reason: assessed.reason }
  }

  /**
   * 日常发布：读取定版 Recipe + params，零 Token 执行。
   */
  async run(req: DeployRunRequest, window: BrowserWindow | null): Promise<DeployRun> {
    const store = getDeployStore()
    const project = store.getProject(req.projectId)
    if (!project) throw new Error('项目不存在')

    const recipe = store.getRecipe(req.projectId)
    if (!recipe || recipe.status !== 'active') {
      throw new Error('没有可用的定版配方，请先保存 Recipe')
    }
    if (req.recipeId && req.recipeId !== recipe.id) {
      throw new Error('指定的 recipe 与当前定版不一致')
    }

    const serverId = req.serverId || recipe.serverId
    if (!serverId) throw new Error('缺少目标服务器')

    const params = validateParams(recipe, req.params || {})
    const runId = (req.runId || '').trim() || randomUUID()
    if (this.active.has(runId)) throw new Error('该 runId 已在执行中')
    const now = Date.now()

    let run: DeployRun = {
      id: runId,
      projectId: req.projectId,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      serverId,
      params,
      status: 'pending',
      stepResults: recipe.steps.map((s) => ({
        stepId: s.id,
        startedAt: 0,
        status: 'pending'
      })),
      usedLlm: false,
      createdAt: now
    }
    run = this.persist(run)
    store.touchLastRun(req.projectId)

    const active: ActiveDeploy = {
      aborted: false,
      runId,
      projectId: req.projectId,
      serverId
    }
    this.active.set(runId, active)

    try {
      const ssh = getSshManager()

      // ---- 先上传：upload_file 步骤必须在断言之前（断言常检查远端 zip）----
      run.status = 'running'
      run = this.persist(run)
      const uploadedStepIndexes = new Set<number>()

      for (let i = 0; i < recipe.steps.length; i++) {
        if (active.aborted) throw new Error('部署已取消')
        const step = recipe.steps[i]
        const command = renderTemplate(step.command, params)
        const upload = parseUploadStep(command)
        if (!upload) continue

        const stepResult: DeployRunStepResult = {
          stepId: step.id,
          startedAt: Date.now(),
          status: 'running'
        }
        run.currentStepId = step.id
        run.stepResults[i] = stepResult
        run = this.persist(run)
        this.emit(window, runId, { type: 'step_start', stepId: step.id, content: step.name, run })
        this.emit(window, runId, {
          type: 'step_stdout',
          stepId: step.id,
          content: `上传 ${upload.localPath} → ${upload.remotePath}\n`
        })

        try {
          if (!existsSync(upload.localPath) || !statSync(upload.localPath).isFile()) {
            throw new Error(`本机文件不存在或不是文件: ${upload.localPath}`)
          }
          await ssh.uploadFile(serverId, upload.localPath, upload.remotePath)
          stepResult.status = 'ok'
          stepResult.exitCode = 0
          stepResult.stdoutTail = `uploaded → ${upload.remotePath}`
          stepResult.finishedAt = Date.now()
          run.stepResults[i] = stepResult
          run = this.persist(run)
          uploadedStepIndexes.add(i)
          this.emit(window, runId, { type: 'step_result', stepId: step.id, content: 'ok', run })
        } catch (err) {
          stepResult.status = 'failed'
          stepResult.finishedAt = Date.now()
          stepResult.stderrTail = err instanceof Error ? err.message : String(err)
          run.stepResults[i] = stepResult
          run = this.persist(run)
          this.emit(window, runId, { type: 'step_result', stepId: step.id, content: 'failed', run })
          throw err instanceof Error ? err : new Error(String(err))
        }
      }

      // ---- assertions（在上传之后）----
      run.status = 'asserting'
      run = this.persist(run)

      for (const assertion of recipe.assertions || []) {
        if (active.aborted) throw new Error('部署已取消')
        const checkCmd = renderTemplate(assertion.checkCommand, params)
        this.emit(window, runId, {
          type: 'assert',
          content: assertion.description,
          run
        })
        const result = await this.execWithTimeout(serverId, checkCmd, 60)
        if ((result.code ?? 1) !== 0) {
          const detail = `断言失败: ${assertion.description}\n${tail(result.stderr || result.stdout)}`
          if (assertion.onFail === 'warn') {
            this.emit(window, runId, { type: 'assert', content: `警告: ${detail}`, run })
            continue
          }
          if (assertion.onFail === 'prompt-revise') {
            run.status = 'failed'
            run.error = `${detail}\n（可修订配方后重试）`
            run.finishedAt = Date.now()
            run = this.persist(run)
            this.emit(window, runId, { type: 'error', error: run.error, run })
            this.emit(window, runId, { type: 'done', run })
            return run
          }
          throw new Error(detail)
        }
      }

      // ---- 其余 shell 步骤 ----
      run.status = 'running'
      run = this.persist(run)

      for (let i = 0; i < recipe.steps.length; i++) {
        if (active.aborted) throw new Error('部署已取消')
        if (uploadedStepIndexes.has(i)) continue

        const step = recipe.steps[i]
        const command = renderTemplate(step.command, params)
        const stepResult: DeployRunStepResult = {
          stepId: step.id,
          startedAt: Date.now(),
          status: 'running'
        }
        run.currentStepId = step.id
        run.stepResults[i] = stepResult
        run = this.persist(run)

        this.emit(window, runId, { type: 'step_start', stepId: step.id, content: step.name, run })

        const confirmInfo = this.shouldConfirmStep(
          step.riskLevel,
          step.requireConfirm,
          req.autoConfirmLowRisk,
          command
        )
        if (confirmInfo.blocked) {
          throw new Error(`步骤被安全策略阻止: ${confirmInfo.reason || step.name}`)
        }
        if (confirmInfo.needsConfirm) {
          run.status = 'awaiting_confirm'
          run = this.persist(run)
          const approved = await this.waitConfirm(
            {
              requestId: randomUUID(),
              serverId,
              toolName: 'deploy_step',
              arguments: { stepId: step.id, stepName: step.name, command },
              riskLevel: confirmInfo.riskLevel,
              reason: confirmInfo.reason || `部署步骤: ${step.name}`
            },
            window,
            active
          )
          if (!approved) throw new Error(`用户拒绝步骤: ${step.name}`)
          run.status = 'running'
          run = this.persist(run)
        }

        let stdout = ''
        let stderr = ''
        let code: number | null = null
        try {
          const result = await this.execWithTimeout(serverId, command, step.timeoutSec, (chunk) => {
            this.emit(window, runId, { type: 'step_stdout', stepId: step.id, content: chunk })
          })
          stdout = result.stdout
          stderr = result.stderr
          code = result.code
        } catch (err) {
          stepResult.status = 'failed'
          stepResult.finishedAt = Date.now()
          stepResult.stderrTail = err instanceof Error ? err.message : String(err)
          run.stepResults[i] = stepResult
          await this.maybeRollback(recipe, params, serverId, i, run, window, active)
          throw err instanceof Error ? err : new Error(String(err))
        }

        stepResult.exitCode = code ?? undefined
        stepResult.stdoutTail = tail(stdout)
        stepResult.stderrTail = tail(stderr)

        let ok = (code ?? 1) === 0
        if (ok && step.successCheck) {
          const checkCmd = renderTemplate(step.successCheck, params)
          const check = await this.execWithTimeout(serverId, checkCmd, 60)
          ok = (check.code ?? 1) === 0
          if (!ok) {
            stepResult.stderrTail = tail(
              `${stepResult.stderrTail || ''}\nsuccessCheck failed:\n${check.stderr || check.stdout}`
            )
          }
        }

        stepResult.status = ok ? 'ok' : 'failed'
        stepResult.finishedAt = Date.now()
        run.stepResults[i] = stepResult
        run = this.persist(run)
        this.emit(window, runId, {
          type: 'step_result',
          stepId: step.id,
          content: ok ? 'ok' : 'failed',
          run
        })

        if (!ok) {
          await this.maybeRollback(recipe, params, serverId, i, run, window, active)
          throw new Error(`步骤失败: ${step.name} (exit ${code})`)
        }
      }

      // ---- health check ----
      if (recipe.healthCheck?.command) {
        const hc = recipe.healthCheck
        const cmd = renderTemplate(hc.command, params)
        const retries = Math.max(1, hc.retries || 1)
        const intervalSec = Math.max(1, hc.intervalSec || 3)
        let healthy = false
        for (let r = 0; r < retries; r++) {
          if (active.aborted) throw new Error('部署已取消')
          this.emit(window, runId, {
            type: 'health',
            content: `健康检查 ${r + 1}/${retries}`,
            run
          })
          const result = await this.execWithTimeout(serverId, cmd, 60)
          if ((result.code ?? 1) === 0) {
            healthy = true
            break
          }
          if (r < retries - 1) await sleep(intervalSec * 1000)
        }
        if (!healthy) throw new Error('健康检查未通过')
      }

      run.status = 'succeeded'
      run.currentStepId = undefined
      run.finishedAt = Date.now()
      run.error = undefined
      run = this.persist(run)
      store.markLastSuccess(req.projectId, params)
      this.emit(window, runId, { type: 'done', run })
      return run
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (active.aborted || message.includes('取消')) {
        run.status = 'cancelled'
      } else if (run.status !== 'rolled_back') {
        run.status = 'failed'
      }
      run.error = message
      run.finishedAt = Date.now()
      run = this.persist(run)
      this.emit(window, runId, { type: 'error', error: message, run })
      this.emit(window, runId, { type: 'done', run })
      return run
    } finally {
      this.active.delete(runId)
    }
  }

  private async maybeRollback(
    recipe: DeploymentRecipe,
    params: Record<string, string | number | boolean>,
    serverId: string,
    failedIndex: number,
    run: DeployRun,
    window: BrowserWindow | null,
    active: ActiveDeploy
  ): Promise<void> {
    for (let i = failedIndex; i >= 0; i--) {
      if (active.aborted) break
      const step = recipe.steps[i]
      if (!step.rollbackCommand) continue
      const cmd = renderTemplate(step.rollbackCommand, params)
      this.emit(window, run.id, {
        type: 'step_start',
        stepId: step.id,
        content: `回滚: ${step.name}`,
        run
      })
      try {
        await this.execWithTimeout(serverId, cmd, step.timeoutSec || 120, (chunk) => {
          this.emit(window, run.id, { type: 'step_stdout', stepId: step.id, content: chunk })
        })
        const sr = run.stepResults[i]
        if (sr) sr.status = 'rolled_back'
      } catch {
        // 回滚失败继续尝试更早步骤
      }
    }
    run.status = 'rolled_back'
    getDeployStore().saveRun(run)
  }
}

let instance: DeployService | null = null

export function getDeployService(): DeployService {
  if (!instance) instance = new DeployService()
  return instance
}
