import { pinyin } from 'pinyin-pro'
import iconv from 'iconv-lite'

const cache = new Map()
const HAN_CHARACTER_RE = /\p{Script=Han}/u
const GB2312_LEVEL_ONE_START = 0xb0a1
const GB2312_LEVEL_ONE_END = 0xd7f9

/**
 * GB2312 一级汉字覆盖常见中文字符。姓名中超出该范围的汉字默认视为
 * 需要提示读音的字符；非汉字不标注。
 * @param {string} character
 * @returns {boolean}
 */
export function shouldAnnotateNameCharacter(character) {
  if (!HAN_CHARACTER_RE.test(character)) return false
  const bytes = iconv.encode(character, 'gb2312')
  if (bytes.length !== 2) return true
  const code = (bytes[0] << 8) | bytes[1]
  return code < GB2312_LEVEL_ONE_START || code > GB2312_LEVEL_ONE_END
}

/**
 * 将中文姓名转换为拼音全拼、首字母和带声调拼音。
 * @param {string} name - 中文姓名
 * @returns {{ full: string, initials: string, toned: string, parts: Array<{ character: string, pinyin: string, annotate: boolean }> }}
 */
export function nameToPinyin(name) {
  if (cache.has(name)) return cache.get(name)
  const arr = pinyin(name, { toneType: 'none', type: 'array' })
  const full = arr.join('')
  const initials = arr.map(w => w[0]).join('')
  const tonedArr = pinyin(name, { toneType: 'symbol', type: 'array' })
  const toned = tonedArr.join(' ')
  const parts = Array.from(name).map((character, index) => ({
    character,
    pinyin: tonedArr[index] || '',
    annotate: shouldAnnotateNameCharacter(character),
  }))
  const result = { full, initials, toned, parts }
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
