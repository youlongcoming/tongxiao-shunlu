const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const imageSafety = require('./image')
const schoolChange = require('./school-change')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function validStudentId(value) {
  return !value || /^[A-Za-z0-9_-]{4,20}$/.test(value)
}

function validPhone(value) {
  return /^1[3-9]\d{9}$/.test(String(value || ''))
}

function sanitizeSchool(input) {
  const school = input || {}
  const result = {
    schoolId: cleanText(school.id || school.schoolId, 10),
    schoolName: cleanText(school.name || school.schoolName, 60),
    schoolProvince: cleanText(school.province || school.schoolProvince, 20),
    schoolCity: cleanText(school.city || school.schoolCity, 30),
    schoolLevel: cleanText(school.level || school.schoolLevel, 12)
  }
  if (!/^\d{10}$/.test(result.schoolId) || !result.schoolName || !result.schoolProvince || !result.schoolCity) {
    throw new Error('学校信息无效，请重新选择')
  }
  return result
}

function publicSchool(user) {
  return {
    id: user.schoolId || '',
    name: user.schoolName || '',
    province: user.schoolProvince || '',
    city: user.schoolCity || '',
    level: user.schoolLevel || ''
  }
}

function privateProfile(user, paymentCodeUrl) {
  if (!user) {
    return null
  }
  return {
    name: user.name || '',
    avatar: user.avatar || '',
    paymentCode: user.paymentCode || '',
    paymentCodeUrl: paymentCodeUrl || '',
    gender: user.gender || '不公开',
    grade: user.grade || '大一',
    major: user.major || '',
    bio: user.bio || '',
    friendCode: user.friendCode || '',
    phone: validPhone(user.phone) ? String(user.phone) : '',
    studentId: validStudentId(String(user.studentId || '')) ? String(user.studentId || '') : '',
    schoolId: user.schoolId || '',
    schoolName: user.schoolName || '',
    schoolProvince: user.schoolProvince || '',
    schoolCity: user.schoolCity || '',
    schoolLevel: user.schoolLevel || ''
  }
}

function sanitizeProfile(input) {
  const profile = input || {}
  const allowedGenders = ['男', '女', '不公开']
  const allowedGrades = ['大一', '大二', '大三', '大四', '研究生', '其他']
  return {
    name: cleanText(profile.name, 16),
    gender: allowedGenders.indexOf(profile.gender) === -1 ? '不公开' : profile.gender,
    grade: allowedGrades.indexOf(profile.grade) === -1 ? '大一' : profile.grade,
    major: cleanText(profile.major, 30),
    bio: cleanText(profile.bio, 120),
    phone: cleanText(profile.phone, 11),
    studentId: cleanText(profile.studentId, 20)
  }
}

async function getUser(openid) {
  const result = await db.collection('users').where({ openid: openid }).limit(1).get()
  return result.data[0] || null
}

async function deleteFileQuietly(fileID) {
  if (!fileID || String(fileID).indexOf('cloud://') !== 0) {
    return
  }
  try {
    await cloud.deleteFile({ fileList: [fileID] })
  } catch (error) {
    console.warn('[profile] old file cleanup failed:', error.errCode || error.message)
  }
}

async function tempFileUrl(fileID) {
  if (!fileID || String(fileID).indexOf('cloud://') !== 0) {
    return ''
  }
  try {
    const result = await cloud.getTempFileURL({ fileList: [fileID] })
    const file = result && Array.isArray(result.fileList) ? result.fileList[0] : null
    return file && Number(file.status || 0) === 0 && file.tempFileURL ? file.tempFileURL : ''
  } catch (error) {
    console.warn('[profile] temporary file URL failed:', error.errCode || error.message)
    return ''
  }
}

async function main(event) {
  const openid = cloud.getWXContext().OPENID
  const users = db.collection('users')
  const user = await getUser(openid)

  if (!user) {
    return { ok: false, message: '请重新进入小程序完成身份初始化' }
  }

  if (event.action === 'get') {
    return {
      ok: true,
      profile: privateProfile(user, await tempFileUrl(user.paymentCode)),
      schoolChangePolicy: schoolChange.buildSchoolChangePolicy(user, Date.now())
    }
  }

  if (event.action === 'setSchool') {
    let school
    try {
      school = sanitizeSchool(event.school)
    } catch (error) {
      return { ok: false, code: 'INVALID_SCHOOL', message: error.message }
    }
    const now = Date.now()
    const result = await db.runTransaction(async function (transaction) {
      const transactionUsers = transaction.collection('users')
      const latestResult = await transactionUsers.doc(user._id).get()
      const latestUser = latestResult.data
      if (!latestUser) {
        return { missing: true }
      }

      const hasSchool = /^\d{10}$/.test(String(latestUser.schoolId || ''))
      const sameSchool = hasSchool && latestUser.schoolId === school.schoolId
      const currentPolicy = schoolChange.buildSchoolChangePolicy(latestUser, now)
      if (hasSchool && !sameSchool && !currentPolicy.canChange) {
        return {
          blocked: true,
          school: publicSchool(latestUser),
          schoolChangePolicy: currentPolicy
        }
      }

      const update = Object.assign({}, school, { updatedAt: db.serverDate() })
      if (!hasSchool) {
        update.schoolSelectedAt = db.serverDate()
      } else if (!sameSchool) {
        update.schoolChangedAt = db.serverDate()
        update.schoolChangeMonth = schoolChange.monthKey(now)
      }
      await transactionUsers.doc(user._id).update({ data: update })

      const nextUser = Object.assign({}, latestUser, school)
      if (update.schoolChangeMonth) {
        nextUser.schoolChangeMonth = update.schoolChangeMonth
        nextUser.schoolChangedAt = new Date(now)
      }
      return {
        blocked: false,
        school: publicSchool(nextUser),
        schoolChangePolicy: schoolChange.buildSchoolChangePolicy(nextUser, now)
      }
    })

    if (result.missing) {
      return { ok: false, code: 'USER_NOT_FOUND', message: '请重新进入小程序完成身份初始化' }
    }
    if (result.blocked) {
      return {
        ok: false,
        code: 'SCHOOL_CHANGE_LIMIT',
        message: result.schoolChangePolicy.message,
        school: result.school,
        schoolChangePolicy: result.schoolChangePolicy
      }
    }
    return {
      ok: true,
      school: result.school,
      schoolChangePolicy: result.schoolChangePolicy
    }
  }

  if (event.action === 'save') {
    const profile = sanitizeProfile(event.profile)
    if (!profile.name) {
      return { ok: false, message: '姓名或昵称不能为空' }
    }
    if (!validPhone(profile.phone)) {
      return { ok: false, code: 'PHONE_REQUIRED', message: '请输入正确的 11 位手机号' }
    }
    if (!validStudentId(profile.studentId)) {
      return { ok: false, message: '学号仅支持 4-20 位字母、数字、下划线或短横线' }
    }
    await users.doc(user._id).update({
      data: Object.assign({}, profile, { updatedAt: db.serverDate() })
    })
    return {
      ok: true,
      profile: Object.assign(privateProfile(user, await tempFileUrl(user.paymentCode)), profile)
    }
  }

  if (event.action === 'prepareAvatar') {
    const extension = ['jpg', 'jpeg', 'png', 'webp'].indexOf(String(event.extension || '').toLowerCase()) !== -1
      ? String(event.extension).toLowerCase()
      : 'jpg'
    const token = crypto.randomBytes(24).toString('hex')
    const cloudPath = 'avatars/pending/' + user._id + '/' + token + '.' + extension
    await users.doc(user._id).update({
      data: {
        pendingAvatarPath: cloudPath,
        pendingAvatarExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, cloudPath: cloudPath }
  }

  if (event.action === 'commitAvatar') {
    const fileID = cleanText(event.fileID, 600)
    const pendingPath = user.pendingAvatarPath || ''
    const expiresAt = user.pendingAvatarExpiresAt ? new Date(user.pendingAvatarExpiresAt).getTime() : 0
    if (!fileID || !pendingPath || !fileID.endsWith('/' + pendingPath) || expiresAt < Date.now()) {
      await deleteFileQuietly(fileID)
      return { ok: false, message: '头像上传凭证无效或已过期，请重新选择' }
    }

    let download
    try {
      download = await cloud.downloadFile({ fileID: fileID })
      const inspected = imageSafety.validateImageBuffer(download.fileContent, undefined, '头像')
      const safetyResult = await cloud.openapi.security.imgSecCheck({
        media: {
          contentType: inspected.contentType,
          value: download.fileContent
        }
      })
      if (safetyResult && Number(safetyResult.errCode || 0) !== 0) {
        throw new Error('头像未通过内容安全检测')
      }
    } catch (error) {
      await deleteFileQuietly(fileID)
      return {
        ok: false,
        code: 'AVATAR_REJECTED',
        message: error.message || '头像安全检测失败，请更换图片'
      }
    }

    const previousAvatar = user.avatar || ''
    await users.doc(user._id).update({
      data: {
        avatar: fileID,
        pendingAvatarPath: db.command.remove(),
        pendingAvatarExpiresAt: db.command.remove(),
        updatedAt: db.serverDate()
      }
    })
    if (previousAvatar && previousAvatar !== fileID) {
      await deleteFileQuietly(previousAvatar)
    }
    return { ok: true, avatar: fileID }
  }

  if (event.action === 'preparePaymentCode') {
    const extension = ['jpg', 'jpeg', 'png', 'webp'].indexOf(String(event.extension || '').toLowerCase()) !== -1
      ? String(event.extension).toLowerCase()
      : 'jpg'
    const token = crypto.randomBytes(24).toString('hex')
    const cloudPath = 'payment-codes/pending/' + user._id + '/' + token + '.' + extension
    await users.doc(user._id).update({
      data: {
        pendingPaymentCodePath: cloudPath,
        pendingPaymentCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, cloudPath: cloudPath }
  }

  if (event.action === 'commitPaymentCode') {
    const fileID = cleanText(event.fileID, 600)
    const pendingPath = user.pendingPaymentCodePath || ''
    const expiresAt = user.pendingPaymentCodeExpiresAt ? new Date(user.pendingPaymentCodeExpiresAt).getTime() : 0
    if (!fileID || !pendingPath || !fileID.endsWith('/' + pendingPath) || expiresAt < Date.now()) {
      await deleteFileQuietly(fileID)
      return { ok: false, message: '收款码上传凭证无效或已过期，请重新选择' }
    }

    try {
      const download = await cloud.downloadFile({ fileID: fileID })
      const inspected = imageSafety.validateImageBuffer(download.fileContent, 2 * 1024 * 1024, '收款码')
      const safetyResult = await cloud.openapi.security.imgSecCheck({
        media: {
          contentType: inspected.contentType,
          value: download.fileContent
        }
      })
      if (safetyResult && Number(safetyResult.errCode || 0) !== 0) {
        throw new Error('收款码未通过内容安全检测')
      }
    } catch (error) {
      await deleteFileQuietly(fileID)
      return {
        ok: false,
        code: 'PAYMENT_CODE_REJECTED',
        message: error.message || '收款码安全检测失败，请更换图片'
      }
    }

    const previousPaymentCode = user.paymentCode || ''
    await users.doc(user._id).update({
      data: {
        paymentCode: fileID,
        pendingPaymentCodePath: db.command.remove(),
        pendingPaymentCodeExpiresAt: db.command.remove(),
        paymentCodeUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    if (previousPaymentCode && previousPaymentCode !== fileID) {
      await deleteFileQuietly(previousPaymentCode)
    }
    return {
      ok: true,
      paymentCode: fileID,
      paymentCodeUrl: await tempFileUrl(fileID)
    }
  }

  if (event.action === 'removePaymentCode') {
    const previousPaymentCode = user.paymentCode || ''
    await users.doc(user._id).update({
      data: {
        paymentCode: db.command.remove(),
        paymentCodeUpdatedAt: db.command.remove(),
        updatedAt: db.serverDate()
      }
    })
    await deleteFileQuietly(previousPaymentCode)
    return { ok: true }
  }

  return { ok: false, message: '不支持的资料操作' }
}

module.exports = { main: main }
