/** 从拖放事件解析本机绝对路径（需 preload files.getPathForFile） */
export function getDroppedFilePaths(event: DragEvent): string[] {
  const list = event.dataTransfer?.files
  if (!list?.length) return []
  const paths: string[] = []
  for (let i = 0; i < list.length; i++) {
    const file = list.item(i)
    if (!file) continue
    try {
      const p = window.api.files.getPathForFile(file)?.trim()
      if (p) paths.push(p)
    } catch {
      // ignore single file failure
    }
  }
  return paths
}

/** 把路径插入输入框：已有内容则空格拼接 */
export function appendPathsToInput(current: string, paths: string[]): string {
  if (!paths.length) return current
  const chunk = paths.join(' ')
  const base = current.trimEnd()
  return base ? `${base} ${chunk}` : chunk
}
