export function parseReceiptFile(content: string, origin: string, uploadToken: string) {
  if (content.length > 16384) throw new Error('回执文件过大，请选择集屿保存的 .txt 回执。')
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const value = (label: string) => {
    const matches = lines.filter(line => line.startsWith(`${label}：`))
    if (matches.length !== 1) throw new Error('回执格式不完整，请选择“保存私密回执”下载的文件。')
    return matches[0].slice(label.length + 1).trim()
  }
  const link = value('收集链接'), receiptId = value('回执编号'), key = value('私密凭证')
  let url: URL
  try { url = new URL(link) } catch { throw new Error('回执中的收集链接无效。') }
  if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash !== `#/submit/${uploadToken}` || url.username || url.password) throw new Error('这份回执属于其他收集或访问地址，请回到原收集页面导入。')
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receiptId) || !/^[a-zA-Z0-9_-]{32,100}$/.test(key)) throw new Error('回执编号或私密凭证格式无效，请检查文件是否完整。')
  return { receiptId, key }
}
