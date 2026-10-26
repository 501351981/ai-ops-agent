<template>
  <div class="monitor-panel">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="title">{{ bundle?.manifest.name || '监控' }}</span>
        <span v-if="bundle" class="meta mono">
          v{{ bundle.manifest.version }} · 每 {{ intervalSec }}s
        </span>
        <span v-if="lastAt" class="meta">更新于 {{ formatTime(lastAt) }}</span>
        <el-popover
          v-if="bundle"
          placement="bottom-start"
          :width="420"
          trigger="hover"
          :show-after="200"
        >
          <template #reference>
            <el-tag
              size="small"
              class="status-tag"
              :type="statusTagType"
            >
              {{ statusLabel }}
            </el-tag>
          </template>
          <div class="debug-pop mono">
            <div>采集: {{ status }} · keys={{ payloadKeys || '(无)' }}</div>
            <div>投递: {{ deliverInfo }}</div>
            <div v-if="lastPayload" class="debug-json">{{ payloadPreview }}</div>
            <div v-else class="debug-json">暂无采集数据</div>
          </div>
        </el-popover>
      </div>
      <div v-if="bundle" class="toolbar-actions">
        <el-input-number
          v-model="intervalSec"
          size="small"
          :min="2"
          :max="300"
          controls-position="right"
          @change="onIntervalChange"
        />
        <el-button size="small" :loading="refreshing" @click="manualRefresh">刷新</el-button>
        <el-button size="small" type="danger" plain @click="clearDashboard">删除</el-button>
      </div>
    </div>

    <el-alert
      v-if="errorMsg"
      type="error"
      :closable="true"
      show-icon
      :title="errorMsg"
      class="error-bar"
      @close="errorMsg = ''"
    />

    <div v-if="!loaded" class="empty-wrap" v-loading="true" />

    <div v-else-if="!bundle" class="empty-wrap">
      <el-empty>
        <template #description>
          <p class="empty-title">尚未配置监控</p>
          <p class="empty-desc">请在「AI 对话运维」中创建监控画面</p>
          <p class="hint mono">例如：帮我增加监控指标 CPU、内存、硬盘使用情况</p>
        </template>
        <el-button type="primary" @click="$emit('goto-chat')">去 AI 对话创建</el-button>
      </el-empty>
    </div>

    <div v-else class="frame-wrap">
      <iframe
        ref="iframeRef"
        class="dash-frame"
        :srcdoc="frameHtml"
        title="monitor-dashboard"
        @load="onFrameLoad"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MonitorBundle, MonitorDataEvent } from '../../../shared/types'

/**
 * 监控画面数据协议（宿主负责投递，AI 只负责渲染）：
 * 1. collectScript stdout → JSON
 * 2. 宿主调用 iframe 内 window.__aiopsPush(data)
 * 3. AI 实现 window.renderMonitor(data) 更新任意 UI
 */

const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ (e: 'goto-chat'): void; (e: 'cleared'): void }>()

const loaded = ref(false)
const bundle = ref<MonitorBundle | null>(null)
const iframeRef = ref<HTMLIFrameElement | null>(null)
const frameHtml = ref('')
const frameReady = ref(false)
const lastPayload = ref<Record<string, unknown> | null>(null)
const lastAt = ref<number | null>(null)
const status = ref<'idle' | 'collecting' | 'ok' | 'error'>('idle')
const errorMsg = ref('')
const refreshing = ref(false)
const intervalSec = ref(5)
const deliverInfo = ref('尚未投递')

let unsubscribe: (() => void) | null = null
let pollReloadTimer: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null

const statusLabel = computed(() => {
  if (status.value === 'ok') return '正常'
  if (status.value === 'error') return '异常'
  if (status.value === 'collecting') return '采集中'
  return '等待数据'
})
const statusTagType = computed(() => {
  if (status.value === 'ok') return 'success'
  if (status.value === 'error') return 'danger'
  if (status.value === 'collecting') return 'warning'
  return 'info'
})

const payloadKeys = computed(() =>
  lastPayload.value ? Object.keys(lastPayload.value).join(',') : ''
)
const payloadPreview = computed(() => {
  if (!lastPayload.value) return ''
  try {
    const s = JSON.stringify(lastPayload.value)
    return s.length > 500 ? `${s.slice(0, 500)}…` : s
  } catch {
    return String(lastPayload.value)
  }
})

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** 宿主运行时：统一入口 __aiopsPush → renderMonitor（AI 实现） */
function hostRuntimeScript(): string {
  return `<script>(function(){
  var pending=null;
  var msgHandlers=[];
  var origAdd=window.addEventListener.bind(window);
  window.addEventListener=function(type,fn,opt){
    if(String(type)==='message' && typeof fn==='function') msgHandlers.push(fn);
    return origAdd(type,fn,opt);
  };
  function callRender(data){
    if(typeof window.renderMonitor==='function'){
      window.renderMonitor(data);
      return 'renderMonitor';
    }
    // 兼容旧版：AI 只写了 message 监听
    if(msgHandlers.length){
      var ev={data:{type:'metrics',data:data},origin:'*',source:null};
      for(var i=0;i<msgHandlers.length;i++){
        try{ msgHandlers[i].call(window,ev); }catch(e){}
      }
      return 'message-handlers:'+msgHandlers.length;
    }
    return null;
  }
  window.__aiopsPush=function(data){
    if(!data) return {ok:false,reason:'empty'};
    pending=data;
    var via=callRender(data);
    if(via) return {ok:true,via:via};
    return {ok:false,reason:'waiting-renderMonitor'};
  };
  window.__aiopsFlushPending=function(){
    if(!pending) return {ok:false,reason:'no-pending'};
    return window.__aiopsPush(pending);
  };
  // AI 脚本后置定义 renderMonitor 时补推
  var tries=0;
  var timer=setInterval(function(){
    tries++;
    if(typeof window.renderMonitor==='function' && pending){
      callRender(pending);
    }
    if(tries>50) clearInterval(timer);
  },200);
  try{ parent.postMessage({type:'aiops-monitor-ready'},'*'); }catch(e){}
})();<\/script>`
}

function buildFrameHtml(raw: string): string {
  const runtime = hostRuntimeScript()
  let html = raw.trim()
  // CDN 脚本 defer，避免阻塞；AI 内联脚本仍按文档顺序执行
  html = html.replace(/<script([^>]*\bsrc=(['"]).*?\2[^>]*)>/gi, (full, attrs) => {
    const a = String(attrs)
    if (/\basync\b/i.test(a) || /\bdefer\b/i.test(a)) return full
    return `<script defer ${a.trim()}>`
  })
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${runtime}`)
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${runtime}</head>`)
  } else {
    html = `<!DOCTYPE html><html><head>${runtime}</head><body>${html}</body></html>`
  }
  return html
}

function setFrameFromBundle(html: string): void {
  frameReady.value = false
  deliverInfo.value = '看板已加载，等待投递'
  frameHtml.value = buildFrameHtml(html)
}

type PushResult = { ok: boolean; via?: string; reason?: string }

function pushToFrame(data: Record<string, unknown>): void {
  const win = iframeRef.value?.contentWindow as
    | (Window & {
        __aiopsPush?: (d: Record<string, unknown>) => PushResult
        __aiopsFlushPending?: () => PushResult
        renderMonitor?: (d: Record<string, unknown>) => void
      })
    | null

  if (!win) {
    deliverInfo.value = '失败: iframe.contentWindow 为空'
    return
  }

  try {
    // 同源 srcdoc：直接调宿主入口（不依赖 postMessage）
    if (typeof win.__aiopsPush === 'function') {
      const result = win.__aiopsPush(data)
      if (result?.ok) {
        deliverInfo.value = `成功 via ${result.via}`
      } else {
        deliverInfo.value = `暂未渲染: ${result?.reason || 'unknown'}（若 AI 未实现 renderMonitor，需重新对话生成）`
        // 再试 flush
        const again = win.__aiopsFlushPending?.()
        if (again?.ok) deliverInfo.value = `成功 via ${again.via} (flush)`
      }
      return
    }
  } catch (err) {
    deliverInfo.value = `失败: 调用 __aiopsPush 异常 — ${err instanceof Error ? err.message : String(err)}`
    return
  }

  // 极端兜底
  try {
    win.postMessage({ type: 'metrics', data }, '*')
    deliverInfo.value = '已 postMessage（无 __aiopsPush，可能宿主脚本未注入）'
  } catch (err) {
    deliverInfo.value = `失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

function flushMetrics(): void {
  if (lastPayload.value) pushToFrame(lastPayload.value)
}

function onFrameLoad(): void {
  frameReady.value = true
  nextTick(() => flushMetrics())
}

function handleData(event: MonitorDataEvent): void {
  lastAt.value = event.collectedAt
  if (event.ok && event.data) {
    status.value = 'ok'
    errorMsg.value = ''
    lastPayload.value = event.data
    flushMetrics()
  } else {
    status.value = 'error'
    errorMsg.value = event.error || '采集失败'
  }
}

async function loadBundle(startPolling = true): Promise<void> {
  const next = await window.api.monitor.get(props.serverId)
  const prevUpdated = bundle.value?.updatedAt
  bundle.value = next
  intervalSec.value = next?.manifest.intervalSec ?? 5
  loaded.value = true

  if (!next) {
    status.value = 'idle'
    frameReady.value = false
    lastPayload.value = null
    frameHtml.value = ''
    await window.api.monitor.stop(props.serverId)
    return
  }

  if (prevUpdated !== next.updatedAt || !frameHtml.value) {
    setFrameFromBundle(next.html)
  }

  if (startPolling) {
    status.value = status.value === 'ok' ? 'ok' : 'collecting'
    await window.api.monitor.start(props.serverId)
  }
}

async function manualRefresh(): Promise<void> {
  if (!bundle.value) return
  refreshing.value = true
  status.value = 'collecting'
  try {
    // 只触发一次采集；若定时轮询正在飞，会复用同一结果，不再误报「尚未完成」
    await window.api.monitor.start(props.serverId)
    const event = await window.api.monitor.refresh(props.serverId)
    handleData(event)
  } catch (err) {
    status.value = 'error'
    errorMsg.value = err instanceof Error ? err.message : String(err)
    ElMessage.error(errorMsg.value)
  } finally {
    refreshing.value = false
  }
}

async function onIntervalChange(val: number | undefined): Promise<void> {
  if (!bundle.value || val == null) return
  try {
    const updated = await window.api.monitor.updateInterval(props.serverId, val)
    bundle.value = updated
    ElMessage.success(`轮询间隔已设为 ${val}s`)
  } catch (err) {
    intervalSec.value = bundle.value.manifest.intervalSec
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function clearDashboard(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定删除当前监控看板？', '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await window.api.monitor.clear(props.serverId)
  bundle.value = null
  status.value = 'idle'
  lastPayload.value = null
  lastAt.value = null
  errorMsg.value = ''
  frameHtml.value = ''
  ElMessage.success('已删除监控看板')
  emit('cleared')
}

function bindStream(): void {
  unsubscribe?.()
  unsubscribe = window.api.monitor.onData(props.serverId, handleData)
}

onMounted(async () => {
  bindStream()
  window.addEventListener('message', onHostReady)
  await loadBundle(true)
  pollReloadTimer = setInterval(() => {
    void (async () => {
      const latest = await window.api.monitor.get(props.serverId)
      if (!latest) {
        if (bundle.value) {
          bundle.value = null
          status.value = 'idle'
          frameHtml.value = ''
          await window.api.monitor.stop(props.serverId)
        }
        return
      }
      if (!bundle.value || latest.updatedAt !== bundle.value.updatedAt) {
        await loadBundle(true)
      }
    })()
  }, 4000)
  flushTimer = setInterval(() => {
    if (lastPayload.value && frameReady.value) flushMetrics()
  }, 2000)
})

function onHostReady(ev: MessageEvent): void {
  const data = ev.data as { type?: string } | null
  if (data?.type === 'aiops-monitor-ready') {
    frameReady.value = true
    flushMetrics()
  }
}

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  if (pollReloadTimer) clearInterval(pollReloadTimer)
  if (flushTimer) clearInterval(flushTimer)
  window.removeEventListener('message', onHostReady)
  void window.api.monitor.stop(props.serverId)
})

watch(
  () => props.serverId,
  async () => {
    frameReady.value = false
    lastPayload.value = null
    status.value = 'idle'
    bindStream()
    await loadBundle(true)
  }
)
</script>

<style scoped>
.monitor-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.title {
  font-weight: 600;
  font-size: 14px;
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.error-bar {
  flex-shrink: 0;
}

.status-tag {
  cursor: default;
}

.debug-pop {
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-muted);
  max-height: 240px;
  overflow: auto;
}

.debug-json {
  margin-top: 6px;
  color: #9db7d4;
  word-break: break-all;
  white-space: pre-wrap;
}

.empty-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 280px;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.empty-desc {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-muted);
}

.hint {
  margin: 0 0 14px;
  color: var(--accent);
  font-size: 12px;
}

.frame-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: #0b1017;
}

.dash-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #0b1017;
}

.mono {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
}
</style>
