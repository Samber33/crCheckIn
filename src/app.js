import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'

export async function buildApp(opts = {}) {
  const app = Fastify({ logger: true, ...opts })

  await registerPlugins(app)
  // 接受 form 提交但不解析 body（仅用于退出等无需读取 body 的路由）
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}))
  await app.register(multipart)
  await registerRoutes(app)

  app.setErrorHandler((error, request, reply) => {
    app.log.error(error)
    const isDev = process.env.NODE_ENV !== 'production'
    reply.code(error.statusCode || 500).send({
      ok: false,
      message: isDev ? error.message : (error.statusCode && error.statusCode < 500 ? error.message : '服务器内部错误'),
    })
  })

  return app
}
