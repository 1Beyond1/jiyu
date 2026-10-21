import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { Modal } from '../components/ui'
import { api } from '../lib/api'
import type { StorageId, StorageProfile } from '../types'
import type { StorageState } from './storage'

type Provider = StorageProfile['id']
export const storageChoices: { id: Provider; name: string; requirement: string; level: string; guide: string }[] = [
  { id: 'webdav', name: 'WebDAV / NAS', requirement: '准备服务地址、账号和应用密码即可', level: '接入较简单', guide: '' },
  { id: 's3', name: 'S3 对象存储', requirement: '需要已创建的存储桶和访问密钥', level: '已有桶可连接', guide: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html' },
  { id: 'baidu', name: '百度网盘', requirement: '需先申请已开通网盘权限的开放平台应用', level: '需要应用配置', guide: 'https://yun.baidu.com/open/platform' },
  { id: 'onedrive', name: 'OneDrive', requirement: '需先在 Microsoft 注册自己的网页应用', level: '需要应用配置', guide: 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app' },
  { id: 'gdrive', name: 'Google Drive', requirement: '需先配置 Google OAuth 网页应用并启用 Drive API', level: '需要应用配置', guide: 'https://developers.google.com/identity/protocols/oauth2/web-server' },
]
interface DeviceAuthorization { id: string; userCode: string; verificationUrl: string; expiresAt: string }

export function ConnectionWizard({ profile, callbackUrl, onClose, onChanged, onCreate }: { profile: StorageProfile; callbackUrl?: string; onClose: () => void; onChanged: () => void; onCreate: (id: StorageId) => void }) {
  const choice = storageChoices.find(c => c.id === profile.id)!
  const oauth = ['baidu', 'onedrive', 'gdrive'].includes(profile.id)
  const [editing, setEditing] = useState<StorageProfile>({ ...profile, root: profile.id === 'baidu' && !profile.revision ? '/apps/' : profile.root, region: profile.id === 's3' ? profile.region || 'us-east-1' : profile.region })
  const [secrets, setSecrets] = useState<Record<string, string>>({}), [saved, setSaved] = useState(profile)
  const [stage, setStage] = useState<'configure' | 'connect' | 'done'>(!profile.enabled && profile.authorized ? 'connect' : 'configure')
  const [authorization, setAuthorization] = useState<DeviceAuthorization | null>(null), [authorizationUrl, setAuthorizationUrl] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmDisable, setConfirmDisable] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const close = () => { if (!busy) onClose() }
  async function operation(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); onChanged() } catch (e) { setError((e as Error).message); onChanged() } finally { setBusy(false) }
  }
  async function test(p: StorageProfile) {
    const result = await api<StorageProfile>(`/api/storage/connections/${p.id}/test`, 'POST', { revision: p.revision })
    setSaved(result); setEditing(result); setStage('done')
  }
  async function authorize(p: StorageProfile) {
    if (p.id === 'baidu') { setAuthorization(await api<DeviceAuthorization>('/api/storage/baidu/authorize', 'POST', { revision: p.revision })); setAuthorizationUrl('') }
    else { const result = await api<{ authorizationUrl: string }>(`/api/storage/oauth/${p.id}/authorize`, 'POST', { revision: p.revision }); setAuthorizationUrl(result.authorizationUrl) }
  }
  async function save() {
    const result = await api<StorageProfile>(`/api/storage/connections/${editing.id}`, 'PUT', { ...editing, credentials: secrets })
    setSaved(result); setEditing(result); setSecrets({}); setShowSecrets(false); setStage('connect'); setAuthorization(null); setAuthorizationUrl('')
    if (!oauth || result.authorized) await test(result)
    else await authorize(result)
  }
  async function finishAuthorization() {
    let current = saved
    if (saved.id === 'baidu' && authorization) {
      if (Date.parse(authorization.expiresAt) < Date.now()) throw new Error('授权码已过期，请重新生成授权。')
      const result = await api<{ pending: boolean; profile?: StorageProfile }>(`/api/storage/baidu/authorize/${authorization.id}`, 'POST', {})
      if (result.pending) { setNotice('还未收到授权结果，请在百度页面完成确认后再检查。'); return }
      if (result.profile) current = result.profile
      setAuthorization(null)
    } else {
      const state = await api<StorageState>('/api/storage/connections')
      current = state.profiles.find(p => p.id === saved.id) || saved
    }
    setSaved(current); setEditing(current)
    if (!current.authorized) throw new Error('还未收到账号授权，请先在官方页面完成确认。')
    await test(current)
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('已复制') } catch { setNotice('无法自动复制，请选中上方文字手动复制。') }
  }
  const secretFields = editing.id === 'webdav' ? [['password', '应用密码', '使用 WebDAV 服务提供的应用密码，无需网盘网页登录密码']] : editing.id === 's3' ? [['accessKeyId', '访问密钥 ID（Access Key ID）', '从存储服务的访问密钥页面获取'], ['secretAccessKey', '访问密钥（Secret Access Key）', '与上面的 ID 配套使用'], ['sessionToken', '临时令牌（可选）', '仅使用临时凭证时填写']] : [['clientSecret', editing.id === 'baidu' ? '应用密钥（Secret Key）' : '应用密钥（Client Secret）', editing.id === 'onedrive' ? '复制客户端密码的“值”，不要填写密码 ID' : '来自你自己的应用控制台']]
  return <Modal title={`连接${choice.name}`} subtitle={choice.requirement} onClose={close}>
    <ol className="connection-steps" aria-label="连接进度">{[['configure', '填写连接'], ['connect', oauth ? '授权与检查' : '检查连接'], ['done', '用于收集']].map(([id, label], index) => <li key={id} className={stage === id ? 'current' : ''} aria-current={stage === id ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {stage === 'configure' && <form onSubmit={e => { e.preventDefault(); void operation(save) }}><fieldset disabled={busy}>
      {oauth && <details className="connection-guide" open={!profile.hasCredentials}><summary>第一次连接：去哪里获取应用信息？</summary><ol>{editing.id === 'baidu' ? <><li>进入百度网盘开放平台，创建并开通网盘权限应用。</li><li>复制应用的 API Key 和 Secret Key。</li><li>确认平台分配的应用目录名称，填写下方 /apps/ 下的目录。</li></> : <><li>在{editing.id === 'onedrive' ? 'Microsoft Entra' : 'Google Cloud'}控制台创建 OAuth 网页应用。{editing.id === 'gdrive' && '启用 Google Drive API，测试模式下添加自己的测试账号。'}</li><li>将下面的回调地址登记到应用中，再复制 Client ID 和 Secret。{editing.id === 'onedrive' && '若要连接个人网盘，应用账号类型需允许个人 Microsoft 账号。'}</li><li>保存后前往官方页面登录并确认授权，集屿不会接收你的网盘密码。</li></>}{choice.guide && <li><a href={choice.guide} target="_blank" rel="noreferrer">打开官方配置说明<ExternalLink size={12} /></a></li>}</ol>{callbackUrl && <div className="callback-address"><span>需要登记的回调地址</span><code>{callbackUrl}</code><button type="button" className="text-button" onClick={() => void copy(callbackUrl)}><Copy size={13} />复制地址</button></div>}<p>{editing.id === 'onedrive' ? '需要 Files.ReadWrite 和 offline_access 权限。' : editing.id === 'gdrive' ? '使用 drive.file，仅管理本应用创建或明确授权给本应用的文件。' : '应用资格及可写入目录以百度平台审核结果为准。'}</p></details>}
      {editing.id === 'webdav' && <p className="form-note">从你的网盘或 NAS 的 WebDAV 设置中复制地址，使用已开通的账号和应用密码。当前支持公网 HTTPS 地址，端口为 443。</p>}
      {['webdav', 's3'].includes(editing.id) && <label className="field">{editing.id === 's3' ? '存储服务地址（Endpoint）' : 'WebDAV 服务地址'}<input type="url" required maxLength={300} value={editing.endpoint} onChange={e => setEditing({ ...editing, endpoint: e.target.value })} placeholder={editing.id === 's3' ? 'https://s3.example.com' : 'https://dav.example.com/dav'} /><small>复制服务提供的完整 HTTPS 地址；不填写账号或密码到地址中。</small></label>}
      {editing.id === 's3' && <div className="form-row"><label className="field">存储桶名称<input required maxLength={63} value={editing.bucket || ''} onChange={e => setEditing({ ...editing, bucket: e.target.value })} placeholder="my-files" /><small>使用已创建的桶，集屿不会代建桶。</small></label><label className="field">所在区域（Region）<input required maxLength={64} value={editing.region || ''} onChange={e => setEditing({ ...editing, region: e.target.value })} placeholder="us-east-1" /></label></div>}
      {editing.id === 'webdav' && <label className="field">WebDAV 账号<input required maxLength={100} value={editing.username || ''} onChange={e => setEditing({ ...editing, username: e.target.value })} autoComplete="off" /></label>}
      {oauth && <label className="field">{editing.id === 'baidu' ? '应用 API Key' : '应用 ID（Client ID）'}<input required maxLength={200} value={editing.clientId || ''} onChange={e => setEditing({ ...editing, clientId: e.target.value })} autoComplete="off" /></label>}
      {secretFields.map(([key, label, hint]) => <label className="field" key={key}>{label}<input type={showSecrets ? 'text' : 'password'} maxLength={8192} required={!saved.hasCredentials && key !== 'sessionToken'} value={secrets[key] || ''} onChange={e => setSecrets({ ...secrets, [key]: e.target.value })} autoComplete="off" placeholder={saved.hasCredentials ? '已保存；留空保留原值' : hint} /><small>{hint}{saved.hasCredentials && '。更换账号、应用或服务地址时需重新填写。'}</small></label>)}
      <label className="secret-toggle"><input type="checkbox" checked={showSecrets} onChange={e => setShowSecrets(e.target.checked)} />显示本次填写的凭证</label>
      <label className="field">保存到哪个文件夹<input required maxLength={300} value={editing.root} onChange={e => setEditing({ ...editing, root: e.target.value })} placeholder={editing.id === 'baidu' ? '/apps/你的应用名/集屿' : '/集屿'} /><small>{editing.id === 'baidu' ? '例如 /apps/平台分配的应用名/集屿，不能写入应用目录以外。' : editing.id === 's3' ? '作为桶内的文件夹前缀，不需要事先创建。' : '默认 /集屿，连接后自动建立文件夹。'}</small></label>
      <footer className="modal-footer"><button type="button" className="button" onClick={close}>取消</button><button className="button primary">{busy ? '正在连接…' : oauth && !saved.authorized ? '保存并继续授权' : '连接并检查'}<ArrowRight size={15} /></button></footer>
      {saved.enabled && <button type="button" className="text-button" onClick={() => setConfirmDisable(true)}>停用此连接…</button>}
      {confirmDisable && <div className="form-note connection-disable"><p>停用后，使用此连接的任务仍会接收文件到本机，云端同步将暂停。已有文件和账号凭证保留。</p><button type="button" className="button" onClick={() => void operation(async () => { await api(`/api/storage/connections/${saved.id}/disable`, 'POST', {}); onClose() })}>确认停用</button><button type="button" className="text-button" onClick={() => setConfirmDisable(false)}>保留连接</button></div>}
    </fieldset></form>}
    {stage === 'connect' && <div className="connection-check"><h3>{oauth ? '完成账号授权，再检查连接' : '检查写入与读回'}</h3><p>{oauth ? '授权只在官方页面完成。授权后回到这里，点击下方按钮继续。' : '集屿会写入一个随机测试文件，读回校验后删除。你的其他文件不会改动。'}</p>
      {authorization && <div className="device-code"><span>在百度页面输入这个授权码</span><strong>{authorization.userCode}</strong><small>有效至 {new Date(authorization.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</small><button className="text-button" disabled={busy} onClick={() => void copy(authorization.userCode)}><Copy size={13} />复制授权码</button></div>}
      {(authorization?.verificationUrl || authorizationUrl) && <a className="button primary" target="_blank" rel="noreferrer" href={authorization?.verificationUrl || authorizationUrl}>前往{choice.name}授权<ExternalLink size={14} /></a>}
      <div className="button-row">{oauth ? <button className="button" disabled={busy} onClick={() => void operation(finishAuthorization)}><Check size={15} />{busy ? '正在检查…' : saved.authorized ? '检查账号连接' : '我已授权，继续检查'}</button> : <button className="button primary" disabled={busy} onClick={() => void operation(() => test(saved))}><RefreshCw size={15} />{busy ? '正在检查…' : '重新检查连接'}</button>}{oauth && <button className="text-button" disabled={busy} onClick={() => void operation(() => authorize(saved))}>重新生成授权</button>}</div><button className="text-button" disabled={busy} onClick={() => { setStage('configure'); setError(''); setNotice('') }}><ArrowLeft size={14} />返回修改连接信息</button>
    </div>}
    {stage === 'done' && <div className="connection-done"><CheckCircle2 size={40} strokeWidth={1.3} /><h3>{choice.name}已连接</h3><p>{oauth ? '账号授权检查通过。实际上传仍受网盘权限与容量限制，同步结果可以在存储空间查看。' : '测试文件已成功写入、读回校验并删除。'}文件保存到 <strong>{saved.root}</strong>。</p><div className="button-row"><button className="button primary" onClick={() => onCreate(saved.id)}>用它创建收集<ArrowRight size={15} /></button><button className="button" onClick={close}>完成</button></div><small>已有任务不会自动更换存储。需要更换时，在任务的「编辑收集规则」中选择。</small></div>}
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="field-hint" role="status">{notice}</p>}
    {busy && <p className="field-hint" role="status">正在连接，请稍候；完成前请保留此窗口。</p>}
  </Modal>
}
