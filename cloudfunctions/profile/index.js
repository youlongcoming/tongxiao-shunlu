const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function sanitizeProfile(input) {
  const profile = input || {}
  const allowedGenders = ['男', '女', '不公开']
  const allowedGrades = ['大一', '大二', '大三', '大四', '研究生', '其他']
  const gender = allowedGenders.indexOf(profile.gender) === -1 ? '不公开' : profile.gender
  const grade = allowedGrades.indexOf(profile.grade) === -1 ? '大一' : profile.grade

  return {
    name: cleanText(profile.name, 16),
    avatar: cleanText(profile.avatar, 500),
    gender: gender,
    grade: grade,
    major: cleanText(profile.major, 30),
    bio: cleanText(profile.bio, 120)
  }
}

exports.main = async function (event) {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const users = db.collection('users')
  const existing = await users.where({ openid: openid }).limit(1).get()

  if (event.action === 'get') {
    return {
      ok: true,
      profile: existing.data[0] || null
    }
  }

  if (event.action !== 'save') {
    return { ok: false, message: '不支持的资料操作' }
  }

  const profile = sanitizeProfile(event.profile)
  if (!profile.name) {
    return { ok: false, message: '姓名或昵称不能为空' }
  }

  if (existing.data.length) {
    await users.doc(existing.data[0]._id).update({
      data: Object.assign({}, profile, {
        updatedAt: db.serverDate()
      })
    })
  } else {
    await users.add({
      data: Object.assign({}, profile, {
        openid: openid,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      })
    })
  }

  return {
    ok: true,
    profile: profile
  }
}

// 新版资料服务增加头像安全与私有学号资料，同时保留旧实现便于回滚。
module.exports = require('./service')

