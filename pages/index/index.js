const cloudService = require('../../utils/cloud')
const schoolStore = require('../../utils/school')

Page({
  data: {
    featuredRides: [],
    schoolName: '',
    schoolMeta: '',
    cloudMessage: '正在读取云端行程',
    availableCountText: '—',
    joiningRideId: ''
  },

  onShow: function () {
    const school = schoolStore.getSelectedSchool()
    if (!school) {
      wx.reLaunch({ url: '/pages/school-select/school-select' })
      return
    }
    this.setData({
      schoolName: school.name,
      schoolMeta: [school.province, school.city].filter(Boolean).join(' · ')
    })
    this.loadHomeData()
  },

  loadHomeData: function () {
    const page = this
    return getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        page.setData({
          featuredRides: [],
          availableCountText: '—',
          cloudMessage: '云端连接失败，暂时无法读取行程'
        })
        return null
      }
      return cloudService.rides('list', {
        page: 1,
        limit: 10,
        scope: 'joinable',
        withTotal: true
      }).then(function (result) {
        const rides = result.rides || []
        const total = typeof result.total === 'number' ? result.total : rides.length
        page.setData({
          featuredRides: rides.slice(0, 10),
          availableCountText: String(total),
          cloudMessage: rides.length ? '已同步当前学校行程' : '当前学校暂无近期行程'
        })
      })
    }).catch(function (error) {
      page.setData({
        featuredRides: [],
        availableCountText: '—',
        cloudMessage: '云端行程加载失败：' + (error.message || '请稍后重试')
      })
    })
  },

  handleRideAction: function (event) {
    const page = this
    const rideId = event.currentTarget.dataset.id
    const ride = page.data.featuredRides.filter(function (item) {
      return item.id === rideId
    })[0]
    if (ride && ride.action === 'join') {
      page.joinRide(rideId)
      return
    }
    wx.navigateTo({
      url: '/pages/group/group?rideId=' + encodeURIComponent(rideId)
    })
  },

  joinRide: function (rideId) {
    const page = this
    if (!rideId || page.data.joiningRideId) {
      return
    }
    page.setData({ joiningRideId: rideId })
    cloudService.rides('join', { rideId: rideId }).then(function () {
      page.setData({ joiningRideId: '' })
      wx.showToast({ title: '已加入拼车团', icon: 'success' })
      setTimeout(function () {
        wx.navigateTo({
          url: '/pages/group/group?rideId=' + encodeURIComponent(rideId)
        })
      }, 400)
    }).catch(function (error) {
      page.setData({ joiningRideId: '' })
      if (error.code === 'PHONE_REQUIRED') {
        wx.showModal({
          title: '请先填写手机号',
          content: '加入拼车团前需要在“我的”页面填写并云端保存手机号。',
          confirmText: '去填写',
          success: function (result) {
            if (result.confirm) {
              wx.switchTab({ url: '/pages/profile/profile' })
            }
          }
        })
        return
      }
      wx.showToast({ title: error.message || '加入失败', icon: 'none' })
      page.loadHomeData()
    })
  },

  goToRides: function () {
    wx.switchTab({ url: '/pages/rides/rides' })
  },

  goToPublish: function () {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  changeSchool: function () {
    wx.navigateTo({ url: '/pages/school-select/school-select?change=1' })
  }
})
