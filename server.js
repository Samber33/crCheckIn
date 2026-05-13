import { buildApp } from './src/app.js'
import { PORT, HOST } from './src/config.js'
import { prisma } from './src/plugins/db.js'
import { seed } from './prisma/seed.js'
import { deployDatabase } from './src/utils/database.js'

try {
  await deployDatabase()
  const app = await buildApp()
  await seed(prisma)

  // 恢复已过期的签到倒计时
  const { recoverExpiredCountdowns } = await import('./src/services/attendance.js')
  await recoverExpiredCountdowns()

  await app.listen({ port: PORT, host: HOST })
} catch (err) {
  console.error(err)
  process.exit(1)
}
