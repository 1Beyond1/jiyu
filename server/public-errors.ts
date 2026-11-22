// Presentation only: callers retain the original HTTP status and { error } envelope.
export function publicSubmissionError(status: number, message: string) {
  if (status === 507) return '服务器磁盘空间不足，请联系发起人处理后重试。'
  if (status >= 500) return '服务暂时无法完成提交，请稍后重试；已有私密回执请保留。'
  const known: Record<string, string> = {
    收集链接无效或已撤销: '收集链接无效或已撤销，请向发起人获取新链接。',
    收集链接已失效: '收集链接已失效，请向发起人获取新链接。',
    '这项收集已暂停、结束或截止': '这项收集已暂停、结束或截止，请联系发起人。',
    续传凭证不匹配: '续传凭证不匹配，请使用原浏览器重试或重新开始上传。',
    续传凭证无效: '续传凭证无效，请使用原浏览器重试或重新开始上传。',
    上传编号无效: '上传编号无效，请重新打开收集链接后提交。',
    提交数量超过任务限制: '提交数量超过任务限制，请减少文件后重试。',
    单次提交总量超过上限: '单次提交总量超过上限，请减少本批文件大小后重试。',
    任务或存储总容量超过上限: '任务或存储总容量超过上限，请联系发起人清理或扩容。',
    '已达到 10000 个文件的上限': '已达到收集文件数量上限，请联系发起人处理。',
    文件大小或修改时间无效: '文件大小或修改时间无效，请重新选择文件后提交。',
    分片序号无效: '上传片段无效，请重新选择原文件后重试。',
    分片大小不匹配: '上传片段大小不匹配，请重新选择原文件后重试。',
  }
  if (known[message]) return known[message]
  if (/请|联系|重试|稍后/.test(message)) return message
  return `${message.replace(/[。；，]$/, '')}，请检查提交信息后重试。`
}
