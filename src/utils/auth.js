import { assertClassOwner } from '../services/class.js'

/**
 * 检查当前 session 是否已登录教师端。
 * @param {import('fastify').FastifyRequest} request
 * @returns {boolean}
 */
export function isTeacherLoggedIn(request) {
  return Boolean(request.session?.teacherId)
}

/**
 * Fastify preHandler 钩子：要求教师登录。
 * - 已登录：继续执行
 * - 未登录 + /api/ 路径：reply 401 JSON
 * - 未登录 + 页面路径：redirect /student
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function teacherRequired(request, reply) {
  if (isTeacherLoggedIn(request)) {
    return
  }
  if (request.url.startsWith('/api/')) {
    reply.code(401).send({ ok: false, message: '请先登录教师端。' })
  } else {
    reply.redirect('/student')
  }
}

/**
 * Fastify preHandler 钩子：要求管理员登录。
 * - isAdmin=true：继续执行
 * - 否则：reply 403 JSON
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function adminRequired(request, reply) {
  if (!request.session?.teacherId) {
    return reply.code(401).send({ ok: false, message: '未登录。' })
  }
  if (request.session?.isAdmin === true) {
    return
  }
  reply.code(403).send({ ok: false, message: '需要管理员权限。' })
}

/**
 * Fastify preHandler 钩子：要求对指定 classId 有操作权限（教师本人或 admin）。
 * classId 从 params、body、query 中依次取值（parseInt）。
 * 无权限则 reply 403 JSON。
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function classOwnerRequired(request, reply) {
  if (!isTeacherLoggedIn(request)) {
    if (request.url.startsWith('/api/')) {
      return reply.code(401).send({ ok: false, message: '请先登录教师端。' })
    }
    return reply.redirect('/student')
  }

  const rawClassId =
    request.params?.classId ??
    request.body?.classId ??
    request.query?.classId

  const classId = parseInt(rawClassId, 10)
  if (isNaN(classId)) {
    return reply.code(400).send({ ok: false, message: '班级ID无效' })
  }

  const teacherId = request.session?.teacherId
  const isAdmin = request.session?.isAdmin === true

  try {
    await assertClassOwner(classId, teacherId, isAdmin)
  } catch (err) {
    if (err.statusCode === 403) {
      reply.code(403).send({ ok: false, message: err.message || '无权访问该班级。' })
      return
    } else {
      throw err
    }
  }

  // 将验证后的 classId 挂载到 request，避免 handler 重复 parseInt
  request.classId = classId
}
