import bcrypt from 'bcrypt'
import { prisma } from '../plugins/db.js'

/**
 * 校验密码强度：至少 6 位，必须包含字母和数字
 */
function assertPasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    const err = new Error('密码不能为空')
    err.code = 'PASSWORD_TOO_WEAK'
    throw err
  }
  if (password.length < 6) {
    const err = new Error('密码长度不能少于 6 位')
    err.code = 'PASSWORD_TOO_WEAK'
    throw err
  }
  if (password.length > 128) {
    const err = new Error('密码长度不能超过 128 位')
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
  if (!password || typeof password !== 'string') return { ok: false, message: '请输入密码' }

  // 使用 bcrypt 的时间恒定比较防止时序攻击
  // 限制最大长度防止 bcrypt DoS（bcrypt 有 72 字节上限）
  if (password.length > 72) return { ok: false, message: '密码不正确' }

  const teachers = await prisma.teacher.findMany({
    select: { id: true, username: true, passwordHash: true, isAdmin: true },
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

  // 校验用户名
  if (!username || typeof username !== 'string' || !username.trim()) {
    const err = new Error('用户名不能为空')
    err.code = 'USERNAME_EMPTY'
    throw err
  }
  const trimmedUsername = username.trim()
  if (trimmedUsername.length > 50) {
    const err = new Error('用户名长度不能超过 50 个字符')
    err.code = 'USERNAME_TOO_LONG'
    throw err
  }

  const existing = await prisma.teacher.findUnique({ where: { username: trimmedUsername } })
  if (existing) {
    const err = new Error('用户名已存在')
    err.code = 'USERNAME_TAKEN'
    throw err
  }

  // 限制密码最大长度防止 bcrypt DoS
  if (password.length > 72) {
    const err = new Error('密码长度不能超过 72 位')
    err.code = 'PASSWORD_TOO_WEAK'
    throw err
  }

  // Check password uniqueness across all teachers
  const allTeachers = await prisma.teacher.findMany({ select: { passwordHash: true } })
  // 使用 Promise.all 并行检查，而非串行 for 循环
  const duplicateChecks = await Promise.all(
    allTeachers.map(t => bcrypt.compare(password, t.passwordHash))
  )
  if (duplicateChecks.some(Boolean)) {
    const err = new Error('该密码已被其他教师使用')
    err.code = 'PASSWORD_DUPLICATE'
    throw err
  }

  const passwordHash = await bcrypt.hash(password, 10)
  return prisma.teacher.create({
    data: { username: trimmedUsername, passwordHash, isAdmin },
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

  if (newPassword.length > 72) {
    return { ok: false, message: '密码长度不能超过 72 位' }
  }

  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } })
  if (!teacher) return { ok: false, message: '教师不存在' }

  const match = await bcrypt.compare(oldPassword, teacher.passwordHash)
  if (!match) return { ok: false, message: '旧密码不正确' }

  // Check password uniqueness — parallel for performance
  const allTeachers = await prisma.teacher.findMany({
    where: { id: { not: teacherId } },
    select: { passwordHash: true },
  })
  const duplicateChecks = await Promise.all(
    allTeachers.map(t => bcrypt.compare(newPassword, t.passwordHash))
  )
  if (duplicateChecks.some(Boolean)) {
    return { ok: false, message: '该密码已被其他教师使用' }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  await prisma.teacher.update({
    where: { id: teacherId },
    data: { passwordHash },
  })

  return { ok: true, message: '密码修改成功' }
}

/**
 * 记录教师登录日志
 * @param {number} teacherId
 * @param {string} ip
 * @param {boolean} success
 */
export async function recordLogin(teacherId, ip, success) {
  try {
    await prisma.loginLog.create({
      data: { teacherId, ip, success },
    })
  } catch {
    // 日志写入失败不应影响主流程
  }
}

/**
 * 管理员重置教师密码（无需旧密码）。
 * @param {number} targetTeacherId
 * @param {string} newPassword
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function resetTeacherPasswordByAdmin(targetTeacherId, newPassword) {
  assertPasswordStrength(newPassword)

  if (newPassword.length > 72) {
    return { ok: false, message: '密码长度不能超过 72 位' }
  }

  const teacher = await prisma.teacher.findUnique({ where: { id: targetTeacherId } })
  if (!teacher) return { ok: false, message: '教师不存在' }

  // Check password uniqueness — parallel for performance
  const allTeachers = await prisma.teacher.findMany({
    where: { id: { not: targetTeacherId } },
    select: { passwordHash: true },
  })
  const duplicateChecks = await Promise.all(
    allTeachers.map(t => bcrypt.compare(newPassword, t.passwordHash))
  )
  if (duplicateChecks.some(Boolean)) {
    return { ok: false, message: '该密码已被其他教师使用' }
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  await prisma.teacher.update({
    where: { id: targetTeacherId },
    data: { passwordHash },
  })

  return { ok: true, message: '教师密码已重置' }
}
