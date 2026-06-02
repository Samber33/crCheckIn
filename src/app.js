import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: true,
    bodyLimit: 100 * 1024 * 1024, // 100MB default
    ...opts,
    ignoreTrailingSlash: true,
  })

  await registerPlugins(app)
  // 接受 form 提交但不解析 body（仅用于退出等无需读取 body 的路由）
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}))
  await app.register(multipart)
  await registerRoutes(app)

  // 全局错误处理器
  app.setErrorHandler((error, request, reply) => {
    // 记录完整错误栈
    app.log.error(error)

    // 区分客户端错误与服务器错误
    const statusCode = error.statusCode || 500
    const isClientError = statusCode >= 400 && statusCode < 500
    const isDev = process.env.NODE_ENV !== 'production'

    // Prisma 特定错误码映射
    if (error.code === 'P2025') {
      return reply.code(404).send({ ok: false, message: '记录不存在' })
    }
    if (error.code === 'P2002') {
      return reply.code(409).send({ ok: false, message: '数据冲突，记录已存在' })
    }

    reply.code(statusCode).send({
      ok: false,
      message: isClientError || isDev ? error.message : '服务器内部错误',
    })
  })

  // 404 处理
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ ok: false, message: '接口不存在' })
    } else {
      reply.code(404).send({ ok: false, message: '页面不存在' })
    }
  })

  return app
}
