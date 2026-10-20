export type Page = 'overview' | 'collections' | 'files' | 'tools' | 'storage' | 'settings'
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
}

export const storageNames: Record<StorageId, string> = {
  local: '本地存储', onedrive: 'OneDrive', s3: 'S3 对象存储',
}
