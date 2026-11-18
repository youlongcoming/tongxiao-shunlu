const cloudService = require('./utils/cloud')
const schoolStore = require('./utils/school')

const BADGE_POLL_INTERVAL_MS = 8000

const LEGACY_DEMO_STORAGE_KEYS = [
  'publishedRides',
  'rideConversations',
  'rideChatMessages',
  'joinedRideGroups',
  'carpoolBuddies',
  'contactNotes'
]

function clearLegacyDemoStorage() {
  LEGACY_DEMO_STORAGE_KEYS.forEach(function (key) {
    wx.removeStorageSync(key)
  })
}

App({
  onLaunch: function () {
    const app = this
    clearLegacyDemoStorage()
    this.cloudReadyPromise = this.initializeCloud().then(function (state) {
      if (state.ready) {
        app.refreshUnreadBadge()
        app.startBadgePolling()
      }
      return state
    })
  },

  onShow: function () {
    this.refreshUnreadBadge()
    this.startBadgePolling()
  },

  onHide: function () {
    this.stopBadgePolling()
  },

  initializeCloud: function () {
    const app = this

    if (!cloudService.isAvailable()) {
      const unavailableState = {
        ready: false,
        reason: '当前基础库不支持云开发'
      }
      app.globalData.cloudState = unavailableState
      return Promise.resolve(unavailableState)
    }

    cloudService.init()
    return cloudService.login()
      .then(function (result) {
        const cloudSchool = schoolStore.normalizeSchool({
          id: result.user && result.user.schoolId,
          name: result.user && result.user.schoolName,
          province: result.user && result.user.schoolProvince,
          city: result.user && result.user.schoolCity,
          level: result.user && result.user.schoolLevel
        })
        const selectedSchool = cloudSchool || schoolStore.getSelectedSchool()
        if (selectedSchool) {
          schoolStore.setSelectedSchool(selectedSchool)
          app.globalData.school = selectedSchool
        }
        const readyState = {
          ready: true,
          openid: result.openid,
          user: result.user || null
        }
        app.globalData.cloudState = readyState
        return readyState
      })
      .catch(function (error) {
        const pendingState = {
          ready: false,
          reason: '云函数尚未部署或暂时不可用',
          errorMessage: error.message || String(error)
        }
        app.globalData.cloudState = pendingState
        console.warn('[cloud] login pending:', pendingState.errorMessage)
        return pendingState
      })
  },

  whenCloudReady: function () {
    return this.cloudReadyPromise || Promise.resolve(this.globalData.cloudState)
  },

  refreshUnreadBadge: function () {
    const app = this
    const state = this.globalData.cloudState
    if (!state || !state.ready || app.badgeRefreshing) {
      return
    }
    app.badgeRefreshing = true
    cloudService.chat('unreadSummary').then(function (result) {
      const count = Number(result.unreadCount || 0)
      if (count > 0) {
        wx.setTabBarBadge({ index: 3, text: count > 99 ? '99+' : String(count) })
      } else {
        wx.removeTabBarBadge({ index: 3 })
      }
    }).catch(function () {
      // 角标同步失败不影响页面内容。
    }).then(function () {
      app.badgeRefreshing = false
    })
  },

  startBadgePolling: function () {
    const app = this
    app.stopBadgePolling()
    const state = app.globalData.cloudState
    if (!state || !state.ready) {
      return
    }
    app.badgePollingActive = true

    function scheduleNext() {
      app.badgePollTimer = setTimeout(function () {
        if (!app.badgePollingActive) {
          return
        }
        app.refreshUnreadBadge()
        if (app.badgePollingActive) {
          scheduleNext()
        }
      }, BADGE_POLL_INTERVAL_MS)
    }

    scheduleNext()
  },

  stopBadgePolling: function () {
    this.badgePollingActive = false
    if (this.badgePollTimer) {
      clearTimeout(this.badgePollTimer)
      this.badgePollTimer = null
    }
  },

  globalData: {
    appName: '校园拼车',
    school: null,
    cloudState: {
      ready: false,
      reason: '正在连接云环境'
    }
  }
})

