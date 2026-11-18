const cloudService = require('../../utils/cloud')
const appConfig = require('../../utils/config')
const phoneHelper = require('../../utils/phone')

const MESSAGES_POLL_INTERVAL_MS = 3000

function prepareUser(user) {
  const safeUser = user || {}
  return Object.assign({}, safeUser, {
    initial: String(safeUser.name || '友').slice(0, 1),
    subtitle: [safeUser.grade, safeUser.major].filter(Boolean).join(' ') || '校园拼车用户'
  })
}

function normalizeFriendCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return /^CP-[A-Z0-9]{6}$/.test(code) ? code : ''
}

function prepareConversation(item) {
  if (item.type === 'ride_group') {
    return Object.assign({}, item, {
      id: item.conversationId,
      isGroup: true,
      userId: '',
      displayName: item.groupName,
      displaySubtitle: item.groupRoute,
      avatarText: '群'
    })
  }
  const otherUser = prepareUser(item.otherUser)
  return Object.assign({}, item, {
    id: item.conversationId,
    isGroup: false,
    userId: otherUser.userId,
    otherUser: otherUser,
    displayName: otherUser.name,
    displaySubtitle: otherUser.subtitle,
    avatarText: otherUser.initial
  })
}

function appendUnique(current, next, key) {
  const seen = {}
  return (current || []).concat(next || []).filter(function (item) {
    const value = item && item[key]
    if (!value || seen[value]) {
      return false
    }
    seen[value] = true
    return true
  })
}

function conversationTime(item) {
  const value = item && item.updatedAt
  if (value instanceof Date) {
    return value.getTime()
  }
  if (value && typeof value === 'object' && value.$date) {
    return new Date(value.$date).getTime()
  }
  const time = new Date(value || 0).getTime()
  return Number.isNaN(time) ? 0 : time
}

function mergeConversations(current, incoming) {
  const byId = {}
  ;(current || []).forEach(function (item) {
    if (item && item.id) {
      byId[item.id] = item
    }
  })
  ;(incoming || []).forEach(function (item) {
    if (item && item.id) {
      byId[item.id] = item
    }
  })
  return Object.keys(byId).map(function (id) {
    return byId[id]
  }).sort(function (first, second) {
    return conversationTime(second) - conversationTime(first)
  })
}

Page({
  data: {
    conversations: [],
    groups: [],
    buddies: [],
    incomingRequests: [],
    outgoingRequests: [],
    cloudConnected: false,
    cloudLoading: false,
    cloudMessage: '正在连接微信身份',
    friendCode: '',
    myFriendCode: '',
    friendCodeNeedsRefresh: false,
    cloudPage: 1,
    hasMoreCloud: false,
    subscribeTemplateReady: Boolean(appConfig.CHAT_SUBSCRIBE_TEMPLATE_ID)
  },

  onShow: function () {
    const page = this
    page.pageVisible = true
    page.loadCloudData().then(function () {
      if (page.pageVisible && page.data.cloudConnected) {
        page.startRealtime()
      }
    })
  },

  onHide: function () {
    this.pageVisible = false
    this.stopEventWatch()
    this.stopRealtimeSync()
    this.stopLivePolling()
  },

  onUnload: function () {
    this.pageVisible = false
    this.stopEventWatch()
    this.stopRealtimeSync()
    this.stopLivePolling()
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
    if (!wx.cloud || !openid || !page.pageVisible) {
      return false
    }

    page.stopEventWatch()
    page.eventWatchToken = (page.eventWatchToken || 0) + 1
    const token = page.eventWatchToken
    const db = wx.cloud.database()
    const since = new Date(Date.now() - 60 * 1000)

    try {
      page.eventWatcher = db.collection('chat_events').where({
        ownerOpenid: openid,
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
      console.warn('[messages] realtime watch unavailable:', error && (error.errCode || error.message))
      page.stopEventWatch()
      return false
    }

    page.stopRealtimeSync()
    page.stopLivePolling()
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
    if (this.badgeRefreshTimer) {
      clearTimeout(this.badgeRefreshTimer)
      this.badgeRefreshTimer = null
    }
  },

  handleEventWatchError: function (error) {
    const page = this
    console.warn('[messages] realtime watch unavailable:', error && (error.errCode || error.message))
    page.stopEventWatch()
    page.startRealtimeSync()
  },

  scheduleBadgeRefresh: function () {
    const page = this
    if (page.badgeRefreshTimer) {
      return
    }
    page.badgeRefreshTimer = setTimeout(function () {
      page.badgeRefreshTimer = null
      if (page.pageVisible) {
        getApp().refreshUnreadBadge()
      }
    }, 300)
  },

  handleEventChanges: function (snapshot) {
    const page = this
    const state = getApp().globalData.cloudState || {}
    const myUserId = state.user && state.user.userId || ''
    const isInit = snapshot.type === 'init'
    const docs = []
    const seen = {}

    function addDoc(doc, changeType) {
      if (!doc || !doc.conversationId || seen[doc._id || doc.messageId]) {
        return
      }
      seen[doc._id || doc.messageId] = true
      docs.push({ doc: doc, changeType: changeType })
    }

    ;(snapshot.docChanges || []).forEach(function (change) {
      if (change.doc && change.dataType !== 'remove') {
        addDoc(change.doc, change.dataType)
      }
    })
    if (isInit) {
      ;(snapshot.docs || []).forEach(function (doc) {
        addDoc(doc, 'init')
      })
    }
    if (!docs.length) {
      return
    }

    const conversations = page.data.conversations.slice()
    let hasUnknownConversation = false
    docs.sort(function (first, second) {
      return conversationTime({ updatedAt: first.doc.createdAt }) -
        conversationTime({ updatedAt: second.doc.createdAt })
    })
    docs.forEach(function (item) {
      const doc = item.doc
      let index = -1
      for (let i = 0; i < conversations.length; i += 1) {
        if (conversations[i].id === doc.conversationId) {
          index = i
          break
        }
      }
      if (index === -1) {
        hasUnknownConversation = true
        return
      }
      const row = Object.assign({}, conversations[index], {
        lastMessage: doc.text || conversations[index].lastMessage,
        updatedAt: doc.createdAt || conversations[index].updatedAt
      })
      if (!isInit && item.changeType === 'add' && doc.senderUserId !== myUserId) {
        row.unreadCount = Number(row.unreadCount || 0) + 1
      }
      conversations[index] = row
    })
    conversations.sort(function (first, second) {
      return conversationTime(second) - conversationTime(first)
    })
    page.setData({ conversations: conversations })
    if (hasUnknownConversation) {
      page.refreshLiveConversations()
    }
    page.scheduleBadgeRefresh()
  },

  conversationCursor: function () {
    let after = 0
    this.data.conversations.forEach(function (item) {
      const time = conversationTime(item)
      if (time > after) {
        after = time
      }
    })
    if (!after && this.data.conversations.length) {
      // 云端时间字段异常时退化为只等待新更新，避免反复拉取同一批旧会话。
      after = Date.now() - 5000
    }
    return after
  },

  startRealtimeSync: function () {
    const page = this
    if (page.pageVisible === false) {
      return
    }
    page.stopEventWatch()
    page.stopRealtimeSync()
    page.stopLivePolling()
    page.realtimeToken = (page.realtimeToken || 0) + 1
    page.realtimeActive = true
    page.waitForConversationUpdates(page.realtimeToken)
  },

  waitForConversationUpdates: function (token) {
    const page = this
    if (!page.realtimeActive || token !== page.realtimeToken || page.waitingForConversations) {
      return
    }
    page.waitingForConversations = true
    cloudService.chat('waitForConversations', {
      after: page.conversationCursor()
    }).then(function (result) {
      if (token !== page.realtimeToken) {
        return
      }
      page.waitingForConversations = false
      if (!page.realtimeActive) {
        return
      }
      const conversations = (result.conversations || []).filter(function (item) {
        return item.type === 'ride_group' || item.otherUser
      }).map(prepareConversation)
      if (conversations.length) {
        page.setData({
          conversations: mergeConversations(page.data.conversations, conversations)
        })
        getApp().refreshUnreadBadge()
      }
      page.realtimeRetryTimer = setTimeout(function () {
        page.waitForConversationUpdates(token)
      }, 20)
    }).catch(function () {
      if (token !== page.realtimeToken) {
        return
      }
      page.waitingForConversations = false
      page.realtimeActive = false
      page.startLivePolling()
    })
  },

  stopRealtimeSync: function () {
    this.realtimeActive = false
    this.realtimeToken = (this.realtimeToken || 0) + 1
    this.waitingForConversations = false
    if (this.realtimeRetryTimer) {
      clearTimeout(this.realtimeRetryTimer)
      this.realtimeRetryTimer = null
    }
  },

  startLivePolling: function () {
    const page = this
    page.stopLivePolling()
    page.livePollingActive = true

    function scheduleNext() {
      page.livePollTimer = setTimeout(function () {
        if (!page.livePollingActive) {
          return
        }
        page.refreshLiveConversations()
        if (page.livePollingActive) {
          scheduleNext()
        }
      }, MESSAGES_POLL_INTERVAL_MS)
    }

    scheduleNext()
  },

  stopLivePolling: function () {
    this.livePollingActive = false
    if (this.livePollTimer) {
      clearTimeout(this.livePollTimer)
      this.livePollTimer = null
    }
  },

  refreshLiveConversations: function () {
    const page = this
    if (!page.data.cloudConnected || page.data.cloudLoading || page.liveRefreshing) {
      return
    }
    page.liveRefreshing = true
    cloudService.chat('listConversations', { page: 1, limit: 10 }).then(function (result) {
      if (!page.livePollingActive) {
        return
      }
      const conversations = result.conversations.filter(function (item) {
        return item.type === 'ride_group' || item.otherUser
      }).map(prepareConversation)
      if (!conversations.length) {
        return
      }
      page.setData({
        conversations: mergeConversations(page.data.conversations, conversations)
      })
      getApp().refreshUnreadBadge()
    }).catch(function () {
      // 后台轮询失败时保持现有列表，避免打断用户操作。
    }).then(function () {
      page.liveRefreshing = false
    })
  },

  loadCloudData: function () {
    const page = this
    const app = getApp()
    page.setData({ cloudLoading: true })

    return app.whenCloudReady().then(function (cloudState) {
      if (!cloudState.ready) {
        page.setData({
          cloudConnected: false,
          cloudLoading: false,
          cloudMessage: '云端暂不可用，无法读取消息与搭子',
          conversations: [],
          groups: [],
          buddies: [],
          incomingRequests: [],
          outgoingRequests: []
        })
        return
      }

      return Promise.all([
        cloudService.social('listRequests', { page: 1, limit: 10 }),
        cloudService.social('listBuddies', { page: 1, limit: 10 }),
        cloudService.chat('listConversations', { page: 1, limit: 10 }),
        cloudService.rides('listMyGroups', { page: 1, limit: 10 })
      ]).then(function (results) {
        const rawFriendCode = cloudState.user && cloudState.user.friendCode || ''
        const myFriendCode = normalizeFriendCode(rawFriendCode)
        page.setData({
          cloudConnected: true,
          cloudLoading: false,
          cloudMessage: '微信身份已连接，好友和消息将在设备间同步',
          myFriendCode: myFriendCode,
          friendCodeNeedsRefresh: !myFriendCode,
          cloudPage: 1,
          hasMoreCloud: Boolean(
            results[0].pagination && (results[0].pagination.hasMoreIncoming || results[0].pagination.hasMoreOutgoing) ||
            results[1].pagination && results[1].pagination.hasMore ||
            results[2].pagination && results[2].pagination.hasMore ||
            results[3].pagination && results[3].pagination.hasMore
          ),
          incomingRequests: results[0].incoming.filter(function (item) {
            return item.status === 'pending' && item.user
          }).map(function (item) {
            return Object.assign({}, item, { user: prepareUser(item.user) })
          }),
          outgoingRequests: results[0].outgoing.filter(function (item) {
            return item.status === 'pending' && item.user
          }),
          groups: results[3].rides,
          buddies: results[1].buddies.map(function (item) {
            const user = prepareUser(item.user)
            return Object.assign({}, item, {
              user: user,
              displayNote: item.note || user.subtitle
            })
          }),
          conversations: results[2].conversations.filter(function (item) {
            return item.type === 'ride_group' || item.otherUser
          }).map(prepareConversation)
        })
        getApp().refreshUnreadBadge()
      }).catch(function (error) {
        page.setData({
          cloudConnected: false,
          cloudLoading: false,
          cloudMessage: '云端功能需重新部署：' + error.message
        })
      })
    })
  },

  onFriendCodeInput: function (event) {
    this.setData({ friendCode: event.detail.value.toUpperCase() })
  },

  sendBuddyRequest: function () {
    const page = this
    const friendCode = this.data.friendCode.trim().toUpperCase()
    if (!friendCode) {
      wx.showToast({ title: '请输入搭子码', icon: 'none' })
      return
    }

    page.setData({ cloudLoading: true })
    cloudService.social('sendRequest', {
      friendCode: friendCode,
      message: '想和你成为拼车搭子'
    }).then(function () {
      page.setData({ friendCode: '' })
      wx.showToast({ title: '搭子申请已发送', icon: 'success' })
      page.loadCloudData()
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  handleBuddyRequest: function (event) {
    const page = this
    const action = event.currentTarget.dataset.action
    const requestId = event.currentTarget.dataset.id
    const cloudAction = action === 'accept' ? 'acceptRequest' : 'rejectRequest'
    page.setData({ cloudLoading: true })

    cloudService.social(cloudAction, { requestId: requestId })
      .then(function () {
        wx.showToast({
          title: action === 'accept' ? '已成为搭子' : '已拒绝申请',
          icon: action === 'accept' ? 'success' : 'none'
        })
        page.loadCloudData()
      })
      .catch(function (error) {
        page.setData({ cloudLoading: false })
        wx.showToast({ title: error.message, icon: 'none' })
      })
  },

  openChat: function (event) {
    if (event.currentTarget.dataset.group) {
      wx.navigateTo({
        url: '/pages/chat/chat?groupRideId=' + encodeURIComponent(event.currentTarget.dataset.rideId)
      })
      return
    }
    const userId = event.currentTarget.dataset.userId
    if (userId) {
      wx.navigateTo({
        url: '/pages/chat/chat?userId=' + encodeURIComponent(userId)
      })
      return
    }
    wx.showToast({ title: '云端会话无效，请刷新后重试', icon: 'none' })
  },

  callContact: function (event) {
    const phone = phoneHelper.normalizePhone(event.currentTarget.dataset.phone)
    const name = event.currentTarget.dataset.name || '对方'
    if (!phoneHelper.isValidPhone(phone)) {
      wx.showToast({ title: '对方尚未填写手机号', icon: 'none' })
      return
    }
    wx.showModal({
      title: '电话联系',
      content: '将拨打' + name + '的手机号，是否继续？',
      confirmText: '拨打',
      success: function (result) {
        if (result.confirm) {
          wx.makePhoneCall({ phoneNumber: phone })
        }
      }
    })
  },

  openGroup: function (event) {
    const rideId = event.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/group/group?rideId=' + encodeURIComponent(rideId)
    })
  },

  copyFriendCode: function () {
    const page = this
    if (this.data.myFriendCode) {
      wx.setClipboardData({ data: this.data.myFriendCode })
      return
    }
    page.setData({ cloudLoading: true })
    cloudService.login().then(function (result) {
      const friendCode = normalizeFriendCode(result.user && result.user.friendCode)
      if (!friendCode) {
        throw new Error('请先重新部署 login 云函数')
      }
      const app = getApp()
      if (app.globalData.cloudState) {
        app.globalData.cloudState.user = result.user
      }
      page.setData({
        cloudLoading: false,
        myFriendCode: friendCode,
        friendCodeNeedsRefresh: false
      })
      wx.showToast({ title: '搭子码已更新', icon: 'success' })
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showToast({ title: error.message || '搭子码更新失败', icon: 'none' })
    })
  },

  enableMessageReminder: function () {
    const page = this
    const templateId = appConfig.CHAT_SUBSCRIBE_TEMPLATE_ID
    if (!templateId) {
      wx.showModal({
        title: '提醒模板待配置',
        content: '请先在微信公众平台申请订阅消息模板，并把模板 ID 填入 utils/config.js 与 chat 云函数环境变量。',
        showCancel: false
      })
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: function (result) {
        if (result[templateId] !== 'accept') {
          wx.showToast({ title: '未开启消息提醒', icon: 'none' })
          return
        }
        cloudService.chat('recordSubscription', { templateId: templateId }).then(function () {
          wx.showToast({ title: '本次提醒已开启', icon: 'success' })
        }).catch(function (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        })
      },
      fail: function () {
        page.setData({ subscribeTemplateReady: false })
        wx.showToast({ title: '无法请求订阅提醒', icon: 'none' })
      }
    })
  },

  loadMoreCloudData: function () {
    if (this.data.cloudLoading || !this.data.hasMoreCloud) {
      return
    }
    const page = this
    const nextPage = this.data.cloudPage + 1
    page.setData({ cloudLoading: true })
    Promise.all([
      cloudService.social('listRequests', { page: nextPage, limit: 10 }),
      cloudService.social('listBuddies', { page: nextPage, limit: 10 }),
      cloudService.chat('listConversations', { page: nextPage, limit: 10 }),
      cloudService.rides('listMyGroups', { page: nextPage, limit: 10 })
    ]).then(function (results) {
      const incoming = results[0].incoming.filter(function (item) {
        return item.status === 'pending' && item.user
      }).map(function (item) {
        return Object.assign({}, item, { user: prepareUser(item.user) })
      })
      const outgoing = results[0].outgoing.filter(function (item) {
        return item.status === 'pending' && item.user
      })
      const buddies = results[1].buddies.map(function (item) {
        const user = prepareUser(item.user)
        return Object.assign({}, item, { user: user, displayNote: item.note || user.subtitle })
      })
      const conversations = results[2].conversations.filter(function (item) {
        return item.type === 'ride_group' || item.otherUser
      }).map(prepareConversation)
      page.setData({
        cloudLoading: false,
        cloudPage: nextPage,
        hasMoreCloud: Boolean(
          results[0].pagination && (results[0].pagination.hasMoreIncoming || results[0].pagination.hasMoreOutgoing) ||
          results[1].pagination && results[1].pagination.hasMore ||
          results[2].pagination && results[2].pagination.hasMore ||
          results[3].pagination && results[3].pagination.hasMore
        ),
        incomingRequests: appendUnique(page.data.incomingRequests, incoming, 'requestId'),
        outgoingRequests: appendUnique(page.data.outgoingRequests, outgoing, 'requestId'),
        buddies: appendUnique(page.data.buddies, buddies, 'relationId'),
        conversations: appendUnique(page.data.conversations, conversations, 'id'),
        groups: appendUnique(page.data.groups, results[3].rides, 'id')
      })
    }).catch(function (error) {
      page.setData({ cloudLoading: false })
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    })
  },

  deleteBuddy: function (event) {
    const page = this
    const dataset = event.currentTarget.dataset
    const name = dataset.name || '这位搭子'
    wx.showModal({
      title: '删除搭子',
      content: '确定删除 ' + name + ' 吗？删除后双方将不能继续私聊，但以后仍可重新发送搭子申请。',
      confirmColor: '#c4473a',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        if (!dataset.userId) {
          wx.showToast({ title: '搭子记录无效，请刷新后重试', icon: 'none' })
          return
        }
        page.setData({ cloudLoading: true })
        cloudService.social('deleteBuddy', { targetUserId: dataset.userId }).then(function () {
          wx.showToast({ title: '搭子已删除', icon: 'success' })
          page.loadCloudData()
        }).catch(function (error) {
          page.setData({ cloudLoading: false })
          wx.showToast({ title: error.message, icon: 'none' })
        })
      }
    })
  },

  goFindRide: function () {
    wx.switchTab({ url: '/pages/rides/rides' })
  }
})

