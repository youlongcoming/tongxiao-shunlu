const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function publicUser(user) {
  return user ? {
    userId: user._id,
    name: user.name || '未命名同学',
    avatar: user.avatar || '',
    grade: user.grade || '',
    major: user.major || ''
  } : null
}

function isMember(conversation, openid) {
  return conversation && Array.isArray(conversation.memberOpenids) &&
    conversation.memberOpenids.indexOf(openid) !== -1
}

async function getConversation(conversationId) {
  try {
    const result = await db.collection('conversations').doc(conversationId).get()
    return result.data
  } catch (error) {
    return null
  }
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

async function areBuddies(userOpenid, buddyOpenid) {
  const result = await db.collection('buddies').where({ userOpenid: userOpenid }).get()
  return result.data.some(function (item) {
    return item.buddyOpenid === buddyOpenid
  })
}

async function conversationForClient(conversation, openid) {
  const otherOpenid = conversation.memberOpenids.find(function (memberOpenid) {
    return memberOpenid !== openid
  })
  const otherUser = await getUserByOpenid(otherOpenid)
  return {
    conversationId: conversation._id,
    type: conversation.type,
    lastMessage: conversation.lastMessage || '',
    updatedAt: conversation.updatedAt,
    otherUser: publicUser(otherUser)
  }
}

exports.main = async function (event) {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const action = event.action

  if (action === 'createDirect') {
    const targetUser = await getUserById(cleanText(event.targetUserId, 128))
    if (!targetUser || targetUser.openid === openid) {
      return { ok: false, message: '聊天对象无效' }
    }
    if (!(await areBuddies(openid, targetUser.openid))) {
      return { ok: false, message: '接受搭子申请后才能开始聊天' }
    }

    const directKey = [openid, targetUser.openid].sort().join(':')
    const existing = await db.collection('conversations').where({ directKey: directKey }).limit(1).get()
    if (existing.data.length) {
      return {
        ok: true,
        conversation: await conversationForClient(existing.data[0], openid)
      }
    }

    const conversationData = {
      type: 'direct',
      directKey: directKey,
      memberOpenids: [openid, targetUser.openid],
      lastMessage: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
    const created = await db.collection('conversations').add({ data: conversationData })
    const stored = Object.assign({ _id: created._id }, conversationData)
    return {
      ok: true,
      conversation: await conversationForClient(stored, openid)
    }
  }

  if (action === 'listConversations') {
    const result = await db.collection('conversations').where({
      memberOpenids: db.command.all([openid])
    }).get()
    const conversations = []
    for (let i = 0; i < result.data.length; i += 1) {
      conversations.push(await conversationForClient(result.data[i], openid))
    }
    conversations.sort(function (a, b) {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
    return { ok: true, conversations: conversations }
  }

  if (action === 'listMessages') {
    const conversationId = cleanText(event.conversationId, 128)
    const conversation = await getConversation(conversationId)
    if (!isMember(conversation, openid)) {
      return { ok: false, message: '没有权限查看该会话' }
    }
    const result = await db.collection('messages').where({ conversationId: conversationId }).get()
    const messages = result.data.sort(function (a, b) {
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    }).slice(-50).map(function (message) {
      return {
        messageId: message._id,
        text: message.text,
        isMine: message.senderOpenid === openid,
        createdAt: message.createdAt
      }
    })
    return { ok: true, messages: messages }
  }

  if (action === 'sendMessage') {
    const conversationId = cleanText(event.conversationId, 128)
    const text = cleanText(event.text, 500)
    const conversation = await getConversation(conversationId)
    if (!isMember(conversation, openid)) {
      return { ok: false, message: '没有权限向该会话发送消息' }
    }
    if (!text) {
      return { ok: false, message: '消息内容不能为空' }
    }

    const messageData = {
      conversationId: conversationId,
      senderOpenid: openid,
      memberOpenids: conversation.memberOpenids,
      type: 'text',
      text: text,
      createdAt: db.serverDate()
    }
    const created = await db.collection('messages').add({ data: messageData })
    await db.collection('conversations').doc(conversationId).update({
      data: {
        lastMessage: text,
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, messageId: created._id }
  }

  return { ok: false, message: '不支持的聊天操作' }
}

// 新版聊天服务增加群聊、未读、订阅提醒和分页，旧实现保留用于回滚。
module.exports = require('./service')

