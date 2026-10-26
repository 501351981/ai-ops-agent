import { getStore } from './credential-store'

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** DeepSeek thinking：带 tools 时后续请求必须回传 */
  reasoning_content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmCompletionResult {
  content: string | null
  reasoningContent?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finish_reason?: string
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 120_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LLM 请求超时（>${Math.round(timeoutMs / 1000)}s）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class LlmClient {
  async chat(
    providerId: string,
    messages: LlmChatMessage[],
    tools?: LlmToolDef[]
  ): Promise<LlmCompletionResult> {
    const provider = getStore().getProviderSecret(providerId)
    if (!provider) throw new Error('未找到 LLM Provider')

    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      temperature: provider.temperature ?? 0.3
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    // DeepSeek V4 / Flash：默认思考模式；显式开启，兼容官方 thinking 参数
    if (/deepseek/i.test(provider.model) || /deepseek/i.test(provider.baseUrl)) {
      body.thinking = { type: 'enabled' }
    }

    const url = `${provider.baseUrl}/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`
    }

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 500)}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null
          reasoning_content?: string | null
          tool_calls?: LlmCompletionResult['tool_calls']
        }
        finish_reason?: string
      }>
    }

    const choice = data.choices?.[0]
    if (!choice) throw new Error('LLM 返回空 choices')

    return {
      content: choice.message?.content ?? null,
      reasoningContent: choice.message?.reasoning_content ?? null,
      tool_calls: choice.message?.tool_calls,
      finish_reason: choice.finish_reason
    }
  }

  async testConnection(
    providerId: string,
    overrides?: { baseUrl?: string; model?: string; apiKey?: string }
  ): Promise<{ ok: boolean; message: string }> {
    const secret = getStore().getProviderSecret(providerId)
    if (!secret) return { ok: false, message: '未找到 LLM Provider' }
    return this.testConnectionWithConfig({
      baseUrl: overrides?.baseUrl || secret.baseUrl,
      model: overrides?.model || secret.model,
      apiKey: overrides?.apiKey || secret.apiKey
    })
  }

  async testConnectionWithConfig(input: {
    baseUrl: string
    apiKey?: string
    model: string
  }): Promise<{ ok: boolean; message: string }> {
    const baseUrl = input.baseUrl.replace(/\/$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: input.model,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            temperature: 0,
            max_tokens: 16
          })
        },
        30_000
      )
      if (!res.ok) {
        const text = await res.text()
        return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 300)}` }
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      if (!data.choices?.length) {
        return { ok: false, message: '连接异常：返回空 choices' }
      }
      const content = data.choices[0]?.message?.content || ''
      return {
        ok: true,
        message: `连接成功（模型 ${input.model}），回复: ${content.slice(0, 80) || '（空）'}`
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}

let llmInstance: LlmClient | null = null

export function getLlmClient(): LlmClient {
  if (!llmInstance) llmInstance = new LlmClient()
  return llmInstance
}
