import bcrypt from 'bcrypt'
import { prisma } from '../plugins/db.js'

/**
 * 通过用户名和口令验证教师/管理员登录。
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok: boolean, teacher?: object, message?: string}>}
 */
export async function verifyTeacherByPassword(username, password) {
  if (!username || !password) return { ok: false }

  const teacher = await prisma.teacher.findUnique({ where: { username } })
  if (!teacher) return { ok: false, message: '用户名不存在' }

  const match = await bcrypt.compare(password, teacher.passwordHash)
  if (!match) return { ok: false, message: '密码不正确' }

  return { ok: true, teacher }
}

/**
 * 创建新教师账号（仅 admin 可调用）。
 * @param {string} username
 * @param {string} password
 * @param {boolean} isAdmin
 * @returns {Promise<object>} 创建的 Teacher 记录
 */
export async function createTeacher(username, password, isAdmin = false) {
  const existing = await prisma.teacher.findUnique({ where: { username } })
  if (existing) {
    const err = new Error('用户名已存在')
    err.code = 'USERNAME_TAKEN'
    throw err
  }

  // Check password uniqueness across all teachers
  const allTeachers = await prisma.teacher.findMany({ select: { passwordHash: true } })
  for (const teacher of allTeachers) {
    const match = await bcrypt.compare(password, teacher.passwordHash)
    if (match) {
      const err = new Error('该密码已被其他教师使用')
      err.code = 'PASSWORD_DUPLICATE'
      throw err
    }
  }

  const passwordHash = await bcrypt.hash(password, 10)
  return prisma.teacher.create({
    data: { username, passwordHash, isAdmin },
  })
}

/**
 * 修改教师密码。
 * @param {number} teacherId
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function changePassword(teacherId, oldPassword, newPassword) {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } })
  if (!teacher) return { ok: false, message: '教师不存在' }

  const match = await bcrypt.compare(oldPassword, teacher.passwordHash)
  if (!match) return { ok: false, message: '旧密码不正确' }

  // Check password uniqueness
  const allTeachers = await prisma.teacher.findMany({
    where: { id: { not: teacherId } },
    select: { passwordHash: true },
  })
  for (const other of allTeachers) {
    if (await bcrypt.compare(newPassword, other.passwordHash)) {
      return { ok: false, message: '该密码已被其他教师使用' }
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  await prisma.teacher.update({
    where: { id: teacherId },
    data: { passwordHash },
  })

  return { ok: true, message: '密码修改成功' }
}

/**
 * 管理员重置教师密码（无需旧密码）。
 * @param {number} targetTeacherId
 * @param {string} newPassword
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function resetTeacherPasswordByAdmin(targetTeacherId, newPassword) {
  const teacher = await prisma.teacher.findUnique({ where: { id: targetTeacherId } })
  if (!teacher) return { ok: false, message: '教师不存在' }

  // Check password uniqueness
  const allTeachers = await prisma.teacher.findMany({
    where: { id: { not: targetTeacherId } },
    select: { passwordHash: true },
  })
  for (const other of allTeachers) {
    if (await bcrypt.compare(newPassword, other.passwordHash)) {
      return { ok: false, message: '该密码已被其他教师使用' }
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  await prisma.teacher.update({
    where: { id: targetTeacherId },
    data: { passwordHash },
  })

  return { ok: true, message: '教师密码已重置' }
}
