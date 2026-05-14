/**
 * SSE 事件管理 — 按教师维护 WebSocket-like 长连接，签到时推送实时更新。
 */

// Map<teacherId, Set<Socket>>
const teacherSockets = new Map()

// 班级 → 教师 ID 缓存（极少变动，仅在班级创建/删除/转交时失效）
const classTeacherCache = new Map()

/**
 * 为教师注册 SSE 连接。
 * @param {number} teacherId
 * @param {object} socket - The raw TCP socket
 */
export function registerSSE(teacherId, socket) {
  if (!teacherSockets.has(teacherId)) {
    teacherSockets.set(teacherId, new Set())
  }
  teacherSockets.get(teacherId).add(socket)

  socket.on('close', () => {
    const sockets = teacherSockets.get(teacherId)
    if (sockets) {
      sockets.delete(socket)
      if (sockets.size === 0) teacherSockets.delete(teacherId)
    }
  })
}

/**
 * 向指定教师推送事件。
 * @param {number} teacherId
 * @param {string} event
 */
export function broadcastToTeacher(teacherId, event) {
  const sockets = teacherSockets.get(teacherId)
  if (!sockets || sockets.size === 0) return
  const payload = `event: ${event}\n\n`
  for (const socket of [...sockets]) {
    const written = socket.write(payload, (err) => {
      if (err) sockets.delete(socket)
    })
    if (!written) {
      // Buffer full — socket is likely dead or slow
      sockets.delete(socket)
    }
  }
  if (sockets.size === 0) teacherSockets.delete(teacherId)
}

/**
 * 向班级相关教师广播。
 * @param {number} classId
 * @param {string} event
 */
export async function broadcastToClass(classId, event) {
  const teacherId = await getTeacherForClass(classId)
  if (teacherId) {
    broadcastToTeacher(teacherId, event)
  }
}

/**
 * 向所有教师广播（用于全局变更如预设标签）。
 * @param {string} event
 */
export function broadcastToAllTeachers(event) {
  const payload = `event: ${event}\n\n`
  for (const sockets of teacherSockets.values()) {
    for (const socket of [...sockets]) {
      const written = socket.write(payload, (err) => {
        if (err) sockets.delete(socket)
      })
      if (!written) {
        sockets.delete(socket)
      }
    }
  }
}

/**
 * 刷新/获取 班级→教师 缓存。
 * 优先读缓存，缺失时回退 DB 查询。
 * @param {number} classId
 * @returns {Promise<number|null>} teacherId 或 null
 */
export async function getTeacherForClass(classId) {
  if (classTeacherCache.has(classId)) {
    return classTeacherCache.get(classId)
  }
  // 回退 DB
  const { prisma } = await import('../plugins/db.js')
  const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } })
  if (cls) {
    classTeacherCache.set(classId, cls.teacherId)
    return cls.teacherId
  }
  return null
}

/**
 * 清除指定班级的缓存（班级删除/转交时调用）
 * @param {number|number[]} classIds
 */
export function invalidateClassTeacherCache(classIds) {
  const ids = Array.isArray(classIds) ? classIds : [classIds]
  for (const id of ids) classTeacherCache.delete(id)
}
