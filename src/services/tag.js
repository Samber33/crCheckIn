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
 * 获取所有预设标签
 */
export async function getPresetTags() {
  return prisma.presetTag.findMany({ orderBy: { sortOrder: 'asc' } })
}

/**
 * 获取预设标签名称列表
 */
export async function getPresetTagNames() {
  const tags = await getPresetTags()
  return tags.map(t => t.tag)
}

/**
 * 添加预设标签
 */
export async function addPresetTag(tag, color) {
  const existing = await prisma.presetTag.findUnique({ where: { tag } })
  if (existing) return { ok: false, message: '预设标签已存在' }
  const maxSort = await prisma.presetTag.aggregate({ _max: { sortOrder: true } })
  const newOrder = (maxSort._max.sortOrder || 0) + 1
  await prisma.presetTag.create({
    data: { tag, color: color || TAG_COLORS[0], sortOrder: newOrder },
  })
  return { ok: true }
}

/**
 * 更新预设标签
 */
export async function updatePresetTag(tagId, data) {
  const existing = await prisma.presetTag.findUnique({ where: { id: tagId } })
  if (!existing) return { ok: false, message: '预设标签不存在', status: 404 }
  const updateData = {}
  if (data.tag !== undefined) updateData.tag = data.tag
  if (data.color !== undefined) updateData.color = data.color
  await prisma.presetTag.update({ where: { id: tagId }, data: updateData })
  return { ok: true }
}

/**
 * 删除预设标签
 */
export async function deletePresetTag(tagId) {
  const existing = await prisma.presetTag.findUnique({ where: { id: tagId } })
  if (!existing) return { ok: false, message: '预设标签不存在', status: 404 }
  await prisma.presetTag.delete({ where: { id: tagId } })
  return { ok: true }
}

/**
 * 更新预设标签排序
 */
export async function reorderPresetTags(orderedIds) {
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.presetTag.update({ where: { id }, data: { sortOrder: i } })
    )
  )
  return { ok: true }
}

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
