import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  DeploymentRecipe,
  DeploymentRecipeInput,
  DeployProject,
  DeployRun
} from '../../shared/types'
import {
  ensureDeployProjectDir,
  getDeployMetaPath,
  getDeployProjectDir,
  getDeployRecipePath,
  getDeployRunPath,
  getDeployRunsDir,
  getDeploysDir
} from './app-paths'

/**
 * 部署配方分文件存储：
 *   {dataDir}/deploys/{projectId}/meta.json
 *   {dataDir}/deploys/{projectId}/recipe.json
 *   {dataDir}/deploys/{projectId}/runs/{runId}.json
 */
export class DeployStore {
  constructor() {
    getDeploysDir()
  }

  reload(): void {
    getDeploysDir()
  }

  listProjects(): DeployProject[] {
    const root = getDeploysDir()
    if (!existsSync(root)) return []
    const projects: DeployProject[] = []
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const project = this.getProject(name.name)
      if (project) projects.push(project)
    }
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return projects
  }

  getProject(projectId: string): DeployProject | null {
    const path = getDeployMetaPath(projectId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as DeployProject
    } catch {
      return null
    }
  }

  createProject(name: string, serverId?: string): DeployProject {
    const id = randomUUID()
    const now = Date.now()
    const project: DeployProject = {
      id,
      name: name.trim() || '未命名项目',
      activeRecipeId: null,
      serverIds: serverId ? [serverId] : [],
      createdAt: now,
      updatedAt: now
    }
    ensureDeployProjectDir(id)
    writeFileSync(getDeployMetaPath(id), JSON.stringify(project, null, 2), 'utf8')
    return { ...project }
  }

  updateProject(projectId: string, patch: Partial<DeployProject>): DeployProject {
    const existing = this.getProject(projectId)
    if (!existing) throw new Error('项目不存在')
    const next: DeployProject = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }
    writeFileSync(getDeployMetaPath(projectId), JSON.stringify(next, null, 2), 'utf8')
    return { ...next }
  }

  deleteProject(projectId: string): boolean {
    const dir = getDeployProjectDir(projectId)
    if (!existsSync(dir)) return false
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  getRecipe(projectId: string): DeploymentRecipe | null {
    const path = getDeployRecipePath(projectId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecipe
    } catch {
      return null
    }
  }

  saveRecipe(input: DeploymentRecipeInput, status: DeploymentRecipe['status'] = 'active'): DeploymentRecipe {
    const name = (input.name || '').trim()
    if (!name) throw new Error('配方名称不能为空')
    if (!input.projectId) throw new Error('缺少 projectId')
    if (!input.serverId) throw new Error('缺少 serverId')
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new Error('至少需要一个部署步骤')
    }

    const project = this.getProject(input.projectId)
    if (!project) throw new Error('项目不存在，请先创建项目')

    const existing = this.getRecipe(input.projectId)
    const now = Date.now()
    const recipe: DeploymentRecipe = {
      id: input.id || existing?.id || randomUUID(),
      projectId: input.projectId,
      name,
      kind: input.kind,
      version: existing ? existing.version + 1 : 1,
      serverId: input.serverId,
      params: input.params || [],
      assertions: input.assertions || [],
      steps: input.steps,
      healthCheck: input.healthCheck,
      notes: input.notes,
      sourceIntent: input.sourceIntent ?? existing?.sourceIntent,
      status,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    ensureDeployProjectDir(input.projectId)
    writeFileSync(getDeployRecipePath(input.projectId), JSON.stringify(recipe, null, 2), 'utf8')

    const serverIds = new Set(project.serverIds)
    serverIds.add(input.serverId)
    this.updateProject(input.projectId, {
      name,
      activeRecipeId: status === 'active' ? recipe.id : project.activeRecipeId ?? null,
      // draft 不覆盖 active；若尚无 active 且本次 active 则已在上一行设置
      serverIds: [...serverIds]
    })

    return { ...recipe }
  }

  saveRun(run: DeployRun): DeployRun {
    ensureDeployProjectDir(run.projectId)
    getDeployRunsDir(run.projectId)
    writeFileSync(getDeployRunPath(run.projectId, run.id), JSON.stringify(run, null, 2), 'utf8')
    return { ...run }
  }

  getRun(projectId: string, runId: string): DeployRun | null {
    const path = getDeployRunPath(projectId, runId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as DeployRun
    } catch {
      return null
    }
  }

  /** 按 runId 在所有项目中查找（confirm/cancel 用） */
  findRun(runId: string): DeployRun | null {
    for (const project of this.listProjects()) {
      const run = this.getRun(project.id, runId)
      if (run) return run
    }
    return null
  }

  listRuns(projectId: string, limit = 50): DeployRun[] {
    const dir = getDeployRunsDir(projectId)
    if (!existsSync(dir)) return []
    const runs: DeployRun[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const run = JSON.parse(readFileSync(join(dir, file), 'utf8')) as DeployRun
        runs.push(run)
      } catch {
        // skip
      }
    }
    runs.sort((a, b) => b.createdAt - a.createdAt)
    return runs.slice(0, limit)
  }

  markLastSuccess(projectId: string, params: Record<string, string | number | boolean>): void {
    this.updateProject(projectId, {
      lastRunAt: Date.now(),
      lastSuccessParams: { ...params }
    })
  }

  touchLastRun(projectId: string): void {
    this.updateProject(projectId, { lastRunAt: Date.now() })
  }
}

let instance: DeployStore | null = null

export function getDeployStore(): DeployStore {
  if (!instance) instance = new DeployStore()
  return instance
}

export function reloadDeployStore(): DeployStore {
  if (instance) instance.reload()
  else instance = new DeployStore()
  return instance
}
