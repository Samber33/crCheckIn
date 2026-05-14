import { buildApp } from './src/app.js'
import { PORT, HOST } from './src/config.js'
import { prisma } from './src/plugins/db.js'
import { seed } from './prisma/seed.js'
import { deployDatabase } from './src/utils/database.js'

try {
  await deployDatabase()
  const app = await buildApp()
  await seed(prisma)

  await app.listen({ port: PORT, host: HOST })

  // 恢复已过期的签到倒计时（启动时）
  const { recoverExpiredCountdowns } = await import('./src/services/attendance.js')
  await recoverExpiredCountdowns()

  // 运行时每分钟检查一次过期倒计时
  setInterval(async () => {
    try {
      await recoverExpiredCountdowns()
    } catch (err) {
      console.error('[recover] failed:', err.message)
    }
  }, 60_000)
} catch (err) {
  console.error(err)
  process.exit(1)
}
