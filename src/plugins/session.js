import fp from 'fastify-plugin'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import { SECRET_KEY } from '../config.js'

async function sessionPlugin(app) {
  await app.register(cookie)
  await app.register(session, {
    secret: SECRET_KEY,
    // secure: 生产环境通过 HTTPS 反向代理时设为 true
    cookie: {
      secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
      sameSite: 'lax',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 小时后过期
    },
    saveUninitialized: false,
    rolling: true, // 每次请求刷新 session 过期时间
  })

  // CSRF 防护：对非 GET 请求校验 Origin/Referer 头
  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
    // SSE 使用 GET，此处无需排除
    // 跳过公开 API（学生签到、信息提交、照片上传等通过 rate-limit 保护）
    if (request.url.startsWith('/api/signin') ||
        request.url.startsWith('/api/info-') ||
        request.url.startsWith('/api/students/match') ||
        request.url.startsWith('/api/preset-tags') ||
        request.url.startsWith('/api/teacher-login')) {
      return
    }
    const origin = request.headers['origin']
    const referer = request.headers['referer']
    const host = request.headers['host']
    if (!host) {
      return reply.code(403).send({ ok: false, message: 'CSRF 防护：缺少 Host 头' })
    }
    if (origin) {
      try {
        const originHost = new URL(origin).host
        if (originHost !== host) {
          return reply.code(403).send({ ok: false, message: 'CSRF 防护：请求来源不匹配' })
        }
      } catch {
        return reply.code(403).send({ ok: false, message: 'CSRF 防护：无效的 Origin 头' })
      }
    } else if (referer) {
      try {
        const refererHost = new URL(referer).host
        if (refererHost !== host) {
          return reply.code(403).send({ ok: false, message: 'CSRF 防护：请求来源不匹配' })
        }
      } catch {
        return reply.code(403).send({ ok: false, message: 'CSRF 防护：无效的 Referer 头' })
      }
    } else {
      // 无 Origin 也无 Referer → 拒绝（非浏览器请求应有 Origin）
      return reply.code(403).send({ ok: false, message: 'CSRF 防护：缺少 Origin 或 Referer 头' })
    }
  })
}

export default fp(sessionPlugin)
