const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const domain = require('./domain')
const avatarUrl = require('./avatar-url')
const settlementLogic = require('./settlement')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
// 订阅模板 ID 只从云函数环境变量读取；留空则关闭提醒。
const DEFAULT_SUBSCRIBE_TEMPLATE_ID = ''

function configuredSubscribeTemplateId() {
  return String(process.env.CHAT_SUBSCRIBE_TEMPLATE_ID || DEFAULT_SUBSCRIBE_TEMPLATE_ID).trim()
}

function notificationTime() {
  const value = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return value.getUTCFullYear() + '年' + (value.getUTCMonth() + 1) + '月' + value.getUTCDate() + '日 ' +
    String(value.getUTCHours()).padStart(2, '0') + ':' + String(value.getUTCMinutes()).padStart(2, '0')
}

async function notifyOwnerRideJoined(ride, joiner, joinerOpenid) {
  const templateId = configuredSubscribeTemplateId()
  if (!templateId || !ride || !ride.ownerOpenid || ride.ownerOpenid === joinerOpenid) {
    return
  }
  const quotaId = domain.stableId('sub_', [ride.ownerOpenid, templateId])
  const reserved = await db.runTransaction(async function (transaction) {
    let quota = null
    try {
      quota = (await transaction.collection('subscriptions').doc(quotaId).get()).data
    } catch (error) {
      quota = null
    }
    if (!quota || Number(quota.remainingQuota || 0) < 1) {
      return false
    }
    await transaction.collection('subscriptions').doc(quotaId).update({
      data: { remainingQuota: db.command.inc(-1), lastUsedAt: db.serverDate() }
    })
    return true
  }).catch(function (error) {
    console.warn('[rides] subscription quota check failed:', error.errCode || error.message)
    return false
  })
  if (!reserved) {
    return
  }
  const groupName = domain.cleanText((ride.to || '目的地') + '拼车团', 20)
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: ride.ownerOpenid,
      templateId: templateId,
      page: 'pages/group/group?rideId=' + encodeURIComponent(ride._id),
      data: {
        thing1: { value: domain.cleanText(joiner && joiner.name ? joiner.name : '拼车同学', 20) },
        thing2: { value: '加入了你的拼车团' },
        thing14: { value: groupName },
        time3: { value: notificationTime() }
      },
      miniprogramState: process.env.MINIPROGRAM_STATE || 'developer',
      lang: 'zh_CN'
    })
  } catch (error) {
    console.warn('[rides] ride join notification failed:', error.errCode || error.message)
    await db.collection('subscriptions').doc(quotaId).update({
      data: { remainingQuota: db.command.inc(1) }
    }).catch(function (restoreError) {
      console.warn('[rides] subscription quota restore failed:', restoreError.errCode || restoreError.message)
    })
  }
}

function dateLabel(value) {
  const parts = String(value || '').split('-')
  return parts.length === 3
    ? Number(parts[1]) + '月' + String(Number(parts[2])).padStart(2, '0') + '日'
    : String(value || '')
}

async function publicUser(user, resolveAvatar) {
  return user ? {
    userId: user._id,
    name: user.name || '未命名同学',
    avatar: await resolveAvatar(user.avatar),
    gender: user.gender || '不公开',
    grade: user.grade || '',
    major: user.major || '',
    bio: user.bio || ''
  } : null
}

function publicSettlement(settlement, viewerOpenid, isOwner, payeeName, paymentCodeUrl) {
  if (!settlement || !Array.isArray(settlement.participants)) {
    return null
  }
  const counts = settlementLogic.counts(settlement)
  const participants = settlement.participants.map(function (participant) {
    return {
      userId: participant.userId,
      name: participant.name || '同学',
      role: participant.role === 'owner' ? 'owner' : 'member',
      shareFen: Number(participant.shareFen) || 0,
      shareLabel: fenLabel(participant.shareFen),
      status: participant.status || (participant.role === 'owner' ? 'owner' : 'pending'),
      isSelf: participant.openid === viewerOpenid,
      claimedAt: participant.claimedAt || null,
      confirmedAt: participant.confirmedAt || null
    }
  })
  const mine = participants.find(function (participant) { return participant.isSelf }) || null
  if (!isOwner && !mine) {
    return null
  }
  return {
    totalFen: Number(settlement.totalFen) || 0,
    totalLabel: fenLabel(settlement.totalFen),
    riderCount: Number(settlement.riderCount) || 0,
    perPersonFen: Number(settlement.perPersonFen) || 0,
    perPersonLabel: fenLabel(settlement.perPersonFen),
    participants: isOwner ? participants : (mine ? [mine] : []),
    myShareFen: mine ? mine.shareFen : 0,
    myStatus: mine ? mine.status : '',
    isParticipant: Boolean(mine),
    payeeName: payeeName || '',
    paymentCodeUrl: paymentCodeUrl || '',
    claimedCount: counts.claimedCount,
    confirmedCount: counts.confirmedCount,
    payerCount: counts.payerCount,
    canComplete: Boolean(isOwner && settlementLogic.allConfirmed(settlement))
  }
}

function publicExternalTrip(trip) {
  if (!trip || !trip.url) {
    return null
  }
  return {
    provider: String(trip.provider || ''),
    providerLabel: String(trip.providerLabel || ''),
    url: String(trip.url),
    host: String(trip.host || '')
  }
}

function fenLabel(fen) {
  return (Number(fen || 0) / 100).toFixed(2)
}

function statusLabel(status) {
  return {
    active: '进行中',
    settling: '待结算',
    settled: '已结算',
    ended: '已结束',
    cancelled: '已取消',
    disbanded: '已解散',
    expired: '已过期'
  }[status] || '状态未知'
}

function uniqueMembers(items) {
  const seen = {}
  return (items || []).filter(function (item) {
    if (!item || !item.userOpenid || seen[item.userOpenid]) {
      return false
    }
    seen[item.userOpenid] = true
    return true
  })
}

function schoolFromUser(user) {
  if (!user || !/^\d{10}$/.test(String(user.schoolId || '')) || !user.schoolName) {
    return null
  }
  return {
    schoolId: String(user.schoolId),
    schoolName: String(user.schoolName),
    schoolProvince: String(user.schoolProvince || ''),
    schoolCity: String(user.schoolCity || ''),
    schoolLevel: String(user.schoolLevel || '')
  }
}

function requireSchool(user) {
  return schoolFromUser(user) ? null : {
    ok: false,
    code: 'SCHOOL_REQUIRED',
    message: '请先选择学校，再进行校园拼车操作'
  }
}

function validPhone(value) {
  return /^1[3-9]\d{9}$/.test(String(value || ''))
}

function requirePhone(user) {
  return user && validPhone(user.phone) ? null : {
    ok: false,
    code: 'PHONE_REQUIRED',
    message: '请先在“我的”页面填写并保存手机号'
  }
}

async function getUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid: openid }).limit(1).get()
  return result.data[0] || null
}

async function getRide(rideId) {
  try {
    const result = await db.collection('rides').doc(rideId).get()
    return result.data || null
  } catch (error) {
    return null
  }
}

async function getMembers(rideId) {
  const result = await db.collection('ride_members').where({ rideId: rideId }).limit(30).get()
  return uniqueMembers(result.data)
}

function publicRide(ride, owner, memberCount, joined, openid, includeOwnerPhone, ownerAvatar) {
  const status = ride.status || 'active'
  const isActive = status === 'active'
  const safeMemberCount = isActive
    ? Math.max(1, Number(memberCount) || 1)
    : Math.max(0, Number(memberCount) || 0)
  const passengerCount = Math.max(0, safeMemberCount - 1)
  const totalSeats = Number(ride.seats || 1)
  const seatsLeft = Math.max(0, totalSeats - passengerCount)
  const started = domain.hasStarted(ride)
  const settlementDue = isActive && started && String(ride.date || '') < domain.cstDateString()
  const isOwner = ride.ownerOpenid === openid
  const canJoin = isActive && !started && !joined && !isOwner && seatsLeft > 0
  const canLeave = isActive && !started && !isOwner
  const seatsLabel = isActive
    ? (settlementDue ? '待结算' : (started ? '进行中' : (seatsLeft > 0 ? '缺 ' + seatsLeft + ' 人' : '已满')))
    : statusLabel(status)
  const statusTone = !isActive ? 'closed' : (settlementDue || started ? 'running' : (seatsLeft > 0 ? 'seats' : 'full'))
  let action = 'open'
  let actionText = '查看'
  if (isOwner) {
    action = 'manage'
    actionText = '管理'
  } else if (joined) {
    actionText = '进入拼车团'
  } else if (canJoin) {
    action = 'join'
    actionText = '加入'
  }
  return {
    id: ride._id,
    isCloud: true,
    type: ride.type,
    direction: ride.direction,
    from: ride.from,
    to: ride.to,
    rawDate: ride.date,
    date: dateLabel(ride.date),
    time: ride.time,
    seats: seatsLeft,
    totalSeats: totalSeats,
    price: ride.price,
    note: ride.note,
    owner: owner && owner.name || ride.ownerName || '同学',
    ownerAvatar: ownerAvatar || '',
    ownerPhone: includeOwnerPhone && owner && validPhone(owner.phone) ? String(owner.phone) : '',
    schoolId: ride.schoolId || '',
    schoolName: ride.schoolName || '',
    schoolProvince: ride.schoolProvince || '',
    schoolCity: ride.schoolCity || '',
    memberCount: safeMemberCount,
    joined: Boolean(joined),
    canManage: isOwner,
    started: started,
    settlementDue: settlementDue,
    canJoin: canJoin,
    canLeave: canLeave,
    seatsLabel: seatsLabel,
    statusTone: statusTone,
    action: action,
    actionText: actionText,
    status: status,
    statusLabel: statusLabel(status),
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt
  }
}

async function removeDocuments(collectionName, where) {
  let removed = 0
  while (true) {
    const result = await db.collection(collectionName).where(where).limit(100).get()
    if (!result.data.length) {
      return removed
    }
    await Promise.all(result.data.map(function (item) {
      return db.collection(collectionName).doc(item._id).remove()
    }))
    removed += result.data.length
  }
}

async function cleanupRideGroup(rideId) {
  const conversationId = domain.conversationIdForRide(rideId)
  await Promise.all([
    removeDocuments('messages', { conversationId: conversationId }),
    removeDocuments('conversation_reads', { conversationId: conversationId }),
    removeDocuments('chat_events', { conversationId: conversationId }).catch(function (error) {
      console.warn('[rides] realtime event cleanup skipped:', error.errCode || error.message)
    }),
    removeDocuments('buddy_requests', { rideId: rideId, source: 'ride_group' }),
    removeDocuments('ride_members', { rideId: rideId }),
    removeDocuments('conversations', { _id: conversationId })
  ])
}

async function expireStaleRides() {
  const graceDate = domain.cstDateString(Date.now() - domain.SETTLEMENT_GRACE_MS)
  let expired = 0
  for (let round = 0; round < 5; round += 1) {
    const result = await db.collection('rides').where({
      status: 'active',
      date: db.command.lt(graceDate)
    }).limit(100).get()
    if (!result.data.length) {
      break
    }
    await Promise.all(result.data.map(async function (ride) {
      await db.collection('rides').doc(ride._id).update({
        data: {
          status: 'expired',
          externalTrip: null,
          expiredAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      await cleanupRideGroup(ride._id)
    }))
    expired += result.data.length
  }
  return expired
}

async function backfillSeatsLeft(schoolId) {
  const _ = db.command
  const today = domain.cstDateString()
  let updated = 0
  for (let round = 0; round < 5; round += 1) {
    const result = await db.collection('rides').where({
      status: 'active',
      schoolId: schoolId,
      date: _.gte(today),
      seatsLeft: _.exists(false)
    }).limit(100).get()
    if (!result.data.length) {
      break
    }
    await Promise.all(result.data.map(function (ride) {
      const memberCount = Math.max(1, Number(ride.memberCount || 1))
      return db.collection('rides').doc(ride._id).update({
        data: {
          seatsLeft: Math.max(0, Number(ride.seats || 1) - (memberCount - 1))
        }
      })
    }))
    updated += result.data.length
  }
  return updated
}

async function resolveOwnerAvatarUrls(owners) {
  const fileIds = []
  Object.keys(owners).forEach(function (key) {
    const avatar = String(owners[key].avatar || '')
    if (avatar.indexOf('cloud://') === 0 && fileIds.indexOf(avatar) === -1) {
      fileIds.push(avatar)
    }
  })
  if (!fileIds.length) {
    return {}
  }
  try {
    const result = await cloud.getTempFileURL({ fileList: fileIds })
    const urls = {}
    ;(result.fileList || []).forEach(function (file) {
      if (file && Number(file.status || 0) === 0 && file.fileID && file.tempFileURL) {
        urls[file.fileID] = file.tempFileURL
      }
    })
    return urls
  } catch (error) {
    console.warn('[rides] owner avatar temporary URL failed:', error.errCode || error.message)
    return {}
  }
}

async function enrichRides(rides, openid, includeOwnerPhone) {
  if (!rides.length) {
    return []
  }
  const _ = db.command
  const rideIds = rides.map(function (ride) { return ride._id })
  const ownerOpenids = rides.map(function (ride) { return ride.ownerOpenid }).filter(Boolean)
  const results = await Promise.all([
    ownerOpenids.length
      ? db.collection('users').where({ openid: _.in(ownerOpenids) }).limit(30).get()
      : Promise.resolve({ data: [] }),
    db.collection('ride_members').where({ rideId: _.in(rideIds) }).limit(100).get()
  ])
  const owners = {}
  results[0].data.forEach(function (user) { owners[user.openid] = user })
  const avatarUrls = await resolveOwnerAvatarUrls(owners)
  const membersByRide = {}
  const seenMemberships = {}
  results[1].data.forEach(function (membership) {
    const key = membership.rideId + ':' + membership.userOpenid
    if (seenMemberships[key]) {
      return
    }
    seenMemberships[key] = true
    membersByRide[membership.rideId] = membersByRide[membership.rideId] || []
    membersByRide[membership.rideId].push(membership)
  })
  return rides.map(function (ride) {
    const members = membersByRide[ride._id] || []
    const joined = members.some(function (item) { return item.userOpenid === openid })
    const owner = owners[ride.ownerOpenid]
    const ownerAvatar = owner && avatarUrls[owner.avatar] ? avatarUrls[owner.avatar] : ''
    return publicRide(ride, owner, members.length || ride.memberCount || 1, joined, openid, includeOwnerPhone, ownerAvatar)
  })
}

async function listOpenGroupsForUser(openid, school, paging) {
  const batchSize = 50
  const maxMemberships = 1000
  let rawOffset = 0
  let skipped = 0
  const rides = []
  let hasMore = false

  while (rawOffset < maxMemberships) {
    const result = await db.collection('ride_members')
      .where({ userOpenid: openid, schoolId: school.schoolId })
      .orderBy('joinedAt', 'desc')
      .skip(rawOffset)
      .limit(batchSize)
      .get()
    if (!result.data.length) {
      break
    }
    rawOffset += result.data.length
    const rideIds = result.data.map(function (membership) { return membership.rideId })
    const rideResult = await db.collection('rides').where({
      _id: db.command.in(rideIds)
    }).limit(batchSize).get()
    const ridesById = {}
    rideResult.data.forEach(function (ride) { ridesById[ride._id] = ride })
    for (let i = 0; i < result.data.length; i += 1) {
      const ride = ridesById[result.data[i].rideId]
      if (!ride || ride.schoolId !== school.schoolId) {
        continue
      }
      const isOpen = ride.status === 'settling' ||
        (ride.status === 'active' && !domain.isRideExpired(ride))
      if (!isOpen) {
        continue
      }
      if (skipped < paging.skip) {
        skipped += 1
        continue
      }
      if (rides.length < paging.limit + 1) {
        rides.push(ride)
      }
    }
    if (rides.length >= paging.limit + 1) {
      hasMore = true
      break
    }
    if (result.data.length < batchSize) {
      break
    }
  }

  return {
    rides: rides.slice(0, paging.limit),
    hasMore: hasMore
  }
}

async function prepareSettlementRecord(rideId, totalFen, participantUserIds) {
  const selectedIds = Array.isArray(participantUserIds)
    ? participantUserIds.map(function (id) { return domain.cleanText(id, 128) }).filter(Boolean)
    : []
  const uniqueIds = selectedIds.filter(function (id, index) { return selectedIds.indexOf(id) === index })
  if (!uniqueIds.length) {
    throw new Error('请至少选择一位实际乘车人')
  }

  const members = await getMembers(rideId)
  const membershipByOpenid = {}
  members.forEach(function (membership) { membershipByOpenid[membership.userOpenid] = membership })
  const participants = []
  for (let i = 0; i < uniqueIds.length; i += 1) {
    let memberUser = null
    try {
      const result = await db.collection('users').doc(uniqueIds[i]).get()
      memberUser = result.data
    } catch (error) {
      memberUser = null
    }
    if (!memberUser || !membershipByOpenid[memberUser.openid]) {
      throw new Error('结算成员必须是当前拼车团成员')
    }
    const membership = membershipByOpenid[memberUser.openid]
    participants.push({
      openid: memberUser.openid,
      userId: memberUser._id,
      name: memberUser.name || '同学',
      role: membership.role === 'owner' ? 'owner' : 'member'
    })
  }

  const shares = settlementLogic.buildShares(totalFen, participants)
  return {
    totalFen: totalFen,
    riderCount: shares.length,
    perPersonFen: Math.floor(totalFen / shares.length),
    participants: shares
  }
}

async function syncGroupConversation(rideId) {
  const conversationId = domain.conversationIdForRide(rideId)
  const members = await getMembers(rideId)
  try {
    const existing = await db.collection('conversations').doc(conversationId).get()
    if (existing.data) {
      await db.collection('conversations').doc(conversationId).update({
        data: {
          memberOpenids: members.map(function (item) { return item.userOpenid }),
          updatedAt: db.serverDate()
        }
      })
    }
  } catch (error) {
    // 群会话按需创建；尚未创建时无需处理。
  }
}

async function updateRideStatus(rideId, openid, status) {
  const ride = await getRide(rideId)
  if (!ride || ride.ownerOpenid !== openid) {
    return { ok: false, message: '只有行程发布者可以执行该操作' }
  }
  if (ride.status === 'settling') {
    return { ok: false, message: '结算中的行程不能取消或解散' }
  }
  if (ride.status !== 'active') {
    await cleanupRideGroup(rideId)
    return { ok: true, status: ride.status, statusLabel: statusLabel(ride.status), alreadyClosed: true }
  }
  await db.collection('rides').doc(rideId).update({
    data: {
      status: status,
      externalTrip: null,
      closedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  await cleanupRideGroup(rideId)
  return { ok: true, status: status, statusLabel: statusLabel(status) }
}

async function removeMembership(ride, targetOpenid) {
  const memberships = await db.collection('ride_members').where({
    rideId: ride._id,
    userOpenid: targetOpenid
  }).limit(10).get()
  if (!memberships.data.length) {
    return false
  }
  const membershipIds = memberships.data.map(function (item) { return item._id })
  const result = await db.runTransaction(async function (transaction) {
    const rideResult = await transaction.collection('rides').doc(ride._id).get()
    const storedRide = rideResult.data
    if (!storedRide) {
      throw new Error('行程不存在')
    }
    let removedCount = 0
    for (let i = 0; i < membershipIds.length; i += 1) {
      let current = null
      try {
        current = await transaction.collection('ride_members').doc(membershipIds[i]).get()
      } catch (error) {
        current = null
      }
      if (current && current.data) {
        await transaction.collection('ride_members').doc(membershipIds[i]).remove()
        removedCount += 1
      }
    }
    if (!removedCount) {
      return { removed: 0 }
    }
    const nextMemberCount = Math.max(1, Number(storedRide.memberCount || 1) - removedCount)
    await transaction.collection('rides').doc(ride._id).update({
      data: {
        memberCount: nextMemberCount,
        seatsLeft: Math.max(0, Number(storedRide.seats || 1) - (nextMemberCount - 1)),
        updatedAt: db.serverDate()
      }
    })
    return { removed: removedCount }
  })
  if (!result || !result.removed) {
    return false
  }
  await syncGroupConversation(ride._id)
  await removeDocuments('chat_events', {
    conversationId: domain.conversationIdForRide(ride._id),
    ownerOpenid: targetOpenid
  }).catch(function (error) {
    console.warn('[rides] member realtime event cleanup skipped:', error.errCode || error.message)
  })
  return true
}

async function main(event) {
  const openid = cloud.getWXContext().OPENID
  const action = event.action
  const resolveAvatar = avatarUrl.createResolver(cloud, 'rides')

  // 定时触发器没有客户端 action；只执行过期清理，不进入任何用户写操作。
  if (!action) {
    return { ok: true, expiredCount: await expireStaleRides() }
  }

  const currentUser = await getUserByOpenid(openid)

  if (!currentUser) {
    return { ok: false, message: '请先重新进入小程序完成微信登录' }
  }

  if (action === 'publish') {
    const phoneError = requirePhone(currentUser)
    if (phoneError) {
      return phoneError
    }
    if (!currentUser.paymentCode) {
      return {
        ok: false,
        code: 'PAYMENT_CODE_REQUIRED',
        message: '发布行程前请先在“我的”页面上传收款码'
      }
    }
    if (!String(currentUser.name || '').trim()) {
      return {
        ok: false,
        code: 'PROFILE_NAME_REQUIRED',
        message: '发布行程前请先在“我的”页面填写姓名或昵称'
      }
    }
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    const activeCount = await db.collection('rides').where({
      ownerOpenid: openid,
      status: 'active'
    }).count()
    if (activeCount.total >= 3) {
      return { ok: false, code: 'RIDE_LIMIT', message: '最多同时发布 3 条进行中的行程' }
    }
    const rideInput = Object.assign({}, event.ride || {}, { owner: currentUser.name })
    if (rideInput.direction === '出校') {
      rideInput.from = school.schoolName
    } else if (rideInput.direction === '返校') {
      rideInput.to = school.schoolName
    }
    let ride
    try {
      ride = domain.validateRide(rideInput)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    ride.ownerName = currentUser.name
    const rideId = 'ride_' + crypto.randomBytes(16).toString('hex')
    const storedRide = Object.assign({ _id: rideId }, ride, school, {
      ownerOpenid: openid,
      status: 'active',
      memberCount: 1,
      seatsLeft: ride.seats
    })
    await db.runTransaction(async function (transaction) {
      await transaction.collection('rides').doc(rideId).set({
        data: Object.assign({}, ride, school, {
          ownerOpenid: openid,
          status: 'active',
          memberCount: 1,
          seatsLeft: ride.seats,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        })
      })
      await transaction.collection('ride_members').doc(domain.membershipId(rideId, openid)).set({
        data: {
          rideId: rideId,
          schoolId: school.schoolId,
          userOpenid: openid,
          role: 'owner',
          joinedAt: db.serverDate()
        }
      })
    })
    return { ok: true, ride: publicRide(storedRide, currentUser, 1, true, openid) }
  }

  if (action === 'list') {
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    await expireStaleRides()
    const paging = domain.pageOptions(event, 10)
    const now = new Date()
    const today = domain.cstDateString(now)
    const currentTime = domain.cstTimeString(now)
    const joinableOnly = event.scope === 'joinable'
    const upcomingOnly = event.scope === 'upcoming'
    if (joinableOnly || event.withTotal) {
      try {
        await backfillSeatsLeft(school.schoolId)
      } catch (error) {
        console.warn('[rides] seatsLeft backfill skipped:', error.errCode || error.message)
      }
    }
    const joinableWhere = db.command.or([
      { status: 'active', schoolId: school.schoolId, seatsLeft: db.command.gt(0), date: db.command.gt(today) },
      { status: 'active', schoolId: school.schoolId, seatsLeft: db.command.gt(0), date: today, time: db.command.gt(currentTime) }
    ])
    let where
    if (joinableOnly) {
      where = joinableWhere
    } else if (upcomingOnly) {
      where = db.command.or([
        { status: 'active', schoolId: school.schoolId, date: db.command.gt(today) },
        { status: 'active', schoolId: school.schoolId, date: today, time: db.command.gt(currentTime) }
      ])
    } else {
      where = { status: 'active', schoolId: school.schoolId, date: db.command.gte(today) }
    }
    const result = await db.collection('rides')
      .where(where)
      .orderBy('date', 'asc')
      .orderBy('time', 'asc')
      .skip(paging.skip)
      .limit(paging.limit + 1)
      .get()
    const hasMore = result.data.length > paging.limit
    const pageRows = hasMore ? result.data.slice(0, paging.limit) : result.data
    const response = {
      ok: true,
      rides: await enrichRides(pageRows, openid),
      pagination: { page: paging.page, limit: paging.limit, hasMore: hasMore }
    }
    if (event.withTotal) {
      const countResult = await db.collection('rides').where(joinableWhere).count()
      response.total = countResult.total
    }
    return response
  }

  if (action === 'locationOptions') {
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    await expireStaleRides()
    const today = domain.cstDateString()
    const result = await db.collection('rides')
      .where({ status: 'active', schoolId: school.schoolId, date: db.command.gte(today) })
      .orderBy('date', 'asc')
      .orderBy('time', 'asc')
      .limit(200)
      .get()
    const countsFrom = {}
    const countsTo = {}
    result.data.forEach(function (ride) {
      const from = String(ride.from || '').trim()
      const to = String(ride.to || '').trim()
      if (from) {
        countsFrom[from] = (countsFrom[from] || 0) + 1
      }
      if (to) {
        countsTo[to] = (countsTo[to] || 0) + 1
      }
    })
    function sortedLocations(counts) {
      return Object.keys(counts).sort(function (first, second) {
        return counts[second] - counts[first] ||
          first.length - second.length ||
          first.localeCompare(second)
      }).slice(0, 40)
    }
    return {
      ok: true,
      from: sortedLocations(countsFrom),
      to: sortedLocations(countsTo)
    }
  }

  if (action === 'join') {
    const phoneError = requirePhone(currentUser)
    if (phoneError) {
      return phoneError
    }
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.status !== 'active' || domain.isRideExpired(ride)) {
      return { ok: false, message: '该拼车团不存在或已结束' }
    }
    if (domain.hasStarted(ride)) {
      return { ok: false, code: 'RIDE_STARTED', message: '行程已发车，不能再加入' }
    }
    if (ride.schoolId !== school.schoolId) {
      return { ok: false, code: 'SCHOOL_MISMATCH', message: '该拼车团属于其他学校' }
    }
    const existing = await db.collection('ride_members').where({
      rideId: rideId,
      userOpenid: openid
    }).limit(1).get()
    if (existing.data.length) {
      return { ok: true, joined: true }
    }
    const baselineMembers = await getMembers(rideId)
    let alreadyJoined = false
    try {
      await db.runTransaction(async function (transaction) {
        const rideResult = await transaction.collection('rides').doc(rideId).get()
        const storedRide = rideResult.data
        if (!storedRide || storedRide.status !== 'active') {
          throw new Error('该行程已结束')
        }
        if (domain.hasStarted(storedRide)) {
          throw new Error('行程已发车，不能再加入')
        }
        const membershipId = domain.membershipId(rideId, openid)
        let membership = null
        try {
          membership = await transaction.collection('ride_members').doc(membershipId).get()
        } catch (error) {
          membership = null
        }
        if (membership && membership.data) {
          alreadyJoined = true
          return
        }
        const memberCount = Number(storedRide.memberCount || baselineMembers.length || 1)
        const totalSeats = Number(storedRide.seats || 1)
        if (memberCount - 1 >= totalSeats) {
          throw new Error('该行程座位已满')
        }
        const nextMemberCount = memberCount + 1
        await transaction.collection('ride_members').doc(membershipId).set({
          data: {
            rideId: rideId,
            schoolId: school.schoolId,
            userOpenid: openid,
            role: 'member',
            joinedAt: db.serverDate()
          }
        })
        await transaction.collection('rides').doc(rideId).update({
          data: {
            memberCount: nextMemberCount,
            seatsLeft: Math.max(0, totalSeats - (nextMemberCount - 1)),
            updatedAt: db.serverDate()
          }
        })
      })
    } catch (error) {
      return { ok: false, message: error.message || '加入拼车团失败' }
    }
    if (alreadyJoined) {
      return { ok: true, joined: true }
    }
    await syncGroupConversation(rideId)
    await notifyOwnerRideJoined(ride, currentUser, openid)
    return { ok: true, joined: true }
  }

  if (action === 'update') {
    if (!String(currentUser.name || '').trim()) {
      return {
        ok: false,
        code: 'PROFILE_NAME_REQUIRED',
        message: '编辑行程前请先在“我的”页面填写姓名或昵称'
      }
    }
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    const rideId = domain.cleanText(event.rideId, 128)
    const existingRide = await getRide(rideId)
    if (!existingRide || existingRide.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以编辑行程' }
    }
    if (existingRide.status !== 'active') {
      return { ok: false, message: '已结束的行程不能编辑' }
    }
    if (domain.hasStarted(existingRide)) {
      return { ok: false, code: 'RIDE_STARTED', message: '行程已发车，不能再修改' }
    }
    const rideInput = Object.assign({}, event.ride || {}, { owner: currentUser.name })
    if (rideInput.direction === '出校') {
      rideInput.from = school.schoolName
    } else if (rideInput.direction === '返校') {
      rideInput.to = school.schoolName
    }
    let nextRide
    try {
      nextRide = domain.validateRide(rideInput)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    nextRide.ownerName = currentUser.name
    const members = await getMembers(rideId)
    if (nextRide.seats < Math.max(1, members.length - 1)) {
      return { ok: false, message: '座位数不能少于当前已加入的乘客数' }
    }
    const memberCount = Math.max(1, members.length)
    await db.collection('rides').doc(rideId).update({
      data: Object.assign({}, nextRide, {
        memberCount: memberCount,
        seatsLeft: Math.max(0, Number(nextRide.seats || 1) - (memberCount - 1)),
        updatedAt: db.serverDate()
      })
    })
    const updated = Object.assign({}, existingRide, nextRide, {
      memberCount: memberCount,
      seatsLeft: Math.max(0, Number(nextRide.seats || 1) - (memberCount - 1))
    })
    return { ok: true, ride: publicRide(updated, currentUser, members.length, true, openid) }
  }

  if (action === 'end') {
    return { ok: false, message: '请使用“结束并结算”完成车费分摊' }
  }

  if (action === 'cancel' || action === 'disband') {
    const status = action === 'cancel' ? 'cancelled' : 'disbanded'
    return updateRideStatus(domain.cleanText(event.rideId, 128), openid, status)
  }

  if (action === 'leave') {
    const ride = await getRide(domain.cleanText(event.rideId, 128))
    if (!ride) {
      return { ok: false, message: '拼车团不存在' }
    }
    if (ride.status !== 'active') {
      return { ok: false, message: '行程已结束，不能退出拼车团' }
    }
    if (ride.ownerOpenid === openid) {
      return { ok: false, message: '发布者不能退出，请结束或取消拼车团' }
    }
    if (domain.hasStarted(ride)) {
      return { ok: false, code: 'RIDE_STARTED', message: '行程已发车，不能退出拼车团' }
    }
    const removed = await removeMembership(ride, openid)
    return removed ? { ok: true } : { ok: false, message: '你不在该拼车团中' }
  }

  if (action === 'removeMember') {
    const ride = await getRide(domain.cleanText(event.rideId, 128))
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以移除成员' }
    }
    if (ride.status !== 'active') {
      return { ok: false, message: '已结束的拼车团不能移除成员' }
    }
    if (domain.hasStarted(ride)) {
      return { ok: false, code: 'RIDE_STARTED', message: '行程已发车，不能移除成员' }
    }
    let targetUser = null
    try {
      const result = await db.collection('users').doc(domain.cleanText(event.targetUserId, 128)).get()
      targetUser = result.data
    } catch (error) {
      targetUser = null
    }
    if (!targetUser || targetUser.openid === openid) {
      return { ok: false, message: '不能移除该成员' }
    }
    const removed = await removeMembership(ride, targetUser.openid)
    return removed ? { ok: true } : { ok: false, message: '该成员已不在团内' }
  }

  if (action === 'saveExternalTrip') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以同步网约车行程链接' }
    }
    if (ride.status !== 'active') {
      return { ok: false, message: '已结束的行程不能同步网约车链接' }
    }
    if (domain.isRideExpired(ride)) {
      return { ok: false, message: '行程已过期，不能同步网约车链接' }
    }
    let externalTrip
    try {
      externalTrip = domain.validateExternalTripUrl(event.url)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    await db.collection('rides').doc(rideId).update({
      data: {
        externalTrip: db.command.set(externalTrip),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, externalTrip: publicExternalTrip(externalTrip) }
  }

  if (action === 'removeExternalTrip') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以删除网约车行程链接' }
    }
    await db.collection('rides').doc(rideId).update({
      data: {
        externalTrip: null,
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, externalTrip: null }
  }

  if (action === 'createSettlement') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以发起结算' }
    }
    if (ride.status !== 'active') {
      return { ok: false, message: '当前行程不能发起结算' }
    }
    if (domain.isRideExpired(ride)) {
      return { ok: false, message: '行程已过期，不能发起结算' }
    }
    if (!currentUser.paymentCode) {
      return {
        ok: false,
        code: 'PAYMENT_CODE_REQUIRED',
        message: '发起结算前请先在“我的”页面上传收款码'
      }
    }

    let totalFen
    try {
      totalFen = settlementLogic.parseAmountToFen(event.totalAmount)
    } catch (error) {
      return { ok: false, message: error.message }
    }

    let record
    try {
      record = await prepareSettlementRecord(rideId, totalFen, event.participantUserIds)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    record.createdAt = new Date()
    const transactionResult = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const storedRide = rideResult.data
      if (!storedRide || storedRide.ownerOpenid !== openid) {
        return { ok: false, message: '只有发布者可以发起结算' }
      }
      if (storedRide.status !== 'active') {
        return { ok: false, message: '当前行程不能发起结算' }
      }
      if (domain.isRideExpired(storedRide)) {
        return { ok: false, message: '行程已过期，不能发起结算' }
      }
      await transaction.collection('rides').doc(rideId).update({
        data: {
          status: 'settling',
          settlement: db.command.set(record),
          settlingAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    if (!transactionResult.ok) {
      return transactionResult
    }
    return {
      ok: true,
      settlement: publicSettlement(
        record,
        openid,
        true,
        currentUser.name || '发布者',
        await resolveAvatar(currentUser.paymentCode)
      )
    }
  }

  if (action === 'updateSettlement') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以修改结算' }
    }
    if (ride.status !== 'settling' || !ride.settlement) {
      return { ok: false, message: '当前没有待结算的行程' }
    }
    const locked = (ride.settlement.participants || []).some(function (participant) {
      return participant.status === 'claimed' || participant.status === 'confirmed'
    })
    if (locked) {
      return { ok: false, message: '已有同行人标记转账或确认，不能修改；请先撤销结算' }
    }
    let totalFen
    try {
      totalFen = settlementLogic.parseAmountToFen(event.totalAmount)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    let record
    try {
      record = await prepareSettlementRecord(rideId, totalFen, event.participantUserIds)
    } catch (error) {
      return { ok: false, message: error.message }
    }
    record.createdAt = ride.settlement.createdAt || new Date()
    record.updatedAt = new Date()
    const transactionResult = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const storedRide = rideResult.data
      if (!storedRide || storedRide.ownerOpenid !== openid) {
        return { ok: false, message: '只有发布者可以修改结算' }
      }
      if (storedRide.status !== 'settling' || !storedRide.settlement) {
        return { ok: false, message: '当前没有待结算的行程' }
      }
      const stillLocked = (storedRide.settlement.participants || []).some(function (participant) {
        return participant.status === 'claimed' || participant.status === 'confirmed'
      })
      if (stillLocked) {
        return { ok: false, message: '已有同行人标记转账或确认，不能修改；请先撤销结算' }
      }
      await transaction.collection('rides').doc(rideId).update({
        data: {
          settlement: db.command.set(record),
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    if (!transactionResult.ok) {
      return transactionResult
    }
    return {
      ok: true,
      settlement: publicSettlement(
        record,
        openid,
        true,
        currentUser.name || '发布者',
        await resolveAvatar(currentUser.paymentCode)
      )
    }
  }

  if (action === 'withdrawSettlement') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.ownerOpenid !== openid) {
      return { ok: false, message: '只有发布者可以撤销结算' }
    }
    if (ride.status !== 'settling' || !ride.settlement) {
      return { ok: false, message: '当前没有待结算的行程' }
    }
    const confirmed = (ride.settlement.participants || []).some(function (participant) {
      return participant.status === 'confirmed'
    })
    if (confirmed) {
      return { ok: false, message: '已有同行人确认收款，不能撤销结算' }
    }
    const transactionResult = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const storedRide = rideResult.data
      if (!storedRide || storedRide.ownerOpenid !== openid) {
        return { ok: false, message: '只有发布者可以撤销结算' }
      }
      if (storedRide.status !== 'settling' || !storedRide.settlement) {
        return { ok: false, message: '当前没有待结算的行程' }
      }
      const stillConfirmed = (storedRide.settlement.participants || []).some(function (participant) {
        return participant.status === 'confirmed'
      })
      if (stillConfirmed) {
        return { ok: false, message: '已有同行人确认收款，不能撤销结算' }
      }
      await transaction.collection('rides').doc(rideId).update({
        data: {
          status: 'active',
          settlement: null,
          settlingAt: null,
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    return transactionResult
  }

  if (action === 'markSettlementPaid') {
    const rideId = domain.cleanText(event.rideId, 128)
    const result = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const ride = rideResult.data
      if (!ride || ride.status !== 'settling' || !ride.settlement) {
        return { ok: false, message: '当前没有待结算的行程' }
      }
      const participants = ride.settlement.participants || []
      const mine = participants.find(function (participant) { return participant.openid === openid })
      if (!mine || mine.role === 'owner') {
        return { ok: false, message: '你不在本次结算的付款名单中' }
      }
      if (mine.status === 'confirmed') {
        return { ok: true, alreadyConfirmed: true }
      }
      mine.status = 'claimed'
      mine.claimedAt = new Date()
      await transaction.collection('rides').doc(rideId).update({
        data: {
          settlement: db.command.set(ride.settlement),
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    return result
  }

  if (action === 'confirmSettlementPayment') {
    const rideId = domain.cleanText(event.rideId, 128)
    const targetUserId = domain.cleanText(event.targetUserId, 128)
    const result = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const ride = rideResult.data
      if (!ride || ride.ownerOpenid !== openid) {
        return { ok: false, message: '只有发布者可以确认收款' }
      }
      if (ride.status !== 'settling' || !ride.settlement) {
        return { ok: false, message: '当前没有待结算的行程' }
      }
      const target = (ride.settlement.participants || []).find(function (participant) {
        return participant.userId === targetUserId && participant.role !== 'owner'
      })
      if (!target) {
        return { ok: false, message: '结算成员不存在' }
      }
      if (target.status === 'confirmed') {
        return { ok: true, alreadyConfirmed: true }
      }
      target.status = 'confirmed'
      target.confirmedAt = new Date()
      await transaction.collection('rides').doc(rideId).update({
        data: {
          settlement: db.command.set(ride.settlement),
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    return result
  }

  if (action === 'completeSettlement') {
    const rideId = domain.cleanText(event.rideId, 128)
    const result = await db.runTransaction(async function (transaction) {
      const rideResult = await transaction.collection('rides').doc(rideId).get()
      const ride = rideResult.data
      if (!ride || ride.ownerOpenid !== openid) {
        return { ok: false, message: '只有发布者可以完成结算' }
      }
      if (ride.status !== 'settling' || !ride.settlement) {
        return { ok: false, message: '当前没有待结算的行程' }
      }
      if (!settlementLogic.allConfirmed(ride.settlement)) {
        return { ok: false, message: '还有同行人未确认收款，暂不能完成结算' }
      }
      await transaction.collection('rides').doc(rideId).update({
        data: {
          status: 'settled',
          settlement: db.command.set(ride.settlement),
          settledAt: db.serverDate(),
          closedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      return { ok: true }
    })
    if (result.ok) {
      await cleanupRideGroup(rideId)
    }
    return result
  }

  if (action === 'getGroup') {
    const rideId = domain.cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride) {
      return { ok: false, message: '拼车团不存在' }
    }
    if (ride.schoolId !== currentUser.schoolId) {
      return { ok: false, code: 'SCHOOL_MISMATCH', message: '该拼车团属于其他学校' }
    }
    if (ride.status === 'active' && domain.isRideExpired(ride)) {
      await db.collection('rides').doc(rideId).update({
        data: {
          status: 'expired',
          externalTrip: null,
          expiredAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      ride.status = 'expired'
      ride.externalTrip = null
    }
    if (['ended', 'cancelled', 'disbanded', 'expired', 'settled'].indexOf(ride.status) !== -1) {
      await cleanupRideGroup(rideId)
    }
    const memberships = await getMembers(rideId)
    const membership = memberships.find(function (item) { return item.userOpenid === openid })
    const owner = await getUserByOpenid(ride.ownerOpenid)
    const members = []
    if (membership && memberships.length) {
      const usersResult = await db.collection('users').where({
        openid: db.command.in(memberships.map(function (item) { return item.userOpenid }))
      }).limit(30).get()
      const usersByOpenid = {}
      usersResult.data.forEach(function (user) { usersByOpenid[user.openid] = user })
      for (let i = 0; i < memberships.length; i += 1) {
        const item = memberships[i]
        const user = usersByOpenid[item.userOpenid]
        if (user) {
          members.push({
            membershipId: item._id,
            role: item.role,
            isSelf: item.userOpenid === openid,
            user: await publicUser(user, resolveAvatar)
          })
        }
      }
    }
    const canViewExternalTrip = Boolean(membership) || ride.ownerOpenid === openid
    const isOwner = ride.ownerOpenid === openid
    const settlement = ride.status === 'settling' && ride.settlement
      ? publicSettlement(
        ride.settlement,
        openid,
        isOwner,
        owner && owner.name || '发布者',
        await resolveAvatar(owner && owner.paymentCode)
      )
      : null
    return {
      ok: true,
      joined: Boolean(membership),
      isOwner: isOwner,
      myRole: membership && membership.role || '',
      ride: publicRide(ride, owner, memberships.length, Boolean(membership), openid),
      externalTrip: canViewExternalTrip && (ride.status || 'active') === 'active'
        ? publicExternalTrip(ride.externalTrip)
        : null,
      settlement: settlement,
      members: members
    }
  }

  if (action === 'listMyGroups') {
    const schoolError = requireSchool(currentUser)
    if (schoolError) {
      return schoolError
    }
    const school = schoolFromUser(currentUser)
    const paging = domain.pageOptions(event, 10)
    const pageResult = await listOpenGroupsForUser(openid, school, paging)
    return {
      ok: true,
      rides: await enrichRides(pageResult.rides, openid, true),
      pagination: { page: paging.page, limit: paging.limit, hasMore: pageResult.hasMore }
    }
  }

  if (action === 'cleanupExpired') {
    return { ok: true, expiredCount: await expireStaleRides() }
  }

  return { ok: false, message: '不支持的行程操作' }
}

module.exports = { main: main }
