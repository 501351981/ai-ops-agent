<template>
  <div class="file-browser">
    <div class="toolbar">
      <div ref="crumbsWrapRef" class="crumbs-wrap" :title="currentPath">
        <el-breadcrumb separator="/" class="crumbs">
          <el-breadcrumb-item>
            <a href="#" @click.prevent="selectDir('/')">/</a>
          </el-breadcrumb-item>
          <el-breadcrumb-item v-for="seg in breadcrumbs" :key="seg.path">
            <a href="#" @click.prevent="selectDir(seg.path)">{{ seg.name }}</a>
          </el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <el-input v-model="pathInput" size="small" class="path-input" @keyup.enter="gotoPath">
        <template #append>
          <el-button @click="gotoPath">前往</el-button>
        </template>
      </el-input>
      <div class="toolbar-actions">
        <el-button size="small" type="primary" :loading="uploading" @click="upload">上传</el-button>
        <el-button size="small" :loading="loading" @click="refreshAll">刷新</el-button>
      </div>
    </div>

    <el-alert v-if="listError" type="error" :closable="false" show-icon :title="listError" class="error-bar" />

    <div class="split">
      <aside class="dir-pane" v-loading="treeLoading">
        <div class="fav-block">
          <div class="pane-title">收藏</div>
          <div v-if="favorites.length === 0" class="fav-empty">
            点路径旁 ★，或右键目录进行收藏
          </div>
          <div
            v-for="fav in favorites"
            :key="fav.id"
            class="fav-item"
            :class="{ active: fav.path === currentPath }"
            @click="selectDir(fav.path)"
            @contextmenu.prevent="onFavContext(fav)"
          >
            <el-icon class="fav-icon"><StarFilled /></el-icon>
            <div class="fav-text">
              <div class="fav-name" :title="fav.path">{{ fav.name }}</div>
              <div class="fav-path mono" :title="fav.path">{{ fav.path }}</div>
            </div>
            <el-button class="fav-remove" link type="danger" @click.stop="removeFavorite(fav)">
              <el-icon><Close /></el-icon>
            </el-button>
          </div>
        </div>
        <div class="pane-title">目录</div>
        <el-tree
          ref="treeRef"
          :key="treeKey"
          class="dir-tree"
          node-key="path"
          highlight-current
          lazy
          :load="loadTreeNode"
          :props="treeProps"
          :expand-on-click-node="false"
          :current-node-key="currentPath"
          @node-click="onTreeClick"
          @node-contextmenu="onTreeContextMenu"
        >
          <template #default="{ data }">
            <span class="tree-node">
              <el-icon><Folder /></el-icon>
              <span class="tree-label" :title="data.label">{{ data.label }}</span>
              <el-icon v-if="isFavoritePath(data.path)" class="tree-star"><StarFilled /></el-icon>
            </span>
          </template>
        </el-tree>
      </aside>

      <section class="file-pane">
        <div class="pane-title">
          <div class="pane-title-left">
            <span>内容 · <span class="mono">{{ currentPath }}</span></span>
            <button
              class="star-btn"
              :class="{ active: isCurrentFavorite }"
              :title="isCurrentFavorite ? '取消收藏当前目录' : '收藏当前目录'"
              @click="toggleFavoriteCurrent"
            >
              <el-icon><StarFilled v-if="isCurrentFavorite" /><Star v-else /></el-icon>
            </button>
          </div>
          <span class="count">{{ files.length }} 项</span>
        </div>
        <el-table
          :data="files"
          v-loading="loading"
          height="100%"
          :empty-text="listError ? '加载失败' : '当前目录没有内容'"
          @row-dblclick="onFileRowOpen"
          @row-contextmenu="onFileRowContextMenu"
        >
          <el-table-column label="名称" min-width="220">
            <template #default="{ row }">
              <span
                class="name-cell"
                :class="{ clickable: row.type === 'directory' }"
                @click="onNameClick(row)"
              >
                <el-icon v-if="row.type === 'directory'"><Folder /></el-icon>
                <el-icon v-else-if="row.type === 'symlink'"><Link /></el-icon>
                <el-icon v-else><Document /></el-icon>
                {{ row.name }}
                <el-icon v-if="row.type === 'directory' && isFavoritePath(row.path)" class="row-star">
                  <StarFilled />
                </el-icon>
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ typeLabel(row.type) }}</template>
          </el-table-column>
          <el-table-column label="大小" width="100">
            <template #default="{ row }">
              {{ row.type === 'directory' ? '-' : formatSize(row.size) }}
            </template>
          </el-table-column>
          <el-table-column label="修改时间" width="170">
            <template #default="{ row }">
              {{ row.modifyTime ? new Date(row.modifyTime).toLocaleString() : '-' }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.type === 'directory'" link type="primary" @click="selectDir(row.path)">
                进入
              </el-button>
              <el-button v-if="row.type === 'file'" link type="primary" @click="download(row)">
                下载
              </el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <teleport to="body">
      <div
        v-if="ctxMenu.visible"
        class="ctx-menu"
        :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
        @click.stop
      >
        <button class="ctx-item" @click="onCtxFavorite">
          {{ isFavoritePath(ctxMenu.path) ? '取消收藏' : '收藏' }}
        </button>
        <button v-if="ctxMenu.source === 'tree' || ctxMenu.source === 'table'" class="ctx-item" @click="onCtxOpen">
          进入目录
        </button>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type ElTree } from 'element-plus'
import type Node from 'element-plus/es/components/tree/src/model/node'
import type { FavoriteDir, RemoteFileEntry } from '../../../shared/types'

interface TreeNode {
  path: string
  label: string
  isLeaf?: boolean
}

const props = defineProps<{ serverId: string }>()

const currentPath = ref('/')
const pathInput = ref('/')
const files = ref<RemoteFileEntry[]>([])
const favorites = ref<FavoriteDir[]>([])
const loading = ref(false)
const treeLoading = ref(false)
const uploading = ref(false)
const listError = ref('')
const treeKey = ref(0)
const treeRef = ref<InstanceType<typeof ElTree>>()
const crumbsWrapRef = ref<HTMLElement | null>(null)

const isCurrentFavorite = computed(() => favorites.value.some((f) => f.path === currentPath.value))

function isFavoritePath(path: string): boolean {
  return favorites.value.some((f) => f.path === path)
}

function ensureFavoritesApi(): boolean {
  if (!window.api?.favorites) {
    ElMessage.error('收藏 API 不可用，请完全退出后重新执行 pnpm dev（仅刷新页面不够）')
    return false
  }
  return true
}

async function loadFavorites(): Promise<void> {
  if (!window.api?.favorites) {
    favorites.value = []
    return
  }
  try {
    favorites.value = await window.api.favorites.list(props.serverId)
  } catch (err) {
    favorites.value = []
    console.error(err)
  }
}

async function toggleFavoriteCurrent(): Promise<void> {
  await toggleFavoritePath(currentPath.value)
}

async function toggleFavoritePath(path: string): Promise<void> {
  if (!ensureFavoritesApi()) return
  const normalized = normalizePath(path)
  try {
    if (isFavoritePath(normalized)) {
      await window.api.favorites.remove(props.serverId, normalized)
      ElMessage.success('已取消收藏')
    } else {
      await window.api.favorites.add(props.serverId, normalized)
      ElMessage.success('已加入收藏')
    }
    await loadFavorites()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeFavorite(fav: FavoriteDir): Promise<void> {
  if (!ensureFavoritesApi()) return
  try {
    await window.api.favorites.remove(props.serverId, fav.id)
    await loadFavorites()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function onFavContext(fav: FavoriteDir): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('修改收藏显示名称', '重命名', {
      inputValue: fav.name,
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    if (value?.trim()) {
      await window.api.favorites.rename(props.serverId, fav.id, value.trim())
      await loadFavorites()
    }
  } catch {
    // cancelled
  }
}

const ctxMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  path: '/',
  source: 'tree' as 'tree' | 'table'
})

function hideCtxMenu(): void {
  ctxMenu.value.visible = false
}

function showCtxMenu(event: MouseEvent, path: string, source: 'tree' | 'table'): void {
  ctxMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    path: normalizePath(path),
    source
  }
}

function onTreeContextMenu(event: Event, data: TreeNode): void {
  const e = event as MouseEvent
  e.preventDefault()
  e.stopPropagation()
  showCtxMenu(e, data.path, 'tree')
}

function onFileRowContextMenu(row: RemoteFileEntry, _column: unknown, event: Event): void {
  if (row.type !== 'directory') return
  const e = event as MouseEvent
  e.preventDefault()
  showCtxMenu(e, row.path, 'table')
}

async function onCtxFavorite(): Promise<void> {
  const path = ctxMenu.value.path
  hideCtxMenu()
  await toggleFavoritePath(path)
}

function onCtxOpen(): void {
  const path = ctxMenu.value.path
  hideCtxMenu()
  void selectDir(path)
}

let listSeq = 0
const dirCache = new Map<string, RemoteFileEntry[]>()

const treeProps = {
  label: 'label',
  children: 'children',
  isLeaf: 'isLeaf'
}

const breadcrumbs = computed(() => {
  if (currentPath.value === '/') return []
  const parts = currentPath.value.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const segs: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    segs.push({ name: part, path: acc })
  }
  return segs
})

function typeLabel(type: string): string {
  if (type === 'directory') return '目录'
  if (type === 'file') return '文件'
  if (type === 'symlink') return '链接'
  return type
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function normalizePath(path: string): string {
  let p = path.trim() || '/'
  if (!p.startsWith('/')) p = '/' + p
  const parts = p.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`
}

async function listEntries(path: string, useCache = false): Promise<RemoteFileEntry[]> {
  const normalized = normalizePath(path)
  if (useCache && dirCache.has(normalized)) return dirCache.get(normalized)!
  const entries = await window.api.files.list(props.serverId, normalized)
  dirCache.set(normalized, entries)
  return entries
}

async function loadTreeNode(node: Node, resolve: (data: TreeNode[]) => void): Promise<void> {
  try {
    const path = node.level === 0 ? '/' : (node.data as TreeNode).path
    const entries = await listEntries(path)
    const dirs = entries
      .filter((e) => e.type === 'directory' && e.name !== '.' && e.name !== '..')
      .map((e) => ({
        path: e.path,
        label: e.name,
        isLeaf: false
      }))
    resolve(dirs)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
    resolve([])
  }
}

async function loadFiles(path: string): Promise<void> {
  const seq = ++listSeq
  const normalized = normalizePath(path)
  loading.value = true
  listError.value = ''
  try {
    const entries = await listEntries(normalized)
    if (seq !== listSeq) return
    files.value = entries.filter((e) => e.name !== '.' && e.name !== '..')
    pathInput.value = normalized
  } catch (err) {
    if (seq !== listSeq) return
    files.value = []
    listError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (seq === listSeq) loading.value = false
  }
}

async function expandToPath(path: string): Promise<void> {
  await nextTick()
  const tree = treeRef.value
  if (!tree) return

  if (path === '/') {
    tree.setCurrentKey('/')
    return
  }

  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    const node = tree.getNode(acc)
    if (node && !node.expanded) {
      node.expand()
      // 等待懒加载
      await new Promise((r) => setTimeout(r, 80))
    }
  }
  tree.setCurrentKey(path)
}

async function scrollCrumbsEnd(): Promise<void> {
  await nextTick()
  const el = crumbsWrapRef.value
  if (el) el.scrollLeft = el.scrollWidth
}

async function selectDir(path: string): Promise<void> {
  const normalized = normalizePath(path)
  currentPath.value = normalized
  await loadFiles(normalized)
  await expandToPath(normalized)
  await scrollCrumbsEnd()
}

function onTreeClick(data: TreeNode): void {
  void selectDir(data.path)
}

function onNameClick(row: RemoteFileEntry): void {
  if (row.type === 'directory') void selectDir(row.path)
}

function onFileRowOpen(row: RemoteFileEntry): void {
  if (row.type === 'directory') void selectDir(row.path)
}

function gotoPath(): void {
  void selectDir(pathInput.value)
}

async function refreshAll(): Promise<void> {
  dirCache.clear()
  treeKey.value += 1
  await selectDir(currentPath.value)
}

async function upload(): Promise<void> {
  uploading.value = true
  try {
    const result = await window.api.files.upload(props.serverId, currentPath.value)
    if (result.uploaded > 0) {
      ElMessage.success(`已上传 ${result.uploaded} 个文件`)
      dirCache.delete(currentPath.value)
      await loadFiles(currentPath.value)
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    uploading.value = false
  }
}

async function download(row: RemoteFileEntry): Promise<void> {
  try {
    const result = await window.api.files.download(props.serverId, row.path, row.name)
    if (result.ok) ElMessage.success('下载完成')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function remove(row: RemoteFileEntry): Promise<void> {
  await ElMessageBox.confirm(
    row.type === 'directory'
      ? `确认删除目录 ${row.path}？（仅支持空目录）`
      : `确认删除 ${row.path}？`,
    '删除确认',
    { type: 'warning' }
  )
  try {
    await window.api.files.delete(props.serverId, row.path, row.type === 'directory')
    ElMessage.success('已删除')
    if (row.type === 'directory') await refreshAll()
    else {
      dirCache.delete(currentPath.value)
      await loadFiles(currentPath.value)
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

watch(
  () => props.serverId,
  () => {
    dirCache.clear()
    currentPath.value = '/'
    treeKey.value += 1
    listError.value = ''
    void loadFavorites()
    void selectDir('/')
  }
)

onMounted(() => {
  treeLoading.value = true
  void loadFavorites()
  void selectDir('/').finally(() => {
    treeLoading.value = false
  })
  window.addEventListener('click', hideCtxMenu)
  window.addEventListener('scroll', hideCtxMenu, true)
})

onUnmounted(() => {
  window.removeEventListener('click', hideCtxMenu)
  window.removeEventListener('scroll', hideCtxMenu, true)
})
</script>

<style scoped>
.file-browser {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 420px;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.crumbs-wrap {
  flex: 0 0 320px;
  width: 320px;
  margin-right: auto;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: thin;
}

.crumbs {
  display: inline-flex;
  flex-wrap: nowrap;
  font-size: 12px;
  line-height: 24px;
}

.crumbs :deep(.el-breadcrumb__item) {
  float: none;
  display: inline-flex;
  align-items: center;
}

.crumbs :deep(.el-breadcrumb__inner),
.crumbs :deep(.el-breadcrumb__inner a) {
  color: var(--accent);
  font-weight: 500;
  font-size: 12px;
}

.crumbs :deep(.el-breadcrumb__separator) {
  margin: 0 4px;
  font-weight: 400;
}

.path-input {
  flex: 0 0 280px;
  width: 280px;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.error-bar {
  flex-shrink: 0;
}

.split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 12px;
}

.dir-pane,
.file-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #121a26;
  overflow: hidden;
}

.fav-block {
  flex-shrink: 0;
  max-height: 38%;
  overflow: auto;
  border-bottom: 1px solid var(--border);
}

.fav-empty {
  padding: 8px 12px 12px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.fav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
}

.fav-item:hover,
.fav-item.active {
  background: rgba(61, 156, 240, 0.12);
}

.fav-icon {
  color: var(--warning);
  flex-shrink: 0;
}

.fav-text {
  min-width: 0;
  flex: 1;
}

.fav-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-path {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-remove {
  opacity: 0;
  flex-shrink: 0;
}

.fav-item:hover .fav-remove {
  opacity: 1;
}

.pane-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--text-muted);
  flex-shrink: 0;
  gap: 8px;
}

.pane-title-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.star-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.star-btn:hover {
  background: rgba(240, 180, 41, 0.15);
  color: var(--warning);
}

.star-btn.active {
  color: var(--warning);
}

.tree-star,
.row-star {
  color: var(--warning);
  margin-left: 4px;
  font-size: 12px;
  flex-shrink: 0;
}

.ctx-menu {
  position: fixed;
  z-index: 4000;
  min-width: 140px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.ctx-item {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.count {
  font-size: 12px;
}

.dir-tree {
  flex: 1;
  overflow: auto;
  padding: 8px;
  background: transparent;
  --el-tree-node-hover-bg-color: rgba(61, 156, 240, 0.12);
  --el-fill-color-blank: transparent;
}

.dir-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: rgba(61, 156, 240, 0.18);
  color: var(--accent);
}

.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-pane :deep(.el-table) {
  flex: 1;
}

.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.name-cell.clickable {
  cursor: pointer;
  color: var(--accent);
}

.mono {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text);
}
</style>
