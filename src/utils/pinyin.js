import { pinyin } from 'pinyin-pro'

const cache = new Map()

/**
 * 将中文姓名转换为拼音全拼、首字母和带声调拼音。
 * @param {string} name - 中文姓名
 * @returns {{ full: string, initials: string, toned: string }}  e.g. { full: "zhangsan", initials: "zs", toned: "zhāng sān" }
 */
export function nameToPinyin(name) {
  if (cache.has(name)) return cache.get(name)
  const arr = pinyin(name, { toneType: 'none', type: 'array' })
  const full = arr.join('')
  const initials = arr.map(w => w[0]).join('')
  const tonedArr = pinyin(name, { toneType: 'symbol', type: 'array' })
  const toned = tonedArr.join(' ')
  const result = { full, initials, toned }
  cache.set(name, result)
  return result
}

/**
 * 判断姓名是否匹配查询词（支持中文、拼音全拼、拼音首字母）。
 * @param {string} name - 原始中文姓名
 * @param {string} query - 用户输入
 * @returns {boolean}
 */
export function matchesPinyin(name, query) {
  const q = query.toLowerCase()
  const { full, initials } = nameToPinyin(name)
  return name.includes(query) || full.includes(q) || initials.includes(q)
}
