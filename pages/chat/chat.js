const cloudService = require('../../utils/cloud')
const phoneHelper = require('../../utils/phone')
const CHAT_POLL_INTERVAL_MS = 1500

function getCloudTimeText(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) {
    return '--:--'
  }
  const hour = date.getHours() < 10 ? '0' + date.getHours() : String(date.getHours())
  const minute = date.getMinutes() < 10 ? '0' + date.getMinutes() : String(date.getMinutes())
  return hour + ':' + minute
}

function formatCloudMessages(messages) {
  return (messages || []).map(function (message) {
    const sender = message.sender || {}
    return {
      id: message.messageId,
      type: message.isMine ? 'self' : 'other',
      text: message.text,
      createdAt: message.createdAt,
      time: getCloudTimeText(message.createdAt),
      senderName: sender.name || '同学',
      senderAvatar: sender.avatar || '',
      senderInitial: String(sender.name || 'W').slice(0, 1)
    }
  })
}

function messageTime(value) {
  if (value instanceof Date) {
    return value.getTime()
  }
  if (value && typeof value === 'object' && value.$date) {
    return new Date(value.$date).getTime()
  }
  const time = new Date(value || 0).getTime()
  return Number.isNaN(time) ? 0 : time
}

Page({
  data: {
    cloudMode: false,
    groupMode: false,
    cloudLoading: false,
    otherUser: null,
    chatAvatarText: 'W',
    contactPhone: '',
    contactName: '',
    contactLabel: '',
    conversationId: '',
    messages: [],
    messageInput: '',
    noteInput: '',
    scrollTarget: '',
    messagePage: 1,
    hasMoreMessages: false,
    atBottom: true,
    newMessageCount: 0,
    syncHint: '消息实时同步中'
  },

  onLoad: function (options) {
    this.pageVisible = true
    const groupRideId = decodeURIComponent(options.groupRideId || '')
    if (groupRideId) {
      this.initCloudGroupChat(groupRideId)
      return
    }
    const userId = decodeURIComponent(options.userId || '')
    if (userId) {
      this.initCloudChat(userId)
      return
    }

    wx.showModal({
      title: '会话链接无效',
      content: '本地模拟会话已移除，请从云端拼车团或搭子列表重新进入。',
      showCancel: false,
      success: function () { wx.navigateBack() }
    })
  },

  initCloudChat: function (userId) {
    this.initCloudConversation('createDirect', { targetUserId: userId })
  },

  initCloudGroupChat: function (rideId) {
    this.initCloudConversation('createRideGroup', { rideId: rideId })
  },

  initCloudConversation: function (action, data) {
    const page = this
    const app = getApp()
    page.setData({ cloudMode: true, groupMode: action === 'createRideGroup', cloudLoading: true })

    app.whenCloudReady().then(function (cloudState) {
      if (!cloudState.ready) {
        throw new Error('微信身份尚未连接')
      }
      return cloudService.chat(action, data)
    }).then(function (result) {
      const conversation = result.conversation
      const otherUser = conversation.otherUser || null
      const isGroup = page.data.groupMode
      const contactPhone = phoneHelper.isValidPhone(conversation.contactPhone)
        ? phoneHelper.normalizePhone(conversation.contactPhone)
        : ''
      page.setData({
        conversationId: conversation.conversationId,
        otherUser: otherUser,
        contactPhone: contactPhone,
        contactName: conversation.contactName || (otherUser && otherUser.name) || (isGroup ? '行程发起人' : '拼车搭子'),
        contactLabel: isGroup ? '联系发起人' : '电话联系',
        groupTitle: conversation.groupName || '',
        groupRoute: conversation.groupRoute || '',
        chatAvatarText: String(otherUser && otherUser.name || 'W').slice(0, 1),
        noteInput: '',
        cloudLoading: false
      })
      wx.setNavigationBarTitle({
        title: page.data.groupMode ? conversation.groupName : otherUser.name + ' · 在线聊天'
      })
      page.loadCloudMessages(true).then(function () {
        if (page.pageVisible) {
          page.startRealtime()
        }
      })
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showModal({
        title: '无法打开聊天',
        content: error.message,
        showCancel: false,
        success: function () { wx.navigateBack() }
      })
    })
  },

  loadCloudMessages: function (reset) {
    const page = this
    if (!page.data.cloudMode || !page.data.conversationId) {
      return Promise.resolve()
    }
    const targetPage = reset ? 1 : page.data.messagePage + 1
    page.setData({ cloudLoading: true })
    return cloudService.chat('listMessages', {
      conversationId: page.data.conversationId,
      page: targetPage,
      limit: 30
    }).then(function (result) {
      const messages = formatCloudMessages(result.messages)
      const merged = reset ? messages : messages.concat(page.data.messages)
      const update = {
        messages: merged,
        messagePage: targetPage,
        hasMoreMessages: Boolean(result.pagination && result.pagination.hasMore),
        cloudLoading: false
      }
      if (reset) {
        update.scrollTarget = merged.length ? merged[merged.length - 1].id : ''
        update.atBottom = true
        update.newMessageCount = 0
        page.lastScrollTop = 0
      }
      page.setData(update)
      getApp().refreshUnreadBadge()
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  appendIncomingMessages: function (incoming) {
    const page = this
    const known = {}
    page.data.messages.forEach(function (message) { known[message.id] = true })
    const fresh = (incoming || []).filter(function (message) { return !known[message.id] })
    if (!fresh.length) {
      return false
    }
    const otherCount = fresh.filter(function (message) { return message.type === 'other' }).length
    const merged = page.data.messages.concat(fresh).sort(function (first, second) {
      return messageTime(first.createdAt) - messageTime(second.createdAt)
    })
    const update = {
      messages: merged
    }
    if (page.data.atBottom) {
      update.scrollTarget = merged[merged.length - 1].id
      update.newMessageCount = 0
    } else {
      update.newMessageCount = page.data.newMessageCount + otherCount
    }
    page.setData(update)
    if (page.data.atBottom) {
      page.markConversationRead()
    } else {
      getApp().refreshUnreadBadge()
    }
    return true
  },

  syncNewMessages: function () {
    const page = this
    if (!page.data.cloudMode || !page.data.conversationId || page.syncing || page.data.cloudLoading) {
      return
    }
    page.syncing = true
    cloudService.chat('listMessages', {
      conversationId: page.data.conversationId,
      page: 1,
      limit: 30,
      markRead: false
    }).then(function (result) {
      page.appendIncomingMessages(formatCloudMessages(result.messages))
    }).catch(function (error) {
      const message = error && error.message || ''
      if (message.indexOf('已结束') !== -1 || message.indexOf('已解除') !== -1 ||
        message.indexOf('不在该拼车团') !== -1 || message.indexOf('没有权限') !== -1) {
        page.stopRealtimeSync()
        page.stopMessagePolling()
        page.setData({ syncHint: message })
      }
    }).then(function () {
      page.syncing = false
    })
  },

  loadOlderMessages: function () {
    if (!this.data.cloudLoading && this.data.hasMoreMessages) {
      this.loadCloudMessages(false)
    }
  },

  refreshMessages: function () {
    if (this.data.cloudMode) {
      this.loadCloudMessages(true)
    }
  },

  startRealtime: function () {
    const page = this
    if (page.startEventWatch()) {
      return
    }
    page.startRealtimeSync()
  },

  startEventWatch: function () {
    const page = this
    const state = getApp().globalData.cloudState || {}
    const openid = state.openid || ''
    if (!wx.cloud || !openid || !page.data.conversationId || !page.pageVisible) {
      return false
    }

    page.stopEventWatch()
    page.eventWatchToken = (page.eventWatchToken || 0) + 1
    const token = page.eventWatchToken
    const db = wx.cloud.database()
    const since = new Date(Date.now() - 5 * 60 * 1000)

    try {
      page.eventWatcher = db.collection('chat_events').where({
        ownerOpenid: openid,
        conversationId: page.data.conversationId,
        createdAt: db.command.gte(since)
      }).watch({
        onChange: function (snapshot) {
          if (token !== page.eventWatchToken) {
            return
          }
          page.handleEventChanges(snapshot)
        },
        onError: function (error) {
          if (token !== page.eventWatchToken) {
            return
          }
          page.handleEventWatchError(error)
        }
      })
    } catch (error) {
      console.warn('[chat] realtime watch unavailable:', error && (error.errCode || error.message))
      page.stopEventWatch()
      page.setData({ syncHint: '实时推送未开启，已切换低延迟同步' })
      return false
    }

    page.stopRealtimeSync()
    page.stopMessagePolling()
    page.setData({ syncHint: '消息实时推送中' })
    return true
  },

  stopEventWatch: function () {
    this.eventWatchToken = (this.eventWatchToken || 0) + 1
    const watcher = this.eventWatcher
    this.eventWatcher = null
    if (watcher) {
      try {
        watcher.close()
      } catch (error) {
        // 监听器已经关闭时忽略。
      }
    }
  },

  handleEventWatchError: function (error) {
    const page = this
    console.warn('[chat] realtime watch unavailable:', error && (error.errCode || error.message))
    page.stopEventWatch()
    page.setData({ syncHint: '实时推送未开启，已切换低延迟同步' })
    page.startRealtimeSync()
  },

  handleEventChanges: function (snapshot) {
    const page = this
    const docs = []
    const seen = {}
    function addDoc(doc) {
      if (doc && doc.messageId && !seen[doc.messageId]) {
        seen[doc.messageId] = true
        docs.push(doc)
      }
    }

    ;(snapshot.docChanges || []).forEach(function (change) {
      if (change.doc && (change.dataType === 'add' || change.dataType === 'init')) {
        addDoc(change.doc)
      }
    })
    if (snapshot.type === 'init') {
      ;(snapshot.docs || []).forEach(addDoc)
    }
    if (!docs.length) {
      return
    }

    docs.sort(function (first, second) {
      return messageTime(first.createdAt) - messageTime(second.createdAt)
    })
    const state = getApp().globalData.cloudState || {}
    const myUserId = state.user && state.user.userId || ''
    const messages = docs.map(function (doc) {
      return {
        id: doc.messageId,
        type: doc.senderUserId && doc.senderUserId === myUserId ? 'self' : 'other',
        text: doc.text,
        createdAt: doc.createdAt,
        time: getCloudTimeText(doc.createdAt),
        senderName: doc.senderName || '同学',
        senderAvatar: '',
        senderInitial: String(doc.senderName || 'W').slice(0, 1)
      }
    })
    page.appendIncomingMessages(messages)
  },

  messageCursor: function () {
    let after = 0
    this.data.messages.forEach(function (message) {
      const time = messageTime(message.createdAt)
      if (time > after) {
        after = time
      }
    })
    if (!after && this.data.messages.length) {
      after = Date.now() - 60000
    }
    return {
      after: after,
      knownIds: this.data.messages.slice(-50).map(function (message) { return message.id })
    }
  },

  startRealtimeSync: function () {
    const page = this
    if (!page.data.cloudMode || !page.data.conversationId || !page.pageVisible) {
      return
    }
    page.stopEventWatch()
    page.stopRealtimeSync()
    page.stopMessagePolling()
    page.realtimeToken = (page.realtimeToken || 0) + 1
    page.realtimeActive = true
    page.setData({ syncHint: '消息实时同步中' })
    page.waitForNewMessages(page.realtimeToken)
  },

  waitForNewMessages: function (token) {
    const page = this
    if (!page.realtimeActive || token !== page.realtimeToken ||
      !page.data.cloudMode || !page.data.conversationId || page.waitingForMessages) {
      return
    }
    page.waitingForMessages = true
    const cursor = page.messageCursor()
    cloudService.chat('waitForMessages', {
      conversationId: page.data.conversationId,
      after: cursor.after,
      knownIds: cursor.knownIds
    }).then(function (result) {
      if (token !== page.realtimeToken) {
        return
      }
      page.waitingForMessages = false
      if (!page.realtimeActive) {
        return
      }
      page.appendIncomingMessages(formatCloudMessages(result.messages))
      page.realtimeRetryTimer = setTimeout(function () {
        page.waitForNewMessages(token)
      }, 20)
    }).catch(function (error) {
      if (token !== page.realtimeToken) {
        return
      }
      page.waitingForMessages = false
      page.realtimeActive = false
      const message = error && error.message || ''
      if (message.indexOf('已结束') !== -1 || message.indexOf('已解除') !== -1 ||
        message.indexOf('不在该拼车团') !== -1 || message.indexOf('没有权限') !== -1) {
        page.setData({ syncHint: message })
        return
      }
      page.setData({ syncHint: '实时连接不稳定，已切换自动同步' })
      page.startMessagePolling()
    })
  },

  stopRealtimeSync: function () {
    this.realtimeActive = false
    this.realtimeToken = (this.realtimeToken || 0) + 1
    this.waitingForMessages = false
    if (this.realtimeRetryTimer) {
      clearTimeout(this.realtimeRetryTimer)
      this.realtimeRetryTimer = null
    }
  },

  startMessagePolling: function () {
    const page = this
    page.stopMessagePolling()
    page.messagePollingActive = true

    function scheduleNext() {
      page.messagePollTimer = setTimeout(function () {
        if (!page.messagePollingActive) {
          return
        }
        if (page.data.cloudMode && page.data.conversationId && !page.data.cloudLoading) {
          page.syncNewMessages()
        }
        if (page.messagePollingActive) {
          scheduleNext()
        }
      }, CHAT_POLL_INTERVAL_MS)
    }

    scheduleNext()
  },

  stopMessagePolling: function () {
    this.messagePollingActive = false
    if (this.messagePollTimer) {
      clearTimeout(this.messagePollTimer)
      this.messagePollTimer = null
    }
  },

  onShow: function () {
    this.pageVisible = true
    if (this.data.cloudMode && this.data.conversationId) {
      this.syncNewMessages()
      this.startRealtime()
    }
  },

  onHide: function () {
    this.pageVisible = false
    this.stopEventWatch()
    this.stopRealtimeSync()
    this.stopMessagePolling()
  },

  onUnload: function () {
    this.pageVisible = false
    this.stopEventWatch()
    this.stopRealtimeSync()
    this.stopMessagePolling()
  },

  onPullDownRefresh: function () {
    const page = this
    if (!page.data.cloudMode) {
      wx.stopPullDownRefresh()
      return
    }
    page.loadCloudMessages(true)
    setTimeout(function () { wx.stopPullDownRefresh() }, 500)
  },

  onMessageInput: function (event) {
    this.setData({ messageInput: event.detail.value })
  },

  onMessageScroll: function (event) {
    const top = Number(event.detail && event.detail.scrollTop || 0)
    if (top + 12 < (this.lastScrollTop || 0) && this.data.atBottom) {
      this.setData({ atBottom: false })
    }
    this.lastScrollTop = top
  },

  onMessageBottom: function () {
    this.lastScrollTop = 0
    const hadUnread = !this.data.atBottom || this.data.newMessageCount > 0
    if (hadUnread) {
      this.setData({ atBottom: true, newMessageCount: 0 })
      this.markConversationRead()
    }
  },

  scrollToLatest: function () {
    const messages = this.data.messages
    if (!messages.length) {
      return
    }
    const page = this
    const lastId = messages[messages.length - 1].id
    page.setData({ scrollTarget: '', atBottom: true, newMessageCount: 0 })
    wx.nextTick(function () {
      page.setData({ scrollTarget: lastId })
    })
    page.markConversationRead()
  },

  markConversationRead: function () {
    const page = this
    if (!page.data.cloudMode || !page.data.conversationId || page.markingRead) {
      return
    }
    page.markingRead = true
    cloudService.chat('markRead', {
      conversationId: page.data.conversationId
    }).then(function () {
      getApp().refreshUnreadBadge()
    }).catch(function () {
      // 已读游标同步失败时保留未读角标，等待下一次同步。
    }).then(function () {
      page.markingRead = false
    })
  },

  callContact: function () {
    const page = this
    const phone = phoneHelper.normalizePhone(page.data.contactPhone)
    if (!phoneHelper.isValidPhone(phone)) {
      wx.showToast({ title: '对方尚未填写手机号', icon: 'none' })
      return
    }
    const role = page.data.groupMode ? '发起人' : '搭子'
    wx.showModal({
      title: '电话联系' + role,
      content: '将拨打' + (page.data.contactName || role) + '的手机号，是否继续？',
      confirmText: '拨打',
      success: function (result) {
        if (result.confirm) {
          wx.makePhoneCall({ phoneNumber: phone })
        }
      }
    })
  },

  sendMessage: function () {
    const text = this.data.messageInput.trim()
    if (!text) {
      return
    }

    const page = this
    page.setData({ cloudLoading: true })
    cloudService.chat('sendMessage', {
      conversationId: page.data.conversationId,
      text: text
    }).then(function () {
      page.setData({ messageInput: '', cloudLoading: false, atBottom: true, newMessageCount: 0 })
      page.syncNewMessages()
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  onNoteInput: function (event) {
    this.setData({ noteInput: event.detail.value })
  },

  saveNote: function () {
    if (this.data.groupMode || !this.data.otherUser) {
      return
    }
    cloudService.social('saveNote', {
      targetUserId: this.data.otherUser.userId,
      note: this.data.noteInput.trim()
    }).then(function () {
      wx.showToast({ title: '云端备注已保存', icon: 'success' })
    }).catch(function (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    })
  }
})

