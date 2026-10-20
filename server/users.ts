import type { FastifyInstance } from 'fastify'
import type { Store } from './store.ts'
import type { SessionUser, UserRole } from '../src/types.ts'
import { hashPassword, HttpError, object, passwordInput, text } from './security.ts'
import { randomUUID } from 'node:crypto'

export interface UserRow { id: string; username: string; display_name: string; password: string; role: UserRole; disabled: number }
export const publicUser = (row: UserRow): SessionUser => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: !!row.disabled })
function roleInput(value: unknown): UserRole { if (!['admin', 'editor', 'viewer'].includes(String(value))) throw new HttpError(400, '成员角色无效'); return value as UserRole }

export function registerUsers(app: FastifyInstance, store: Store) {
  const list = () => (store.db.prepare('SELECT * FROM users ORDER BY rowid').all() as unknown as UserRow[]).map(publicUser)
  app.get('/api/users', async () => list())
  app.post('/api/users', async req => {
    const body = object(req.body), username = text(body.username, '登录名', 32)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(username)) throw new HttpError(400, '登录名需为 3–32 个英文字母、数字、点、横线或下划线')
    if (list().length >= 50) throw new HttpError(400, '当前工作台最多支持 50 位成员')
    const role = roleInput(body.role), displayName = text(body.displayName, '成员名称', 20), hash = await hashPassword(passwordInput(body.password))
    if (store.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username)) throw new HttpError(409, '这个登录名已被使用')
    store.transaction(() => { store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,0)').run(randomUUID(), username, displayName, hash, role); store.activity(`添加成员「${displayName}」`) })
    return list()
  })
  app.patch('/api/users/:id', async req => {
    const body = object(req.body), id = text(object(req.params).id, '成员编号', 40)
    const original = store.db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as UserRow | undefined
    if (!original) throw new HttpError(404, '成员不存在')
    const role = body.role === undefined ? original.role : roleInput(body.role), disabled = body.disabled === undefined ? original.disabled : body.disabled === true ? 1 : body.disabled === false ? 0 : -1
    if (disabled === -1) throw new HttpError(400, '账号状态无效')
    const displayName = body.displayName === undefined ? original.display_name : text(body.displayName, '成员名称', 20)
    const hash = body.password === undefined ? original.password : await hashPassword(passwordInput(body.password))
    store.transaction(() => {
      const current = store.db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as UserRow
      const admins = (store.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get() as { count: number }).count
      if (current.role === 'admin' && !current.disabled && (role !== 'admin' || disabled) && admins <= 1) throw new HttpError(409, '需要保留至少一位可登录的管理员')
      store.db.prepare('UPDATE users SET display_name=?,password=?,role=?,disabled=? WHERE id=?').run(displayName, hash, role, disabled, id)
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
      if (id === 'primary') store.set('password', hash)
      store.activity(`更新成员「${displayName}」的账号，撤销其旧会话`)
    })
    return list()
  })
}
