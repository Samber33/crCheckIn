/**
 * SSE 事件管理 — 按教师维护 WebSocket-like 长连接，签到时推送实时更新。
 */

// Map<teacherId, Set<Socket>>
const teacherSockets = new Map()

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
    try {
      socket.write(payload)
    } catch {
      sockets.delete(socket)
    }
  }
}

/**
 * 向班级相关教师广播。
 * @param {number} classId
 * @param {string} event
 */
export async function broadcastToClass(classId, event) {
  const { prisma } = await import('../plugins/db.js')
  const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } })
  if (cls) {
    broadcastToTeacher(cls.teacherId, event)
  }
}
