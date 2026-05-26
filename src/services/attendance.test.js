import { describe, before, after, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../plugins/db.js'

// 使用与生产环境相同的数据库（测试数据会在 beforeEach 中清理）
// 使用唯一前缀避免测试间数据干扰
const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

describe('attendance service', () => {
  before(async () => {
    // 确保数据库连接正常
    await prisma.$connect()
  })

  after(async () => {
    // 注意：不关闭连接，因为其他测试可能还需要
  })

  beforeEach(async () => {
    // 清空所有表（按外键依赖顺序：先删子表，后删父表）
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
  })

  describe('signIn', async () => {
    const { signIn } = await import('./attendance.js')

    it('returns error for empty name', async () => {
      const result = await signIn(1, '', 'PC01', '192.168.1.1')
      assert.equal(result.ok, false)
      assert.equal(result.message, '请输入姓名。')
    })

    it('returns error when student not in class roster', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })

      const result = await signIn(cls.id, '非名单学生', 'PC01', '192.168.1.1')
      assert.equal(result.ok, false)
      assert.equal(result.message, '该姓名不在名单中，请联系老师。')
    })

    it('returns error when sign-in not started', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })

      const result = await signIn(cls.id, '张三', 'PC01', '192.168.1.1')
      assert.equal(result.ok, false)
      assert.equal(result.message, '签到未开始，请等待老师开启签到。')
    })

    it('returns error when sign-in window expired', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })
      // 设置一个已经过期的签到窗口
      const pastDate = new Date(Date.now() - 10 * 60 * 1000) // 10 分钟前
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: pastDate,
          countdownDurationMin: 5,
        },
      })

      const result = await signIn(cls.id, '张三', 'PC01', '192.168.1.1')
      assert.equal(result.ok, false)
      assert.equal(result.message, '签到时间已结束，请等待下一轮签到。')
    })

    it('returns error for duplicate sign-in by name', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      const student = await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })
      // 开启签到
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: new Date(),
          countdownDurationMin: 30,
        },
      })
      // 第一次签到
      await prisma.signInRecord.create({
        data: {
          classId: cls.id,
          studentName: '张三',
          studentId: student.id,
          computerName: 'PC01',
          studentIp: '192.168.1.1',
        },
      })

      const result = await signIn(cls.id, '张三', 'PC02', '192.168.1.2')
      assert.equal(result.ok, false)
      assert.equal(result.message, '你已签到，无需重复提交。')
    })

    it('returns error for duplicate sign-in by IP', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })
      await prisma.student.create({
        data: { name: '李四', classId: cls.id },
      })
      // 开启签到
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: new Date(),
          countdownDurationMin: 30,
        },
      })
      // 张三已签到
      await prisma.signInRecord.create({
        data: {
          classId: cls.id,
          studentName: '张三',
          computerName: 'PC01',
          studentIp: '192.168.1.100',
        },
      })

      // 李四用同一 IP 尝试签到
      const result = await signIn(cls.id, '李四', 'PC02', '192.168.1.100')
      assert.equal(result.ok, false)
      assert.equal(result.message, '该设备已签到，每人只能签到一次。')
    })

    it('successfully signs in a student', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })
      // 开启签到
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: new Date(),
          countdownDurationMin: 30,
        },
      })

      const result = await signIn(cls.id, '张三', 'PC01', '192.168.1.1')
      assert.equal(result.ok, true)
      assert.equal(result.message, '张三 签到成功！')

      // 验证签到记录已创建
      const record = await prisma.signInRecord.findFirst({
        where: { classId: cls.id, studentName: '张三' },
      })
      assert.ok(record)
      assert.equal(record.computerName, 'PC01')
      assert.equal(record.studentIp, '192.168.1.1')
    })
  })

  describe('getClassStatus', async () => {
    const { getClassStatus } = await import('./attendance.js')

    it('returns correct counts for mixed sign-in status', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({ data: { name: '张三', classId: cls.id } })
      await prisma.student.create({ data: { name: '李四', classId: cls.id } })
      await prisma.student.create({ data: { name: '王五', classId: cls.id } })

      // 李四已签到
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '李四', computerName: 'PC02' },
      })

      const status = await getClassStatus(cls.id)
      assert.equal(status.signedCount, 1)
      assert.equal(status.totalCount, 3)
      assert.equal(status.absentCount, 2)
    })

    it('roster has unsigned students before signed students', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({ data: { name: '张三', classId: cls.id } })
      await prisma.student.create({ data: { name: '李四', classId: cls.id } })

      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })

      const status = await getClassStatus(cls.id)
      const roster = status.roster

      // 未签到的李四应该在前
      assert.equal(roster[0].studentName, '李四')
      assert.equal(roster[0].status, '未签到')
      assert.equal(roster[1].studentName, '张三')
      assert.equal(roster[1].status, '已签到')
    })

    it('returns null countdown when sign-in not active', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })

      const status = await getClassStatus(cls.id)
      assert.equal(status.countdown, null)
    })

    it('returns countdown info when sign-in is active', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      const startedAt = new Date()
      await prisma.signInConfig.create({
        data: { classId: cls.id, activeStartedAt: startedAt, countdownDurationMin: 40 },
      })

      const status = await getClassStatus(cls.id)
      assert.ok(status.countdown)
      assert.equal(status.countdown.durationMin, 40)
    })
  })

  describe('makeSessionLabel', async () => {
    const { makeSessionLabel } = await import('./attendance.js')

    it('generates a label with date, day of week, and class name', () => {
      const label = makeSessionLabel('测试班级')
      // 格式: "2026-05-26 周一 上午 HH:MM:SS · 测试班级"
      assert.ok(label.includes('测试班级'))
      assert.ok(label.includes(' · '))
      // 应该包含星期
      assert.ok(/(周一|周二|周三|周四|周五|周六|周日)/.test(label))
    })
  })

  describe('startSignIn', async () => {
    const { startSignIn } = await import('./attendance.js')

    it('returns error for non-existent class', async () => {
      const result = await startSignIn(9999, 30)
      assert.equal(result.ok, false)
      assert.equal(result.message, '班级不存在')
    })

    it('starts sign-in with default duration', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })

      const result = await startSignIn(cls.id)
      assert.equal(result.ok, true)
      assert.ok(result.countdownEnd instanceof Date)
    })

    it('starts sign-in with custom duration', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })

      const result = await startSignIn(cls.id, 15)
      assert.equal(result.ok, true)

      const config = await prisma.signInConfig.findUnique({
        where: { classId: cls.id },
      })
      assert.equal(config.countdownDurationMin, 15)
    })
  })

  describe('archiveAndReset', async () => {
    const { archiveAndReset, getSessions, getSessionDetail } = await import('./attendance.js')

    it('archives current sign-in records into a session', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({ data: { name: '张三', classId: cls.id } })
      await prisma.student.create({ data: { name: '李四', classId: cls.id } })

      // 创建签到记录
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '李四', computerName: 'PC02' },
      })
      // 设置活跃签到
      await prisma.signInConfig.create({
        data: { classId: cls.id, activeStartedAt: new Date(), countdownDurationMin: 30 },
      })

      const result = await archiveAndReset(cls.id)
      assert.equal(result.ok, true)
      assert.ok(result.label)

      // 验证签到记录已清空
      const remaining = await prisma.signInRecord.count({ where: { classId: cls.id } })
      assert.equal(remaining, 0)

      // 验证 activeStartedAt 已重置
      const config = await prisma.signInConfig.findUnique({ where: { classId: cls.id } })
      assert.equal(config.activeStartedAt, null)

      // 验证已归档
      const { sessions } = await getSessions(cls.id)
      assert.equal(sessions.length, 1)
    })

    it('returns null label when no records to archive', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })

      const result = await archiveAndReset(cls.id)
      assert.equal(result.ok, true)
      assert.equal(result.label, null)
    })

    it('getSessionDetail returns archived records', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })

      await archiveAndReset(cls.id)

      const { sessions } = await getSessions(cls.id)
      const session = await getSessionDetail(sessions[0].id)
      assert.ok(session)
      assert.equal(session.records.length, 1)
      assert.equal(session.records[0].studentName, '张三')
    })
  })

  describe('getAttendanceStats', async () => {
    const { getAttendanceStats } = await import('./attendance.js')

    it('calculates correct attendance rate', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.student.create({ data: { name: '全勤生', classId: cls.id } })
      await prisma.student.create({ data: { name: '缺勤生', classId: cls.id } })

      // 创建3个历史批次
      for (let i = 0; i < 3; i++) {
        const session = await prisma.signInSession.create({
          data: { classId: cls.id, label: `session_${uid()}_${i}` },
        })
        // 全勤生每次都签到了
        await prisma.archivedRecord.create({
          data: {
            sessionId: session.id,
            studentName: '全勤生',
            computerName: 'PC01',
            signedAt: new Date(),
          },
        })
      }
      // 缺勤生只在1个批次签到
      const session1 = await prisma.signInSession.findFirst({ where: { classId: cls.id } })
      await prisma.archivedRecord.create({
        data: {
          sessionId: session1.id,
          studentName: '缺勤生',
          computerName: 'PC02',
          signedAt: new Date(),
        },
      })

      const stats = await getAttendanceStats(cls.id)
      assert.equal(stats.totalSessions, 3)

      const perfectStudent = stats.students.find(s => s.name === '全勤生')
      const absentStudent = stats.students.find(s => s.name === '缺勤生')

      assert.equal(perfectStudent.signedCount, 3)
      assert.equal(perfectStudent.rate, '100.00')
      assert.equal(absentStudent.signedCount, 1)
      assert.equal(absentStudent.rate, '33.33')
    })
  })

  describe('deleteSignInRecord', async () => {
    const { deleteSignInRecord } = await import('./attendance.js')

    it('returns error for non-existent record', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const result = await deleteSignInRecord(9999, teacher.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 404)
    })

    it('returns error for unauthorized teacher', async () => {
      const teacher1 = await prisma.teacher.create({
        data: { username: `t1_${uid()}`, passwordHash: 'hash' },
      })
      const teacher2 = await prisma.teacher.create({
        data: { username: `t2_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher1.id },
      })
      const record = await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })

      const result = await deleteSignInRecord(record.id, teacher2.id)
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    })

    it('admin can delete any record', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const admin = await prisma.teacher.create({
        data: { username: `admin_${uid()}`, passwordHash: 'hash', isAdmin: true },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      const record = await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })

      const result = await deleteSignInRecord(record.id, admin.id, true)
      assert.equal(result.ok, true)
    })
  })

  describe('recoverExpiredCountdowns', async () => {
    const { recoverExpiredCountdowns } = await import('./attendance.js')

    it('archives expired countdowns', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })
      // 设置一个已过期的签到
      const pastDate = new Date(Date.now() - 60 * 60 * 1000) // 1 小时前
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: pastDate,
          countdownDurationMin: 30,
        },
      })

      await recoverExpiredCountdowns()

      // 验证签到记录已归档
      const remaining = await prisma.signInRecord.count({ where: { classId: cls.id } })
      assert.equal(remaining, 0)

      const config = await prisma.signInConfig.findUnique({ where: { classId: cls.id } })
      assert.equal(config.activeStartedAt, null)
    })

    it('does not affect active countdowns', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })
      // 设置一个活跃的签到
      await prisma.signInConfig.create({
        data: {
          classId: cls.id,
          activeStartedAt: new Date(),
          countdownDurationMin: 30,
        },
      })

      await recoverExpiredCountdowns()

      // 签到记录应该还在
      const remaining = await prisma.signInRecord.count({ where: { classId: cls.id } })
      assert.equal(remaining, 1)
    })
  })

  describe('clearRoster', async () => {
    const { clearRoster } = await import('./attendance.js')

    it('deletes all records, tags, and students for a class', async () => {
      const teacher = await prisma.teacher.create({
        data: { username: `t_${uid()}`, passwordHash: 'hash' },
      })
      const cls = await prisma.class.create({
        data: { name: `c_${uid()}`, teacherId: teacher.id },
      })
      const student = await prisma.student.create({
        data: { name: '张三', classId: cls.id },
      })
      await prisma.studentTag.create({
        data: { classId: cls.id, studentId: student.id, tag: '测试标签' },
      })
      await prisma.signInRecord.create({
        data: { classId: cls.id, studentName: '张三', computerName: 'PC01' },
      })

      await clearRoster(cls.id)

      assert.equal(await prisma.signInRecord.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.studentTag.count({ where: { classId: cls.id } }), 0)
      assert.equal(await prisma.student.count({ where: { classId: cls.id } }), 0)
    })
  })
})
