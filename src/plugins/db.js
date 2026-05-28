import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
})

// 监听 Prisma 查询警告和错误
prisma.$on('warn', (e) => {
  console.warn('[Prisma warn]', e.message)
})

prisma.$on('error', (e) => {
  console.error('[Prisma error]', e.message)
})

async function dbPlugin(app) {
  app.decorate('prisma', prisma)

  app.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
}

export default fp(dbPlugin)
