import { statfs } from 'node:fs/promises'
import type { StorageSpace } from '../src/types.ts'

export async function storageSpace(dataDir: string, usedBytes: number, quotaBytes: number, reservedBytes: number, readDisk = () => statfs(dataDir)): Promise<StorageSpace> {
  const base = { usedBytes, quotaBytes, reservedBytes, quotaRemainingBytes: Math.max(0, quotaBytes - usedBytes - reservedBytes), checkedAt: new Date().toISOString() }
  try {
    const disk = await readDisk()
    const totalBytes = disk.blocks * disk.bsize, availableBytes = disk.bavail * disk.bsize
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes) || totalBytes < 0 || availableBytes < 0) throw new Error('Invalid filesystem statistics')
    return { ...base, totalBytes, availableBytes, receiveRemainingBytes: Math.min(base.quotaRemainingBytes, availableBytes) }
  } catch {
    return { ...base, totalBytes: null, availableBytes: null, receiveRemainingBytes: null, diskError: '暂时无法读取数据磁盘，请刷新重试；收集配额仍可查看。' }
  }
}
