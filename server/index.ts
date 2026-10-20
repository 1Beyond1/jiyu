import { createApp } from './app.ts'
import { configFromEnv } from './config.ts'

const config = configFromEnv()
const { app, store } = await createApp(config)
await app.listen({ host: config.host, port: config.port })
console.log(`集屿已启动：${config.origin}`)
if (!store.get('password')) console.log('首次使用请读取数据目录中的 setup-token，并在页面初始化管理员。')
const stop = async () => { await app.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
