const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function publicUser(user) {
  return user ? {
    userId: user._id,
    friendCode: user.friendCode || '',
    name: user.name || '未命名同学',
    avatar: user.avatar || '',
    gender: user.gender || '不公开',
    grade: user.grade || '',
    major: user.major || '',
    bio: user.bio || ''
  } : null
}

async function getUserById(userId) {
  try {
    const result = await db.collection('users').doc(userId).get()
    return result.data || null
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
  const result = await db.collection('buddies').where({ userOpenid: userOpenid }).get()
  return result.data.some(function (item) {
    return item.buddyOpenid === buddyOpenid
  })
}

async function enrichRequests(requests, direction) {
  const enriched = []
  for (let i = 0; i < requests.length; i += 1) {
    const relatedOpenid = direction === 'incoming'
      ? requests[i].fromOpenid
      : requests[i].toOpenid
    const user = await getUserByOpenid(relatedOpenid)
    enriched.push({
      requestId: requests[i]._id,
      message: requests[i].message || '',
      status: requests[i].status,
      createdAt: requests[i].createdAt,
      user: publicUser(user)
    })
  }
  return enriched
}

async function shareRideGroup(rideId, firstOpenid, secondOpenid) {
  const result = await db.collection('ride_members').where({ rideId: rideId }).get()
  const memberOpenids = result.data.map(function (item) { return item.userOpenid })
  return memberOpenids.indexOf(firstOpenid) !== -1 && memberOpenids.indexOf(secondOpenid) !== -1
}

async function createRequest(openid, targetUser, message, contextData) {
  if (!targetUser || targetUser.openid === openid) {
    return { ok: false, message: '不能向该用户发送搭子申请' }
  }
  if (await buddyExists(openid, targetUser.openid)) {
    return { ok: false, message: '对方已经是你的搭子' }
  }

  const sentRequests = await db.collection('buddy_requests').where({ fromOpenid: openid }).get()
  const duplicate = sentRequests.data.some(function (item) {
    return item.toOpenid === targetUser.openid && item.status === 'pending'
  })
  if (duplicate) {
    return { ok: false, message: '已经发送过申请' }
  }
  const receivedRequests = await db.collection('buddy_requests').where({ fromOpenid: targetUser.openid }).get()
  const reversePending = receivedRequests.data.some(function (item) {
    return item.toOpenid === openid && item.status === 'pending'
  })
  if (reversePending) {
    return { ok: false, message: '对方已向你发来申请，请直接处理' }
  }

  const created = await db.collection('buddy_requests').add({
    data: Object.assign({
      fromOpenid: openid,
      toOpenid: targetUser.openid,
      message: cleanText(message, 80),
      status: 'pending',
      createdAt: db.serverDate()
    }, contextData || {})
  })
  return { ok: true, requestId: created._id, target: publicUser(targetUser) }
}

exports.main = async function (event) {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const action = event.action

  if (action === 'sendRequest') {
    const friendCode = cleanText(event.friendCode, 20).toUpperCase()
    const targetUser = await getUserByFriendCode(friendCode)
    if (!targetUser) {
      return { ok: false, message: '搭子码无效或不能添加自己' }
    }
    return createRequest(openid, targetUser, event.message)
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
    })
  }

  if (action === 'listRequests') {
    const incoming = await db.collection('buddy_requests').where({ toOpenid: openid }).get()
    const outgoing = await db.collection('buddy_requests').where({ fromOpenid: openid }).get()
    return {
      ok: true,
      incoming: await enrichRequests(incoming.data, 'incoming'),
      outgoing: await enrichRequests(outgoing.data, 'outgoing')
    }
  }

  if (action === 'acceptRequest' || action === 'rejectRequest') {
    const requestId = cleanText(event.requestId, 128)
    const requestResult = await db.collection('buddy_requests').doc(requestId).get()
    const request = requestResult.data
    if (!request || request.toOpenid !== openid || request.status !== 'pending') {
      return { ok: false, message: '好友申请不存在或已处理' }
    }

    const nextStatus = action === 'acceptRequest' ? 'accepted' : 'rejected'
    await db.collection('buddy_requests').doc(requestId).update({
      data: {
        status: nextStatus,
        handledAt: db.serverDate()
      }
    })

    if (nextStatus === 'accepted') {
      const pairs = [
        { userOpenid: openid, buddyOpenid: request.fromOpenid },
        { userOpenid: request.fromOpenid, buddyOpenid: openid }
      ]
      for (let i = 0; i < pairs.length; i += 1) {
        if (!(await buddyExists(pairs[i].userOpenid, pairs[i].buddyOpenid))) {
          await db.collection('buddies').add({
            data: Object.assign({}, pairs[i], {
              note: '',
              createdAt: db.serverDate()
            })
          })
        }
      }
    }

    return { ok: true, status: nextStatus }
  }

  if (action === 'listBuddies') {
    const result = await db.collection('buddies').where({ userOpenid: openid }).get()
    const buddies = []
    for (let i = 0; i < result.data.length; i += 1) {
      const user = await getUserByOpenid(result.data[i].buddyOpenid)
      if (user) {
        buddies.push({
          relationId: result.data[i]._id,
          note: result.data[i].note || '',
          user: publicUser(user)
        })
      }
    }
    return { ok: true, buddies: buddies }
  }

  if (action === 'saveNote') {
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser) {
      return { ok: false, message: '搭子用户不存在' }
    }
    const result = await db.collection('buddies').where({ userOpenid: openid }).get()
    const relation = result.data.find(function (item) {
      return item.buddyOpenid === targetUser.openid
    })
    if (!relation) {
      return { ok: false, message: '搭子关系不存在' }
    }
    await db.collection('buddies').doc(relation._id).update({
      data: {
        note: cleanText(event.note, 30),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true }
  }

  return { ok: false, message: '不支持的好友操作' }
}

// 新版社交服务增加资料门槛、分页与幂等关系写入，旧实现保留用于回滚。
module.exports = require('./service')

