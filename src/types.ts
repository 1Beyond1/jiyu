export type Page = 'overview' | 'collections' | 'files' | 'tools' | 'storage' | 'settings' | 'trash'
export type CollectionStatus = 'active' | 'completed' | 'paused'
export type StorageId = 'local' | 'onedrive' | 's3'

export interface Collection {
  id: string
  title: string
  description: string
  category: 'design' | 'document' | 'photo'
  received: number
  target: number
  deadline: string
  storage: StorageId
  status: CollectionStatus
  formats: string
  maxFileSizeMB: number
  maxFilesPerSubmission: number
  maxTotalSizeMB?: number
  uploadToken?: string
  requestLimitMB?: number
}

export interface CollectedFile {
  id: string
  name: string
  size: number
  collectionId: string
  owner: string
  createdAt: string
  storage: StorageId
  status: 'ready' | 'pending'
  sha256?: string
  originalName?: string
  deletedAt?: string
}

export interface Activity {
  id: string
  text: string
  time: string
}

export interface Workspace {
  version: 1
  collections: Collection[]
  files: CollectedFile[]
  activities: Activity[]
  displayName: string
  trash?: CollectedFile[]
  storage?: { usedBytes: number; quotaBytes: number }
  lastRenameId?: string
}

export interface UploadReceipt { receiptId: string; filesCount: number; bytes: number; createdAt: string }

export interface AISettings {
  revision: string
  enabled: boolean
  protocol: 'responses' | 'chat'
  baseUrl: string
  model: string
  maxDailyCalls: number
  hasKey: boolean
  keyReady: boolean
  usedToday: number
}
export interface RenameChange { id: string; oldName: string; name: string }
export interface AIReply { runId: string; reply: string; changes: RenameChange[]; tokens: number }
export interface AIRun { id: string; model: string; fileCount: number; status: string; tokens: number; createdAt: string }

export const storageNames: Record<StorageId, string> = {
  local: '本地存储', onedrive: 'OneDrive', s3: 'S3 对象存储',
}
