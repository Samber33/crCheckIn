import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import fastifyStatic from '@fastify/static'
import fastifyRateLimit from '@fastify/rate-limit'
import dbPlugin from './db.js'
import sessionPlugin from './session.js'
import viewPlugin from './view.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function registerPlugins(app) {
  await app.register(fastifyRateLimit, {
    global: true,
    max: 10000,
    timeWindow: '1 minute',
    keyGenerator(req) {
      // 教师端页面按 session 区分，避免同 IP 多浏览器互相影响
      return req.session?.id || req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '127.0.0.1'
    },
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
