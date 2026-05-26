/**
 * 测试数据工厂：使用项目共享的 prisma 单例
 * 所有测试通过 beforeEach 清理数据，使用唯一前缀避免冲突
 */
import { prisma } from './plugins/db.js'

export { prisma }

/** 生成唯一标识，用于测试数据命名 */
export const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

/** 清理所有测试数据（按外键依赖顺序） */
export async function cleanDatabase() {
  await prisma.infoResponse.deleteMany().catch(() => {})
  await prisma.infoSubmission.deleteMany().catch(() => {})
  await prisma.infoField.deleteMany().catch(() => {})
  await prisma.archivedRecord.deleteMany().catch(() => {})
  await prisma.signInSession.deleteMany().catch(() => {})
  await prisma.signInRecord.deleteMany().catch(() => {})
  await prisma.signInConfig.deleteMany().catch(() => {})
  await prisma.studentTag.deleteMany().catch(() => {})
  await prisma.student.deleteMany().catch(() => {})
  await prisma.class.deleteMany().catch(() => {})
  await prisma.teacher.deleteMany().catch(() => {})
  await prisma.presetTag.deleteMany().catch(() => {})
  await prisma.auditLog.deleteMany().catch(() => {})
}

export const factories = {
  async createTeacher(data = {}) {
    return prisma.teacher.create({
      data: {
        username: data.username || `teacher_${uid()}`,
        passwordHash: data.passwordHash || 'hashed_password',
        isAdmin: data.isAdmin || false,
      },
    })
  },

  async createClass(data = {}) {
    return prisma.class.create({
      data: {
        name: data.name || `class_${uid()}`,
        teacherId: data.teacherId ?? null,
        isArchived: data.isArchived || false,
      },
      include: { signInConfig: true },
    })
  },

  async createStudent(data = {}) {
    return prisma.student.create({
      data: {
        name: data.name || `student_${uid()}`,
        homeClass: data.homeClass || '',
        remark: data.remark || '',
        photoUrl: data.photoUrl || '',
        classId: data.classId,
      },
    })
  },

  async createSignInConfig(data = {}) {
    return prisma.signInConfig.create({
      data: {
        classId: data.classId,
        activeStartedAt: data.activeStartedAt || null,
        countdownDurationMin: data.countdownDurationMin ?? 30,
      },
    })
  },

  async createSignInRecord(data = {}) {
    return prisma.signInRecord.create({
      data: {
        classId: data.classId,
        studentName: data.studentName,
        studentId: data.studentId || null,
        computerName: data.computerName || '',
        studentIp: data.studentIp || '',
      },
    })
  },

  async createSignInSession(data = {}) {
    return prisma.signInSession.create({
      data: {
        classId: data.classId,
        label: data.label || `session_${uid()}`,
      },
    })
  },

  async createArchivedRecord(data = {}) {
    return prisma.archivedRecord.create({
      data: {
        sessionId: data.sessionId,
        studentName: data.studentName,
        homeClass: data.homeClass || '',
        computerName: data.computerName || '',
        studentIp: data.studentIp || '',
        signedAt: data.signedAt || new Date(),
      },
    })
  },

  async createPresetTag(data = {}) {
    return prisma.presetTag.create({
      data: {
        tag: data.tag || `preset_${uid()}`,
        color: data.color || '#cc785c',
        sortOrder: data.sortOrder ?? 0,
      },
    })
  },

  async createStudentTag(data = {}) {
    return prisma.studentTag.create({
      data: {
        classId: data.classId,
        studentId: data.studentId,
        tag: data.tag,
        color: data.color || '#cc785c',
      },
    })
  },

  async createAuditLog(data = {}) {
    return prisma.auditLog.create({
      data: {
        adminId: data.adminId,
        action: data.action,
        target: data.target,
        detail: data.detail || '',
        ip: data.ip || '',
      },
    })
  },
}
