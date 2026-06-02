import { buildApp } from './src/app.js'
import { PORT, HOST } from './src/config.js'
import { prisma } from './src/plugins/db.js'
import { seed } from './prisma/seed.js'
import { deployDatabase } from './src/utils/database.js'
import { migrateTeacherClassesToPool } from './src/utils/migrate-classes-to-pool.js'
import { isExpiredCheckPaused } from './src/services/expiredCheck.js'

// 启动超时：30 秒
const STARTUP_TIMEOUT_MS = 30_000

let app = null
let expiredCheckInterval = null

const startupTimer = setTimeout(() => {
  console.error('[startup] 启动超时（30s），强制退出')
  process.exit(1)
}, STARTUP_TIMEOUT_MS)

try {
  await deployDatabase()
  app = await buildApp()
  await seed(prisma)
  await migrateTeacherClassesToPool()

  await app.listen({ port: PORT, host: HOST })

  // 启动成功，清除超时计时器
  clearTimeout(startupTimer)

  // 恢复已过期的签到倒计时（启动时）
  const { recoverExpiredCountdowns } = await import('./src/services/attendance.js')
  await recoverExpiredCountdowns()

  // 运行时每分钟检查一次过期倒计时
  expiredCheckInterval = setInterval(async () => {
    if (isExpiredCheckPaused()) return
    try {
      await recoverExpiredCountdowns()
    } catch (err) {
      console.error('[recover] failed:', err.message)
    }
  }, 60_000)

  console.log(`[server] crCheckIn running at http://${HOST}:${PORT}`)
} catch (err) {
  console.error('[startup] failed:', err)
  clearTimeout(startupTimer)
  process.exit(1)
}

// 优雅关闭：捕获 SIGTERM/SIGINT 信号
async function gracefulShutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing...`)
  if (expiredCheckInterval) clearInterval(expiredCheckInterval)
  try {
    if (app) await app.close()
    await prisma.$disconnect()
    console.log('[shutdown] completed')
    process.exit(0)
  } catch (err) {
    console.error('[shutdown] error:', err)
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// 未捕获异常兜底
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err)
  gracefulShutdown('uncaughtException').then(() => process.exit(1))
})

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason)
  gracefulShutdown('unhandledRejection').then(() => process.exit(1))
})
