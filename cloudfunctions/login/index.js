const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function randomCode() {
  return 'CP-' + Math.random().toString(36).slice(2, 8).toUpperCase()
}

function validStudentId(value) {
  return !value || /^[A-Za-z0-9_-]{4,20}$/.test(value)
}

async function createUniqueFriendCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const friendCode = randomCode()
    const existing = await db.collection('users').where({ friendCode: friendCode }).limit(1).get()
    if (!existing.data.length) {
      return friendCode
    }
  }
  return 'CP-' + Date.now().toString(36).slice(-6).toUpperCase()
}

exports.main = async function () {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const users = db.collection('users')
  const existing = await users.where({ openid: openid }).limit(1).get()
  let user

  if (existing.data.length) {
    user = existing.data[0]
    const friendCode = !user.friendCode || !/^CP-/i.test(user.friendCode)
      ? await createUniqueFriendCode()
      : user.friendCode
    const studentId = validStudentId(String(user.studentId || '')) ? String(user.studentId || '') : ''
    await users.doc(user._id).update({
      data: {
        friendCode: friendCode,
        studentId: studentId,
        lastLoginAt: db.serverDate()
      }
    })
    user.friendCode = friendCode
    user.studentId = studentId
  } else {
    const friendCode = await createUniqueFriendCode()
    const created = await users.add({
      data: {
        openid: openid,
        friendCode: friendCode,
        name: '',
        avatar: '',
        gender: '不公开',
        grade: '大一',
        major: '',
        bio: '',
        studentId: '',
        schoolId: '',
        schoolName: '',
        schoolProvince: '',
        schoolCity: '',
        schoolLevel: '',
        createdAt: db.serverDate(),
        lastLoginAt: db.serverDate()
      }
    })
    user = {
      _id: created._id,
      openid: openid,
      friendCode: friendCode,
      name: '',
      avatar: '',
      gender: '不公开',
      grade: '大一',
      major: '',
      bio: '',
      studentId: '',
      schoolId: '',
      schoolName: '',
      schoolProvince: '',
      schoolCity: '',
      schoolLevel: ''
    }
  }

  return {
    ok: true,
    openid: openid,
    appid: context.APPID,
    user: {
      userId: user._id,
      friendCode: user.friendCode || '',
      name: user.name || '',
      avatar: user.avatar || '',
      gender: user.gender || '不公开',
      grade: user.grade || '大一',
      major: user.major || '',
      bio: user.bio || '',
      studentId: user.studentId || '',
      schoolId: user.schoolId || '',
      schoolName: user.schoolName || '',
      schoolProvince: user.schoolProvince || '',
      schoolCity: user.schoolCity || '',
      schoolLevel: user.schoolLevel || ''
    }
  }
}

