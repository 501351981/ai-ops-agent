<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>系统设置</h2>
        <p>数据存储位置与运维安全策略</p>
      </div>
    </div>

    <div class="card-panel section">
      <h3>数据存储</h3>
      <p class="hint">
        服务器、模型配置、聊天记录、收藏目录都保存在本地 JSON 文件中。
        可自定义目录；路径指针本身存放在应用固定配置里。
      </p>
      <el-alert
        v-if="loadError"
        type="error"
        :closable="false"
        show-icon
        :title="loadError"
        class="mb"
      />
      <el-form label-width="120px" style="max-width: 820px" v-loading="loading">
        <el-form-item label="数据目录">
          <div class="path-row">
            <el-input class="path-input" :model-value="location?.dataDir || ''" readonly />
            <el-button :loading="changing" @click="chooseDir">更改位置</el-button>
            <el-button
              v-if="location && !location.isDefault"
              :loading="changing"
              @click="resetDir"
            >
              恢复默认
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="数据文件">
          <div class="mono path-text">{{ location?.storeFile || '—' }}</div>
        </el-form-item>
        <el-form-item label="默认目录">
          <div class="mono path-text muted">{{ location?.defaultDataDir || '—' }}</div>
        </el-form-item>
      </el-form>
    </div>

    <div class="card-panel section">
      <h3>安全策略</h3>
      <el-form label-width="160px" style="max-width: 640px">
        <el-form-item label="只读工具自动确认">
          <el-switch
            :model-value="store.settings.autoConfirmReadonly"
            @change="(v: string | number | boolean) => updateSetting({ autoConfirmReadonly: Boolean(v) })"
          />
          <span class="form-tip">如 list_dir / get_system_info 等只读操作可不弹确认</span>
        </el-form-item>
        <el-form-item label="拦截高危命令">
          <el-switch
            :model-value="store.settings.blockDangerousCommands"
            @change="(v: string | number | boolean) => updateSetting({ blockDangerousCommands: Boolean(v) })"
          />
          <span class="form-tip">匹配到 rm -rf /、mkfs 等模式时直接拒绝执行</span>
        </el-form-item>
        <el-form-item label="最大工具轮次">
          <el-input-number
            :model-value="store.settings.maxAgentRounds ?? 20"
            :min="4"
            :max="40"
            @change="(v: number | undefined) => updateSetting({ maxAgentRounds: v ?? 20 })"
          />
          <span class="form-tip">模型往返次数上限；触顶后会强制要一次文字总结</span>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AppSettings, DataLocationInfo } from '../../../shared/types'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const location = ref<DataLocationInfo | null>(null)
const changing = ref(false)
const loading = ref(false)
const loadError = ref('')

function ensureDataApi(): boolean {
  if (!window.api?.data) {
    ElMessage.error('数据目录 API 不可用，请完全退出后重新执行 pnpm dev（仅刷新页面不够）')
    return false
  }
  return true
}

async function refreshLocation(): Promise<void> {
  if (!ensureDataApi()) {
    loadError.value = '主进程/preload 未加载最新代码，请重启应用'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    location.value = await window.api.data.location()
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function chooseDir(): Promise<void> {
  if (!ensureDataApi()) return
  try {
    const picked = await window.api.data.chooseDir()
    if (picked.canceled || !picked.path) return

    try {
      await ElMessageBox.confirm(
        `将数据目录切换到：\n${picked.path}\n\n若目标目录还没有数据文件，会自动从当前位置复制一份。`,
        '更改数据存储位置',
        { type: 'warning', confirmButtonText: '切换并迁移', cancelButtonText: '取消' }
      )
    } catch {
      return
    }

    changing.value = true
    const result = await window.api.data.setDir(picked.path, true)
    if (!result.ok) {
      ElMessage.error(result.message)
      return
    }
    location.value = result.info
    await store.refreshAll()
    ElMessage.success(result.message)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    changing.value = false
  }
}

async function resetDir(): Promise<void> {
  if (!ensureDataApi()) return
  try {
    await ElMessageBox.confirm(
      '恢复到应用默认数据目录？若默认目录没有数据，会从当前目录复制一份。',
      '恢复默认',
      { type: 'warning' }
    )
  } catch {
    return
  }

  changing.value = true
  try {
    const result = await window.api.data.resetDir(true)
    if (!result.ok) {
      ElMessage.error(result.message)
      return
    }
    location.value = result.info
    await store.refreshAll()
    ElMessage.success(result.message)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    changing.value = false
  }
}

async function updateSetting(partial: Partial<AppSettings>): Promise<void> {
  store.settings = await window.api.settings.update(partial)
  ElMessage.success('设置已更新')
}

onMounted(async () => {
  await store.refreshAll()
  await refreshLocation()
})
</script>

<style scoped>
.section h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.hint {
  margin: 0 0 16px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.mb {
  margin-bottom: 12px;
}

.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
}

.path-input {
  flex: 1;
  min-width: 0;
}

.path-text {
  font-size: 12px;
  word-break: break-all;
}

.muted {
  color: var(--text-muted);
}

.form-tip {
  margin-left: 12px;
  color: var(--text-muted);
  font-size: 12px;
}

.mono {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
}
</style>
