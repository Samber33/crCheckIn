import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import fastifyStatic from '@fastify/static'
import fastifyRateLimit from '@fastify/rate-limit'
import dbPlugin from './db.js'
import sessionPlugin from './session.js'
import viewPlugin from './view.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function registerPlugins(app) {
  // 注册速率限制（全局默认：100 req/min）
  await app.register(fastifyRateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  })
  // 注册静态文件服务（public 和 uploads 目录）
  await app.register(fastifyStatic, {
    root: join(__dirname, '../../public'),
    prefix: '/public/',
    decorateReply: false,  // 避免重复装饰器错误
  })
  await app.register(fastifyStatic, {
    root: join(__dirname, '../../uploads'),
    prefix: '/uploads/',
  })
  await app.register(dbPlugin)
  await app.register(sessionPlugin)
  await app.register(viewPlugin)
}
