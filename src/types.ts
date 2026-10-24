export type Page = 'overview' | 'collections' | 'files' | 'tools' | 'storage' | 'settings' | 'trash'
export type CollectionStatus = 'active' | 'completed' | 'paused'
export const cloudStorageIds = ['webdav', 's3', 'baidu', 'onedrive', 'gdrive'] as const
export type StorageId = 'local' | typeof cloudStorageIds[number]
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
  fields?: CollectionField[]
  identityField?: string
  expectedSubmitters?: string[]
  naming?: { parts: string[]; separator: '_' | '-' }
  submissionMode?: 'append' | 'single'
  allowReplacement?: boolean
  materials?: MaterialRequirement[]
  materialRevision?: string
}

export interface MaterialRequirement { id: string; name: string; required: boolean; description: string }
export type MaterialReviewState = 'unclassified' | 'pending' | 'accepted' | 'needs_changes' | 'stale'
export interface MaterialReview { decision: 'accepted' | 'needs_changes'; note: string; rulesRevision: string; fileVersion: string; operationId: string; reviewerId: string; reviewerName: string; reviewedAt: string }
export interface MaterialAction { id: string; signature: string; resultVersion: string }
export interface MaterialOperation { collectionId: string; rulesRevision: string; requestId: string; files: { id: string; expectedVersion: string; materialId?: string }[]; decision?: 'accepted' | 'needs_changes'; note?: string }
export interface MaterialSlot { requirement: MaterialRequirement; files: CollectedFile[]; state: 'missing' | 'duplicate' | MaterialReviewState; duplicate: boolean }
export interface MaterialParticipant { identity: string; owner: string; expected: boolean; files: CollectedFile[]; slots: MaterialSlot[]; unclassified: CollectedFile[]; receivedComplete: boolean; reviewComplete: boolean; status: 'missing' | 'needs_changes' | 'unclassified' | 'pending' | 'accepted'; duplicateCount: number }
export interface CollectionField { id: string; label: string; required: boolean }
export interface CollectionTemplate { id: string; name: string; rules: Partial<Collection>; archived: boolean }
export interface SubmissionMetadata { fields?: Record<string, string>; replace?: { receiptId: string; key: string }; materialIds?: string[] }
export interface Participant { identity: string; owner: string; expected: boolean; fileIds: string[]; bytes: number; submissions: number; latestAt: string; duplicates: number }
export interface ReceiptDetail { receipt: UploadReceipt; owner: string; fields: Record<string, string>; files: (Pick<CollectedFile, 'id' | 'name' | 'size' | 'materialId'> & { materialState?: MaterialReviewState; materialNote?: string })[]; superseded: boolean }
export interface DiagnosticItem { id: string; label: string; state: 'ok' | 'attention'; detail: string; action?: string }
export interface Diagnostics { checkedAt: string; items: DiagnosticItem[] }

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
  submissionId?: string
  submissionFields?: Record<string, string>
  fieldLabels?: Record<string, string>
  participant?: string
  materialId?: string
  materialVersion?: number
  materialReview?: MaterialReview
  materialAction?: MaterialAction
}

export interface Activity {
  id: string
  text: string
  time: string
}

export interface Workspace {
  version: 1
  requestLimitMB?: number
  collections: Collection[]
  files: CollectedFile[]
  activities: Activity[]
  displayName: string
  trash?: CollectedFile[]
  storage?: { usedBytes: number; quotaBytes: number }
  lastRenameId?: string
}

export interface UploadReceipt { receiptId: string; filesCount: number; bytes: number; createdAt: string; editKey?: string }
export type UploadFileState = 'queued' | 'checking' | 'uploading' | 'retrying' | 'uploaded' | 'saving' | 'received' | 'paused' | 'failed'
export interface UploadFileProgress { state: UploadFileState; sentBytes: number; totalBytes: number; message?: string }
export interface UploadFeedback { phase: 'preparing' | 'uploading' | 'saving' | 'received' | 'paused' | 'failed'; files: UploadFileProgress[] }
export interface BackupSettings { enabled: boolean; intervalHours: number; keep: number }
export interface BackupInfo { id: string; createdAt: string; files: number; bytes: number }
export interface BackupRun { id: string; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; error?: string }
export interface BackupStatus { settings: BackupSettings; lastRun: BackupRun | null; backups: BackupInfo[]; directory: string }
export interface DocumentInfo { file_id: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported'; kind?: string; chars: number; truncated: number; updated_at?: string; error?: string }
export interface FileContent { preview: 'image' | 'pdf' | 'text' | 'none'; mime?: string; text?: string; document?: DocumentInfo }
export interface StorageProfile { id: Exclude<StorageId, 'local'>; endpoint: string; root: string; region?: string; bucket?: string; username?: string; clientId?: string; via?: 'webdav'; hasCredentials: boolean; authorized?: boolean; enabled: boolean; verifiedAt?: string; revision: string }
export interface StorageSpace { usedBytes: number; quotaBytes: number; reservedBytes: number; quotaRemainingBytes: number; totalBytes: number | null; availableBytes: number | null; receiveRemainingBytes: number | null; checkedAt: string; diskError?: string }
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
  local: '本地存储', onedrive: 'OneDrive', s3: 'S3 对象存储', webdav: 'WebDAV', baidu: '百度网盘', gdrive: 'Google Drive',
}
