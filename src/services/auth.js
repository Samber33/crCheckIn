import bcrypt from 'bcrypt'
import { prisma } from '../plugins/db.js'

/**
 * 校验密码强度：至少 6 位
 */
function assertPasswordStrength(password) {
  if (password.length < 6) {
    const err = new Error('密码长度不能少于 6 位')
    err.code = 'PASSWORD_TOO_WEAK'
    throw err
  }
}

/**
 * 通过口令验证教师/管理员登录凭据。
 * 每个教师密码唯一，按密码匹配教师身份。
 * @param {string} password
 * @returns {Promise<{ok: boolean, teacher?: object, message?: string}>}
 */
export async function verifyTeacherByPassword(password) {
  if (!password) return { ok: false }

  const teachers = await prisma.teacher.findMany({
    orderBy: [
      { isAdmin: 'desc' },
      { id: 'asc' },
    ],
  })

  // 并行执行所有 bcrypt 比较，既保持恒定时间又提升速度
  const results = await Promise.all(
    teachers.map(async (teacher) => {
      const match = await bcrypt.compare(password, teacher.passwordHash)
      return { teacher, match }
    })
  )

  const found = results.find(r => r.match)?.teacher
  if (found) return { ok: true, teacher: found }
  return { ok: false, message: '密码不正确' }
}

/**
 * 创建新教师账号（仅 admin 可调用）。
 * @param {string} username
 * @param {string} password
 * @param {boolean} isAdmin
 * @returns {Promise<object>} 创建的 Teacher 记录
 */
export async function createTeacher(username, password, isAdmin = false) {
  assertPasswordStrength(password)

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
  assertPasswordStrength(newPassword)

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
  assertPasswordStrength(newPassword)

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
