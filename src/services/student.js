import { prisma } from '../plugins/db.js'

function currentSignInRecordWhere(student) {
  return {
    OR: [
      { studentId: student.id },
      { classId: student.classId, studentName: student.name, studentId: null },
    ],
  }
}

/**
 * 校验 studentId 归属 teacherId 管辖的班级
 */
async function assertStudentOwner(studentId, teacherId, isAdmin = false) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { class: true },
  })
  if (!student) return { ok: false, message: '学生不存在', status: 404 }
  if (!isAdmin && student.class.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }
  return { ok: true, student }
}

/**
 * 校验 classId 是否属于 teacherId 管辖
 */
async function assertClassOwner(classId, teacherId, isAdmin = false) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (!isAdmin && cls.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }
  return { ok: true, class: cls }
}

/**
 * 创建学生
 * @param {number} classId
 * @param {string} name
 * @param {string} homeClass
 * @param {string} remark
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function createStudent(classId, name, homeClass = '', remark = '', teacherId, isAdmin = false) {
  const check = await assertClassOwner(classId, teacherId, isAdmin)
  if (!check.ok) return check

  const trimmedName = name?.trim()
  if (!trimmedName) return { ok: false, message: '学生姓名不能为空', status: 400 }

  // 同班姓名唯一性校验
  const dup = await prisma.student.findFirst({
    where: { classId, name: trimmedName },
  })
  if (dup) return { ok: false, message: '该姓名在本班已存在', status: 409 }

  const student = await prisma.student.create({
    data: {
      classId,
      name: trimmedName,
      homeClass: homeClass?.trim() || '',
      remark: remark?.trim() || '',
    },
  })

  return { ok: true, student }
}

/**
 * 更新学生信息（姓名 / 行政班级 / 备注）
 * @param {number} studentId
 * @param {{ name?: string, homeClass?: string, remark?: string }} data
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function updateStudent(studentId, data, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check
  const newName = data.name?.trim() ?? student.name
  const newHomeClass = data.homeClass !== undefined ? data.homeClass.trim() : student.homeClass
  const newRemark = data.remark !== undefined ? data.remark.trim() : student.remark

  if (!newName) {
    return { ok: false, message: '学生姓名不能为空', status: 400 }
  }

  // 同班姓名唯一性校验
  if (newName !== student.name) {
    const dup = await prisma.student.findFirst({
      where: { classId: student.classId, name: newName },
    })
    if (dup) return { ok: false, message: '该姓名在本班已存在', status: 409 }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (newName !== student.name) {
        await tx.signInRecord.updateMany({
          where: currentSignInRecordWhere(student),
          data: {
            studentName: newName,
            studentId: student.id,
          },
        })
      }

      return tx.student.update({
        where: { id: studentId },
        data: { name: newName, homeClass: newHomeClass, remark: newRemark },
      })
    })

    return { ok: true, student: updated }
  } catch (err) {
    if (err.code === 'P2002') {
      return { ok: false, message: '当前签到中已存在同名记录，请先处理签到记录后再重试', status: 409 }
    }
    throw err
  }
}

/**
 * 删除学生（级联删除当前批次签到记录）
 * @param {number} studentId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function deleteStudent(studentId, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check
  await prisma.$transaction(async (tx) => {
    await tx.signInRecord.deleteMany({ where: currentSignInRecordWhere(student) })
    await tx.student.delete({ where: { id: studentId } })
  })
  return { ok: true }
}

/**
 * 将学生转移到另一个教学班
 */
export async function transferStudent(studentId, targetClassId, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check

  await prisma.$transaction(async (tx) => {
    // 目标班级归属校验（合并到事务中，避免单独查询）
    const targetClass = await tx.class.findUnique({ where: { id: targetClassId } })
    if (!targetClass) {
      throw Object.assign(new Error('目标班级不存在'), { code: 'TARGET_NOT_FOUND' })
    }
    if (!isAdmin && targetClass.teacherId !== teacherId) {
      throw Object.assign(new Error('无权限操作目标班级'), { code: 'NO_PERMISSION' })
    }

    // 目标班级同名校验
    const dup = await tx.student.findFirst({ where: { classId: targetClassId, name: student.name } })
    if (dup) {
      throw Object.assign(new Error('目标班级中已存在同名学生'), { code: 'DUPLICATE' })
    }

    await tx.signInRecord.deleteMany({ where: currentSignInRecordWhere(student) })
    await tx.studentTag.deleteMany({ where: { classId: student.classId, studentId } })
    await tx.student.update({ where: { id: studentId }, data: { classId: targetClassId } })
  })

  // 学生跨班转移后，原班级的缓存不受影响（缓存按 classId 索引），无需失效
  return { ok: true }
}
