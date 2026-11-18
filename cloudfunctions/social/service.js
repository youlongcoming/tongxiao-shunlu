const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const avatarUrl = require('./avatar-url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function stableId(prefix, values) {
  return prefix + crypto.createHash('sha256').update(values.join(':')).digest('hex').slice(0, 40)
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

async function publicUser(user, resolveAvatar) {
  return user ? {
    userId: user._id,
    friendCode: user.friendCode || '',
    name: user.name || '未命名同学',
    avatar: await resolveAvatar(user.avatar),
    gender: user.gender || '不公开',
    grade: user.grade || '',
    major: user.major || '',
    bio: user.bio || ''
  } : null
}

function paging(event, defaultLimit) {
  const page = Math.max(1, Number(event.page) || 1)
  const limit = Math.max(1, Math.min(30, Number(event.limit) || defaultLimit || 10))
  return { page: page, limit: limit, skip: (page - 1) * limit }
}

async function getUserById(userId) {
  try {
    return (await db.collection('users').doc(userId).get()).data || null
  } catch (error) {
    return null
  }
}

async function getUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid: openid }).limit(1).get()
  return result.data[0] || null
}

async function getUserByFriendCode(friendCode) {
  const result = await db.collection('users').where({ friendCode: friendCode }).limit(1).get()
  return result.data[0] || null
}

async function buddyExists(userOpenid, buddyOpenid) {
  const result = await db.collection('buddies').where({
    userOpenid: userOpenid,
    buddyOpenid: buddyOpenid
  }).limit(1).get()
  return Boolean(result.data.length)
}

async function enrichRequests(requests, direction, resolveAvatar) {
  if (!requests.length) {
    return []
  }
  const relatedOpenids = requests.map(function (item) {
    return direction === 'incoming' ? item.fromOpenid : item.toOpenid
  })
  const usersResult = await db.collection('users').where({
    openid: db.command.in(relatedOpenids)
  }).limit(30).get()
  const users = {}
  usersResult.data.forEach(function (user) { users[user.openid] = user })
  const enriched = []
  for (let i = 0; i < requests.length; i += 1) {
    const request = requests[i]
    const relatedOpenid = direction === 'incoming' ? request.fromOpenid : request.toOpenid
    enriched.push({
      requestId: request._id,
      message: request.message || '',
      status: request.status,
      createdAt: request.createdAt,
      source: request.source || 'friend_code',
      user: await publicUser(users[relatedOpenid], resolveAvatar)
    })
  }
  return enriched
}

async function shareRideGroup(rideId, firstOpenid, secondOpenid) {
  let ride = null
  try {
    ride = (await db.collection('rides').doc(rideId).get()).data || null
  } catch (error) {
    ride = null
  }
  if (!ride || ride.status !== 'active') {
    return false
  }
  const result = await db.collection('ride_members').where({ rideId: rideId }).limit(30).get()
  const memberOpenids = result.data.map(function (item) { return item.userOpenid })
  return memberOpenids.indexOf(firstOpenid) !== -1 && memberOpenids.indexOf(secondOpenid) !== -1
}

async function removeBuddyPair(firstOpenid, secondOpenid) {
  const results = await Promise.all([
    db.collection('buddies').where({ userOpenid: firstOpenid, buddyOpenid: secondOpenid }).limit(10).get(),
    db.collection('buddies').where({ userOpenid: secondOpenid, buddyOpenid: firstOpenid }).limit(10).get()
  ])
  const relations = results[0].data.concat(results[1].data)
  if (!relations.length) {
    return false
  }
  await db.runTransaction(async function (transaction) {
    for (let i = 0; i < relations.length; i += 1) {
      await transaction.collection('buddies').doc(relations[i]._id).remove()
    }
  })
  const members = [firstOpenid, secondOpenid].sort()
  const conversationId = stableId('direct_', members)
  await Promise.all([
    removeDocuments('messages', { conversationId: conversationId }),
    removeDocuments('conversation_reads', { conversationId: conversationId }),
    removeDocuments('chat_events', { conversationId: conversationId }),
    removeDocuments('conversations', { _id: conversationId })
  ]).catch(function (error) {
    console.warn('[social] direct conversation cleanup failed:', error.errCode || error.message)
  })
  return true
}

async function createRequest(openid, targetUser, message, contextData, resolveAvatar) {
  if (!targetUser || targetUser.openid === openid) {
    return { ok: false, message: '不能向该用户发送搭子申请' }
  }
  if (await buddyExists(openid, targetUser.openid)) {
    return { ok: false, message: '对方已经是你的搭子' }
  }
  const pending = await db.collection('buddy_requests').where({
    fromOpenid: openid,
    toOpenid: targetUser.openid,
    status: 'pending'
  }).limit(1).get()
  if (pending.data.length) {
    return { ok: false, message: '已经发送过申请' }
  }
  const reverse = await db.collection('buddy_requests').where({
    fromOpenid: targetUser.openid,
    toOpenid: openid,
    status: 'pending'
  }).limit(1).get()
  if (reverse.data.length) {
    return { ok: false, message: '对方已向你发来申请，请直接处理' }
  }
  const created = await db.collection('buddy_requests').add({
    data: Object.assign({
      fromOpenid: openid,
      toOpenid: targetUser.openid,
      message: cleanText(message, 80),
      status: 'pending',
      source: 'friend_code',
      createdAt: db.serverDate()
    }, contextData || {})
  })
  return { ok: true, requestId: created._id, target: await publicUser(targetUser, resolveAvatar) }
}

async function main(event) {
  const openid = cloud.getWXContext().OPENID
  const action = event.action
  const resolveAvatar = avatarUrl.createResolver(cloud, 'social')
  const currentUser = await getUserByOpenid(openid)
  if (!currentUser) {
    return { ok: false, message: '请先重新进入小程序完成微信登录' }
  }

  if (action === 'sendRequest') {
    const friendCode = cleanText(event.friendCode, 20).toUpperCase()
    return createRequest(openid, await getUserByFriendCode(friendCode), event.message, null, resolveAvatar)
  }

  if (action === 'sendGroupRequest') {
    const rideId = cleanText(event.rideId, 128)
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser || !(await shareRideGroup(rideId, openid, targetUser.openid))) {
      return { ok: false, message: '只有同一拼车团成员之间可以发送申请' }
    }
    return createRequest(openid, targetUser, event.message, {
      source: 'ride_group',
      rideId: rideId
    }, resolveAvatar)
  }

  if (action === 'listRequests') {
    const options = paging(event, 10)
    const results = await Promise.all([
      db.collection('buddy_requests').where({ toOpenid: openid })
        .orderBy('createdAt', 'desc').skip(options.skip).limit(options.limit + 1).get(),
      db.collection('buddy_requests').where({ fromOpenid: openid })
        .orderBy('createdAt', 'desc').skip(options.skip).limit(options.limit + 1).get()
    ])
    return {
      ok: true,
      incoming: await enrichRequests(results[0].data.slice(0, options.limit), 'incoming', resolveAvatar),
      outgoing: await enrichRequests(results[1].data.slice(0, options.limit), 'outgoing', resolveAvatar),
      pagination: {
        page: options.page,
        limit: options.limit,
        hasMoreIncoming: results[0].data.length > options.limit,
        hasMoreOutgoing: results[1].data.length > options.limit
      }
    }
  }

  if (action === 'acceptRequest' || action === 'rejectRequest') {
    const requestId = cleanText(event.requestId, 128)
    let request
    try {
      request = (await db.collection('buddy_requests').doc(requestId).get()).data
    } catch (error) {
      request = null
    }
    if (!request || request.toOpenid !== openid || request.status !== 'pending') {
      return { ok: false, message: '搭子申请不存在或已处理' }
    }
    if (request.source === 'ride_group' &&
      !(await shareRideGroup(request.rideId, openid, request.fromOpenid))) {
      return { ok: false, message: '该拼车群已结束，申请已失效' }
    }
    const nextStatus = action === 'acceptRequest' ? 'accepted' : 'rejected'
    await db.runTransaction(async function (transaction) {
      const stored = (await transaction.collection('buddy_requests').doc(requestId).get()).data
      if (!stored || stored.status !== 'pending' || stored.toOpenid !== openid) {
        throw new Error('搭子申请已经被处理')
      }
      await transaction.collection('buddy_requests').doc(requestId).update({
        data: { status: nextStatus, handledAt: db.serverDate() }
      })
      if (nextStatus === 'accepted') {
        const firstId = stableId('buddy_', [openid, stored.fromOpenid])
        const secondId = stableId('buddy_', [stored.fromOpenid, openid])
        await transaction.collection('buddies').doc(firstId).set({
          data: { userOpenid: openid, buddyOpenid: stored.fromOpenid, note: '', createdAt: db.serverDate() }
        })
        await transaction.collection('buddies').doc(secondId).set({
          data: { userOpenid: stored.fromOpenid, buddyOpenid: openid, note: '', createdAt: db.serverDate() }
        })
      }
    })
    return { ok: true, status: nextStatus }
  }

  if (action === 'listBuddies') {
    const options = paging(event, 10)
    const result = await db.collection('buddies').where({ userOpenid: openid })
      .orderBy('createdAt', 'desc').skip(options.skip).limit(options.limit + 1).get()
    const rows = result.data.slice(0, options.limit)
    const uniqueRows = []
    const seen = {}
    rows.forEach(function (item) {
      if (!seen[item.buddyOpenid]) {
        seen[item.buddyOpenid] = true
        uniqueRows.push(item)
      }
    })
    const buddyOpenids = uniqueRows.map(function (item) { return item.buddyOpenid })
    const usersResult = buddyOpenids.length
      ? await db.collection('users').where({ openid: db.command.in(buddyOpenids) }).limit(30).get()
      : { data: [] }
    const users = {}
    usersResult.data.forEach(function (user) { users[user.openid] = user })
    const buddies = []
    for (let i = 0; i < uniqueRows.length; i += 1) {
      const item = uniqueRows[i]
      if (users[item.buddyOpenid]) {
        buddies.push({
          relationId: item._id,
          note: item.note || '',
          user: await publicUser(users[item.buddyOpenid], resolveAvatar)
        })
      }
    }
    return {
      ok: true,
      buddies: buddies,
      pagination: { page: options.page, limit: options.limit, hasMore: result.data.length > options.limit }
    }
  }

  if (action === 'saveNote') {
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser) {
      return { ok: false, message: '搭子用户不存在' }
    }
    const result = await db.collection('buddies').where({
      userOpenid: openid,
      buddyOpenid: targetUser.openid
    }).limit(1).get()
    if (!result.data.length) {
      return { ok: false, message: '搭子关系不存在' }
    }
    await db.collection('buddies').doc(result.data[0]._id).update({
      data: { note: cleanText(event.note, 30), updatedAt: db.serverDate() }
    })
    return { ok: true }
  }

  if (action === 'deleteBuddy') {
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser || targetUser.openid === openid) {
      return { ok: false, message: '搭子用户不存在' }
    }
    const removed = await removeBuddyPair(openid, targetUser.openid)
    return removed
      ? { ok: true }
      : { ok: false, message: '搭子关系已经不存在' }
  }

  return { ok: false, message: '不支持的好友操作' }
}

module.exports = { main: main }
