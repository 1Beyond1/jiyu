export type Page = 'overview' | 'collections' | 'files' | 'tools' | 'storage' | 'settings' | 'trash'
export type CollectionStatus = 'active' | 'completed' | 'paused'
export type StorageId = 'local' | 'onedrive' | 's3' | 'webdav' | 'baidu' | 'quark' | 'gdrive'
export type UserRole = 'admin' | 'editor' | 'viewer'
export interface SessionUser { id: string; username: string; displayName: string; role: UserRole; disabled?: boolean }

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
  tags?: string[]
  remoteStatus?: 'queued' | 'transferring' | 'ready' | 'failed'
  remotePath?: string
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
export interface BackupSettings { enabled: boolean; intervalHours: number; keep: number }
export interface BackupInfo { id: string; createdAt: string; files: number; bytes: number }
export interface BackupRun { id: string; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; error?: string }
export interface BackupStatus { settings: BackupSettings; lastRun: BackupRun | null; backups: BackupInfo[]; directory: string }
export interface DocumentInfo { file_id: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported'; kind?: string; chars: number; truncated: number; updated_at?: string; error?: string }
export interface FileContent { preview: 'image' | 'pdf' | 'text' | 'none'; mime?: string; text?: string; document?: DocumentInfo }
export interface StorageProfile { id: Exclude<StorageId, 'local'>; endpoint: string; root: string; region?: string; bucket?: string; username?: string; clientId?: string; via?: 'webdav'; hasCredentials: boolean; enabled: boolean; verifiedAt?: string; revision: string }
export interface TransferInfo { file_id: string; provider: string; state: string; attempts: number; error?: string; updated_at: string; remote_path?: string }

export type ArchiveLayout = 'flat' | 'collection' | 'owner' | 'collection-owner'
export type ArchiveStatus = 'ready' | 'streaming' | 'completed' | 'failed' | 'cancelled'
export interface ArchiveEntry { id: string; name: string; path: string; size: number }
export interface ArchivePlan { id: string; fileName: string; layout: ArchiveLayout; totalBytes: number; entries: ArchiveEntry[]; expiresAt: string; status: ArchiveStatus; error?: string }

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
export interface TagChange { id: string; name: string; oldTags: string[]; tags: string[] }
export interface AIReply { runId: string; reply: string; changes: RenameChange[]; tags?: TagChange[]; tokens: number }
export interface AIRun { id: string; model: string; fileCount: number; status: string; tokens: number; createdAt: string }

export const storageNames: Record<StorageId, string> = {
  local: '本地存储', onedrive: 'OneDrive', s3: 'S3 对象存储', webdav: 'WebDAV', baidu: '百度网盘', quark: '夸克网盘', gdrive: 'Google Drive',
}
