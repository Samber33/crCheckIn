import { prisma } from '../plugins/db.js'
import { getClassTags } from './tag.js'

export const TEACHER_SEAT_LAYOUT = [
  [60, 59, 44, 43, 30, 29, 16, 15],
  [58, 57, 42, 41, 28, 27, 14, 13],
  [56, 55, 40, 39, 26, 25, 12, 11],
  [54, 53, 38, 37, 24, 23, 10, 9],
  [52, 51, 36, 35, 22, 21, 8, 7],
  [50, 49, 34, 33, 20, 19, 6, 5],
  [48, 47, 32, 31, 18, 17, 4, 3],
  [46, 45, null, null, null, null, 2, 1],
]

export const STUDENT_SEAT_LAYOUT = [
  [1, 2, null, null, null, null, 45, 46],
  [3, 4, 17, 18, 31, 32, 47, 48],
  [5, 6, 19, 20, 33, 34, 49, 50],
  [7, 8, 21, 22, 35, 36, 51, 52],
  [9, 10, 23, 24, 37, 38, 53, 54],
  [11, 12, 25, 26, 39, 40, 55, 56],
  [13, 14, 27, 28, 41, 42, 57, 58],
  [15, 16, 29, 30, 43, 44, 59, 60],
]

// 学生视角：过道在列索引 1, 3, 5 右侧
// 教师视角：同样在列索引 1, 3, 5 右侧留过道

function buildSeatMapFromRecords(records) {
  const seatToStudents = new Map()

  for (const rec of records) {
    const parts = (rec.computerName || '').split('.')
    if (parts.length !== 4) continue
    const n = Number(parts[parts.length - 1])
    if (!Number.isInteger(n) || n < 1 || n > 60) continue
    if (!seatToStudents.has(n)) seatToStudents.set(n, [])
    seatToStudents.get(n).push({
      id: rec.studentId ?? null,
      name: rec.studentName,
      homeClass: rec.homeClass ?? '',
      tags: rec.tags ?? [],
    })
  }

  return seatToStudents
}

/**
 * 从签到记录构建 seatToStudents Map
 */
async function buildSeatMap(classId) {
  const records = await prisma.signInRecord.findMany({
    where: { classId },
    include: { student: true },
    orderBy: { signedAt: 'asc' },
  })

  // Batch-load orphaned students in a single query
  const orphanedNames = new Set()
  for (const rec of records) {
    if (!rec.student) orphanedNames.add(rec.studentName)
  }
  const orphanMap = new Map()
  if (orphanedNames.size > 0) {
    const orphans = await prisma.student.findMany({
      where: { classId, name: { in: [...orphanedNames] } },
    })
    for (const stu of orphans) orphanMap.set(stu.name, stu)
  }

  const normalizedRecords = []
  for (const rec of records) {
    let studentId = rec.studentId
    let homeClass = rec.student?.homeClass ?? ''
    if (!homeClass && !rec.student) {
      const stu = orphanMap.get(rec.studentName)
      homeClass = stu?.homeClass ?? ''
      studentId = stu?.id ?? null
    }
    normalizedRecords.push({
      studentId,
      studentName: rec.studentName,
      homeClass,
      computerName: rec.computerName,
    })
  }

  return buildSeatMapFromRecords(normalizedRecords)
}

function buildCell(seatNo, seatToStudents) {
  if (seatNo === null) return { seatNo: null, label: '', students: [], dupIp: false }
  const students = seatToStudents.get(seatNo) ?? []
  return { seatNo, label: String(seatNo), students, dupIp: students.length > 1 }
}

function buildStudentGridFromSeatMap(seatToStudents) {
  return STUDENT_SEAT_LAYOUT.map((row) => row.map((seatNo) => buildCell(seatNo, seatToStudents)))
}

function buildTeacherGridFromSeatMap(seatToStudents) {
  return TEACHER_SEAT_LAYOUT.map((row) => row.map((seatNo) => buildCell(seatNo, seatToStudents)))
}

/**
 * 一次性返回学生+教师视角网格，共享 buildSeatMap 结果
 */
export async function getSeatGrids(classId) {
  const seatToStudents = await buildSeatMap(classId)
  const tagMap = await getClassTags(classId)
  for (const students of seatToStudents.values()) {
    for (const stu of students) {
      if (stu.id) stu.tags = tagMap.get(stu.id) || []
    }
  }
  return {
    studentGrid: buildStudentGridFromSeatMap(seatToStudents),
    teacherGrid: buildTeacherGridFromSeatMap(seatToStudents),
  }
}

/**
 * 学生视角网格（讲台在上方，按学生查看习惯排列）
 */
export async function getSeatGrid(classId) {
  const { studentGrid } = await getSeatGrids(classId)
  return studentGrid
}

/**
 * 教师视角网格（讲台在下方，按教师查看习惯排列）
 */
export async function getSeatGridTeacher(classId) {
  const { teacherGrid } = await getSeatGrids(classId)
  return teacherGrid
}

/**
 * 根据历史批次归档记录生成座位表网格
 * @param {Array<{studentName: string, homeClass?: string, computerName?: string}>} records
 */
export function getSeatGridsFromArchivedRecords(records) {
  const seatToStudents = buildSeatMapFromRecords(records)
  return {
    studentGrid: buildStudentGridFromSeatMap(seatToStudents),
    teacherGrid: buildTeacherGridFromSeatMap(seatToStudents),
  }
}

/**
 * 根据历史批次归档记录生成带标签的座位表网格
 * @param {Array<{studentName: string, homeClass?: string, computerName?: string}>} records
 * @param {number} classId
 */
export async function getSeatGridsWithTags(records, classId) {
  const names = [...new Set(records.map(r => r.studentName))]
  const students = await prisma.student.findMany({
    where: { classId, name: { in: names } },
  })
  const tagMap = await getClassTags(classId)
  const nameToStudent = new Map(students.map(s => [s.name, s]))

  const enriched = records.map(r => {
    const stu = nameToStudent.get(r.studentName)
    return {
      studentName: r.studentName,
      studentId: stu?.id ?? null,
      homeClass: r.homeClass ?? stu?.homeClass ?? '',
      computerName: r.computerName,
      tags: stu ? (tagMap.get(stu.id) || []) : [],
    }
  })

  return getSeatGridsFromArchivedRecords(enriched)
}
