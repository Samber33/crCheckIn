import { prisma } from '../plugins/db.js'

/**
 * 将教师拥有的非归档班级复制到班级池（teacherId = null）。
 * 幂等：跳过池中已有的班级名称，只复制新班级。
 * 安全：事务内逐个班级复制，失败不影响已有数据。
 */
export async function migrateTeacherClassesToPool() {
  const existingPoolNames = new Set(
    (await prisma.class.findMany({
      where: { teacherId: null },
      select: { name: true },
    })).map(c => c.name)
  )

  const teacherClasses = await prisma.class.findMany({
    where: { teacherId: { not: null }, isArchived: false },
    orderBy: { id: 'asc' },
    include: { students: { select: { name: true, homeClass: true, remark: true } } },
  })

  if (teacherClasses.length === 0) {
    console.log('[migrate] No teacher-owned classes to migrate.')
    return
  }

  let copied = 0
  let skipped = 0
  for (const cls of teacherClasses) {
    if (existingPoolNames.has(cls.name)) {
      skipped++
      continue
    }

    try {
      await prisma.$transaction(async (tx) => {
        const poolClass = await tx.class.create({
          data: { name: cls.name, teacherId: null, signInConfig: { create: {} } },
        })
        if (cls.students.length > 0) {
          await tx.student.createMany({
            data: cls.students.map(s => ({
              name: s.name,
              homeClass: s.homeClass,
              remark: s.remark,
              classId: poolClass.id,
            })),
          })
        }
      })
      console.log(`[migrate] Copied「${cls.name}」(${cls.students.length} students) to pool`)
      copied++
    } catch (err) {
      console.error(`[migrate] Failed to copy「${cls.name}」:`, err.message)
    }
  }

  console.log(`[migrate] Done: ${copied} copied, ${skipped} skipped (already in pool)`)
}
