import { resolve } from 'node:path'
import { createBackup, restoreBackup, pruneTrash } from './backup.ts'

const [command, source, destination, confirmation] = process.argv.slice(2)
if (!source || !destination || !['backup', 'restore', 'prune-trash'].includes(command) || (command === 'prune-trash' && confirmation !== '--confirm-delete')) {
  console.error('用法：npm run data -- backup <数据目录> <全新备份目录>\n      npm run data -- restore <备份目录> <全新数据目录>\n      npm run data -- prune-trash <数据目录> <全新备份目录> --confirm-delete')
  process.exitCode = 1
} else {
  try {
    const result = await (command === 'backup' ? createBackup : command === 'restore' ? restoreBackup : pruneTrash)(resolve(source), resolve(destination))
    console.log(`完成：${result.files} 个文件 → ${result.destination}`)
  } catch (error) { console.error(error instanceof Error ? error.message : '操作失败'); process.exitCode = 1 }
}
