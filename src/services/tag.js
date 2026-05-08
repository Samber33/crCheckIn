import { prisma } from '../plugins/db.js'

// 预定义标签颜色
const TAG_COLORS = [
  '#cc785c', // coral
  '#5db872', // green
  '#d4a017', // yellow
  '#7c6cf0', // purple
  '#4a90d9', // blue
  '#e67e22', // orange
]

/**
 * 获取某个学生的标签
 */
export async function getStudentTags(classId, studentId) {
  return prisma.studentTag.findMany({
    where: { classId, studentId },
    orderBy: { id: 'asc' },
  })
}

/**
 * 获取班级所有学生的标签（批量）
 */
export async function getClassTags(classId) {
  const tags = await prisma.studentTag.findMany({ where: { classId } })
  const map = new Map()
  for (const tag of tags) {
    if (!map.has(tag.studentId)) map.set(tag.studentId, [])
    map.get(tag.studentId).push({ id: tag.id, tag: tag.tag, color: tag.color })
  }
  return map
}

/**
 * 给学生添加标签
 */
export async function addStudentTag(classId, studentId, tagName, color) {
  const existing = await prisma.studentTag.findFirst({
    where: { classId, studentId, tag: tagName },
  })
  if (existing) {
    return { ok: false, message: '标签已存在。' }
  }
  const tag = await prisma.studentTag.create({
    data: {
      classId,
      studentId,
      tag: tagName,
      color: color || TAG_COLORS[0],
    },
  })
  return { ok: true, tag }
}

/**
 * 删除学生标签
 */
export async function deleteStudentTag(classId, tagId, teacherId, isAdmin = false) {
  const tag = await prisma.studentTag.findUnique({
    where: { id: tagId },
    include: { student: { include: { class: true } } },
  })
  if (!tag) {
    return { ok: false, message: '标签不存在', status: 404 }
  }
  if (!isAdmin && tag.student.class.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }
  await prisma.studentTag.delete({ where: { id: tagId } })
  return { ok: true }
}

/**
 * 获取下一轮换颜色
 */
export function getNextColor(index) {
  return TAG_COLORS[index % TAG_COLORS.length]
}
