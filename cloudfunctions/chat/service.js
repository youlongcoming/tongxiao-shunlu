const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const avatarUrl = require('./avatar-url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
// 订阅模板 ID 只从云函数环境变量读取；留空则关闭提醒。
const DEFAULT_CHAT_SUBSCRIBE_TEMPLATE_ID = ''
const MAX_SUBSCRIPTION_QUOTA = 5

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function configuredTemplateId() {
  return String(process.env.CHAT_SUBSCRIBE_TEMPLATE_ID || DEFAULT_CHAT_SUBSCRIBE_TEMPLATE_ID).trim()
}

function validPhone(value) {
  return /^1[3-9]\d{9}$/.test(String(value || ''))
}

function stableId(prefix, values) {
  return prefix + crypto.createHash('sha256').update(values.join(':')).digest('hex').slice(0, 40)
}

function pageOptions(event, defaultLimit) {
  const page = Math.max(1, Number(event.page) || 1)
  const limit = Math.max(1, Math.min(50, Number(event.limit) || defaultLimit || 20))
  return { page: page, limit: limit, skip: (page - 1) * limit }
}

async function publicUser(user, resolveAvatar) {
  return user ? {
    userId: user._id,
    name: user.name || '未命名同学',
    avatar: await resolveAvatar(user.avatar),
    grade: user.grade || '',
    major: user.major || ''
  } : null
}

function isMember(conversation, openid) {
  return Boolean(conversation && Array.isArray(conversation.memberOpenids) &&
    conversation.memberOpenids.indexOf(openid) !== -1)
}

async function getConversation(conversationId) {
  try {
    return (await db.collection('conversations').doc(conversationId).get()).data || null
  } catch (error) {
    return null
  }
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

async function getRide(rideId) {
  try {
    return (await db.collection('rides').doc(rideId).get()).data || null
  } catch (error) {
    return null
  }
}

async function rideMemberOpenids(rideId) {
  const result = await db.collection('ride_members').where({ rideId: rideId }).limit(30).get()
  const seen = {}
  return result.data.map(function (item) { return item.userOpenid }).filter(function (openid) {
    if (!openid || seen[openid]) {
      return false
    }
    seen[openid] = true
    return true
  })
}

async function areBuddies(first, second) {
  const result = await db.collection('buddies').where({ userOpenid: first, buddyOpenid: second }).limit(1).get()
  return Boolean(result.data.length)
}

async function readState(conversationId, openid) {
  const readId = stableId('read_', [conversationId, openid])
  try {
    return (await db.collection('conversation_reads').doc(readId).get()).data || null
  } catch (error) {
    return null
  }
}

async function markRead(conversationId, openid) {
  await db.collection('conversation_reads').doc(stableId('read_', [conversationId, openid])).set({
    data: {
      conversationId: conversationId,
      userOpenid: openid,
      lastReadAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
}

async function unreadCount(conversationId, openid) {
  const state = await readState(conversationId, openid)
  const where = {
    conversationId: conversationId,
    senderOpenid: db.command.neq(openid)
  }
  if (state && state.lastReadAt) {
    where.createdAt = db.command.gt(state.lastReadAt)
  }
  return (await db.collection('messages').where(where).count()).total
}

async function conversationForClient(conversation, openid, resolveAvatar) {
  const base = {
    conversationId: conversation._id,
    type: conversation.type,
    lastMessage: conversation.lastMessage || '',
    updatedAt: conversation.updatedAt,
    unreadCount: await unreadCount(conversation._id, openid)
  }
  if (conversation.type === 'ride_group') {
    const ride = await getRide(conversation.rideId)
    const owner = ride ? await getUserByOpenid(ride.ownerOpenid) : null
    return Object.assign(base, {
      rideId: conversation.rideId,
      groupName: ride ? ride.to + ' 拼车团' : '拼车群聊',
      groupRoute: ride ? ride.from + ' → ' + ride.to : '',
      memberCount: conversation.memberOpenids.length,
      contactName: owner && owner.name || '行程发布者',
      contactPhone: owner && validPhone(owner.phone) ? String(owner.phone) : ''
    })
  }
  const otherOpenid = conversation.memberOpenids.find(function (memberOpenid) {
    return memberOpenid !== openid
  })
  const otherUser = await getUserByOpenid(otherOpenid)
  return Object.assign(base, {
    otherUser: await publicUser(otherUser, resolveAvatar),
    contactName: otherUser && otherUser.name || '拼车搭子',
    contactPhone: otherUser && validPhone(otherUser.phone) ? String(otherUser.phone) : ''
  })
}

async function validateConversationAccess(conversation, openid, forWrite) {
  if (!isMember(conversation, openid)) {
    return '没有权限访问该会话'
  }
  if (conversation.type === 'direct') {
    const otherOpenid = conversation.memberOpenids.find(function (memberOpenid) {
      return memberOpenid !== openid
    })
    if (!otherOpenid || !(await areBuddies(openid, otherOpenid))) {
      return '搭子关系已解除，不能继续访问该会话'
    }
  }
  if (conversation.type === 'ride_group') {
    const ride = await getRide(conversation.rideId)
    const members = await rideMemberOpenids(conversation.rideId)
    if (!ride || members.indexOf(openid) === -1) {
      return '你已不在该拼车团中'
    }
    if (ride.status !== 'active') {
      return forWrite ? '该拼车团已结束，不能继续发送消息' : '该临时拼车群已结束'
    }
  }
  return ''
}

async function main(event) {
  const openid = cloud.getWXContext().OPENID
  const action = event.action
  const resolveAvatar = avatarUrl.createResolver(cloud, 'chat')
  const currentUser = await getUserByOpenid(openid)
  if (!currentUser) {
    return { ok: false, message: '请先重新进入小程序完成微信登录' }
  }

  if (action === 'createDirect') {
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser || targetUser.openid === openid) {
      return { ok: false, message: '聊天对象无效' }
    }
    if (!(await areBuddies(openid, targetUser.openid))) {
      return { ok: false, message: '接受搭子申请后才能开始聊天' }
    }
    const members = [openid, targetUser.openid].sort()
    const conversationId = stableId('direct_', members)
    let conversation = await getConversation(conversationId)
    if (!conversation) {
      const data = {
        type: 'direct',
        directKey: members.join(':'),
        memberOpenids: members,
        lastMessage: '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      await db.collection('conversations').doc(conversationId).set({ data: data })
      conversation = Object.assign({ _id: conversationId }, data)
    }
    return { ok: true, conversation: await conversationForClient(conversation, openid, resolveAvatar) }
  }

  if (action === 'createRideGroup') {
    const rideId = cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    const members = await rideMemberOpenids(rideId)
    if (!ride || ride.status !== 'active' || members.indexOf(openid) === -1) {
      return { ok: false, message: '加入拼车团后才能进入群聊' }
    }
    const conversationId = stableId('rg_', [rideId])
    let conversation = await getConversation(conversationId)
    const data = {
      type: 'ride_group',
      rideId: rideId,
      memberOpenids: members,
      updatedAt: db.serverDate()
    }
    if (!conversation) {
      await db.collection('conversations').doc(conversationId).set({
        data: Object.assign({}, data, { lastMessage: '', createdAt: db.serverDate() })
      })
      conversation = Object.assign({ _id: conversationId, lastMessage: '' }, data)
    } else {
      await db.collection('conversations').doc(conversationId).update({ data: data })
      conversation = Object.assign({}, conversation, data)
    }
    return { ok: true, conversation: await conversationForClient(conversation, openid, resolveAvatar) }
  }

  if (action === 'listConversations') {
    const options = pageOptions(event, 10)
    const result = await db.collection('conversations').where({
      memberOpenids: db.command.all([openid])
    }).orderBy('updatedAt', 'desc').skip(options.skip).limit(options.limit + 1).get()
    const conversations = []
    for (let i = 0; i < Math.min(result.data.length, options.limit); i += 1) {
      if (!(await validateConversationAccess(result.data[i], openid, false))) {
        conversations.push(await conversationForClient(result.data[i], openid, resolveAvatar))
      }
    }
    return {
      ok: true,
      conversations: conversations,
      pagination: { page: options.page, limit: options.limit, hasMore: result.data.length > options.limit }
    }
  }

  if (action === 'waitForConversations') {
    const after = Math.max(0, Number(event.after) || 0)
    const deadline = Date.now() + 1600

    while (true) {
      const where = {
        memberOpenids: db.command.all([openid])
      }
      if (after > 0) {
        where.updatedAt = db.command.gt(new Date(after))
      }
      const result = await db.collection('conversations').where(where)
        .orderBy('updatedAt', 'asc').limit(20).get()
      const conversations = []
      for (let i = 0; i < result.data.length; i += 1) {
        if (!(await validateConversationAccess(result.data[i], openid, false))) {
          conversations.push(await conversationForClient(result.data[i], openid, resolveAvatar))
        }
      }
      if (conversations.length) {
        return { ok: true, conversations: conversations }
      }
      if (Date.now() >= deadline) {
        return { ok: true, conversations: [], timedOut: true }
      }
      await sleep(60)
    }
  }

  if (action === 'listMessages') {
    const conversationId = cleanText(event.conversationId, 128)
    const conversation = await getConversation(conversationId)
    const accessError = await validateConversationAccess(conversation, openid, false)
    if (accessError) {
      return { ok: false, message: accessError }
    }
    const options = pageOptions(event, 30)
    const result = await db.collection('messages').where({ conversationId: conversationId })
      .orderBy('createdAt', 'desc').skip(options.skip).limit(options.limit + 1).get()
    const rows = result.data.slice(0, options.limit)
    const senderOpenids = rows.map(function (message) { return message.senderOpenid })
    const usersResult = senderOpenids.length
      ? await db.collection('users').where({ openid: db.command.in(senderOpenids) }).limit(50).get()
      : { data: [] }
    const users = {}
    usersResult.data.forEach(function (user) { users[user.openid] = user })
    const messages = []
    const orderedRows = rows.reverse()
    for (let i = 0; i < orderedRows.length; i += 1) {
      const message = orderedRows[i]
      messages.push({
        messageId: message._id,
        text: message.text,
        isMine: message.senderOpenid === openid,
        sender: await publicUser(users[message.senderOpenid], resolveAvatar),
        createdAt: message.createdAt
      })
    }
    if (options.page === 1 && event.markRead !== false) {
      await markRead(conversationId, openid)
    }
    return {
      ok: true,
      messages: messages,
      pagination: { page: options.page, limit: options.limit, hasMore: result.data.length > options.limit }
    }
  }

  if (action === 'waitForMessages') {
    const conversationId = cleanText(event.conversationId, 128)
    const conversation = await getConversation(conversationId)
    const accessError = await validateConversationAccess(conversation, openid, false)
    if (accessError) {
      return { ok: false, message: accessError }
    }
    const after = Math.max(0, Number(event.after) || 0)
    const known = {}
    const knownIds = Array.isArray(event.knownIds) ? event.knownIds.slice(-60) : []
    knownIds.forEach(function (messageId) { known[messageId] = true })
    const deadline = Date.now() + 1600

    while (true) {
      let rows
      if (after > 0) {
        const result = await db.collection('messages').where({
          conversationId: conversationId,
          createdAt: db.command.gte(new Date(after))
        }).orderBy('createdAt', 'asc').limit(30).get()
        rows = result.data
      } else {
        const result = await db.collection('messages').where({
          conversationId: conversationId
        }).orderBy('createdAt', 'desc').limit(30).get()
        rows = result.data.slice().reverse()
      }
      const fresh = rows.filter(function (message) { return !known[message._id] })
      if (fresh.length) {
        return {
          ok: true,
          messages: fresh.map(function (message) {
            return {
              messageId: message._id,
              text: message.text,
              isMine: message.senderOpenid === openid,
              sender: { name: message.senderName || '同学', avatar: '' },
              createdAt: message.createdAt
            }
          })
        }
      }
      if (Date.now() >= deadline) {
        return { ok: true, messages: [], timedOut: true }
      }
      await sleep(60)
    }
  }

  if (action === 'sendMessage') {
    const conversationId = cleanText(event.conversationId, 128)
    const text = cleanText(event.text, 500)
    const conversation = await getConversation(conversationId)
    const accessError = await validateConversationAccess(conversation, openid, true)
    if (accessError) {
      return { ok: false, message: accessError }
    }
    if (!text) {
      return { ok: false, message: '消息内容不能为空' }
    }
    let members = conversation.memberOpenids
    if (conversation.type === 'ride_group') {
      const currentMembers = await rideMemberOpenids(conversation.rideId)
      if (currentMembers.length) {
        members = currentMembers
      }
    }
    const messageId = 'msg_' + crypto.randomBytes(16).toString('hex')
    await db.runTransaction(async function (transaction) {
      await transaction.collection('messages').doc(messageId).set({
        data: {
          conversationId: conversationId,
          senderOpenid: openid,
          senderName: currentUser.name || '同学',
          memberOpenids: members,
          type: 'text',
          text: text,
          createdAt: db.serverDate()
        }
      })
      await transaction.collection('conversations').doc(conversationId).update({
        data: {
          memberOpenids: members,
          lastMessage: text,
          lastSenderOpenid: openid,
          updatedAt: db.serverDate()
        }
      })
    })
    await markRead(conversationId, openid)
    await Promise.all(members.map(function (ownerOpenid) {
      return db.collection('chat_events').doc(stableId('evt_', [messageId, ownerOpenid])).set({
        data: {
          ownerOpenid: ownerOpenid,
          conversationId: conversationId,
          messageId: messageId,
          senderUserId: currentUser._id,
          senderName: currentUser.name || '同学',
          text: text,
          createdAt: db.serverDate()
        }
      })
    })).catch(function (error) {
      console.warn('[chat] realtime event write failed:', error.errCode || error.message)
    })
    return { ok: true, messageId: messageId }
  }

  if (action === 'markRead') {
    const conversationId = cleanText(event.conversationId, 128)
    const conversation = await getConversation(conversationId)
    const accessError = await validateConversationAccess(conversation, openid, false)
    if (accessError) {
      return { ok: false, message: accessError }
    }
    await markRead(conversationId, openid)
    return { ok: true }
  }

  if (action === 'unreadSummary') {
    const result = await db.collection('conversations').where({
      memberOpenids: db.command.all([openid])
    }).orderBy('updatedAt', 'desc').limit(30).get()
    let total = 0
    for (let i = 0; i < result.data.length; i += 1) {
      if (!(await validateConversationAccess(result.data[i], openid, false))) {
        total += await unreadCount(result.data[i]._id, openid)
      }
    }
    return { ok: true, unreadCount: total }
  }

  if (action === 'recordSubscription') {
    const expectedTemplateId = configuredTemplateId()
    const templateId = cleanText(event.templateId, 128)
    if (!expectedTemplateId || templateId !== expectedTemplateId) {
      return { ok: false, message: '消息提醒模板尚未在云函数环境变量中配置' }
    }
    const quotaId = stableId('sub_', [openid, templateId])
    await db.runTransaction(async function (transaction) {
      let existing = null
      try {
        existing = (await transaction.collection('subscriptions').doc(quotaId).get()).data
      } catch (error) {
        existing = null
      }
      if (existing) {
        const nextQuota = Math.min(MAX_SUBSCRIPTION_QUOTA, Number(existing.remainingQuota || 0) + 1)
        await transaction.collection('subscriptions').doc(quotaId).update({
          data: { remainingQuota: nextQuota, acceptedAt: db.serverDate() }
        })
      } else {
        await transaction.collection('subscriptions').doc(quotaId).set({
          data: {
            userOpenid: openid,
            templateId: templateId,
            remainingQuota: 1,
            acceptedAt: db.serverDate()
          }
        })
      }
    })
    return { ok: true }
  }

  return { ok: false, message: '不支持的聊天操作' }
}

module.exports = { main: main }
