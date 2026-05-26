import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nameToPinyin, matchesPinyin } from './pinyin.js'

describe('nameToPinyin', () => {
  it('converts Chinese name to full pinyin', () => {
    const result = nameToPinyin('张三')
    assert.equal(result.full, 'zhangsan')
  })

  it('converts Chinese name to initials', () => {
    const result = nameToPinyin('张三')
    assert.equal(result.initials, 'zs')
  })

  it('handles three-character names', () => {
    const result = nameToPinyin('李小明')
    assert.equal(result.full, 'lixiaoming')
    assert.equal(result.initials, 'lxm')
  })

  it('handles four-character names', () => {
    const result = nameToPinyin('欧阳娜娜')
    assert.equal(result.full, 'ouyangnana')
    assert.equal(result.initials, 'oynn')
  })

  it('caches results for repeated calls', () => {
    const r1 = nameToPinyin('王五')
    const r2 = nameToPinyin('王五')
    assert.strictEqual(r1, r2) // same object reference (cache hit)
  })
})

describe('matchesPinyin', () => {
  it('matches exact Chinese characters', () => {
    assert.equal(matchesPinyin('张三', '张'), true)
    assert.equal(matchesPinyin('张三', '张三'), true)
    assert.equal(matchesPinyin('张三', '三'), true)
  })

  it('matches pinyin full spelling', () => {
    assert.equal(matchesPinyin('张三', 'zhang'), true)
    assert.equal(matchesPinyin('张三', 'zhangsan'), true)
    assert.equal(matchesPinyin('张三', 'san'), true)
  })

  it('matches pinyin initials', () => {
    assert.equal(matchesPinyin('张三', 'z'), true)
    assert.equal(matchesPinyin('张三', 'zs'), true)
    assert.equal(matchesPinyin('李小明', 'l'), true)
    assert.equal(matchesPinyin('李小明', 'lxm'), true)
  })

  it('case insensitive for pinyin matching', () => {
    assert.equal(matchesPinyin('张三', 'ZHANG'), true)
    assert.equal(matchesPinyin('张三', 'ZS'), true)
    assert.equal(matchesPinyin('张三', 'ZhangSan'), true)
  })

  it('returns false for non-matching query', () => {
    assert.equal(matchesPinyin('张三', 'li'), false)
    assert.equal(matchesPinyin('张三', '王'), false)
    assert.equal(matchesPinyin('张三', 'ww'), false)
  })
})
