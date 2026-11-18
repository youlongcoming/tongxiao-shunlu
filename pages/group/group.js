const cloudService = require('../../utils/cloud')

function prepareMember(item) {
  const user = item.user || {}
  return Object.assign({}, item, {
    user: Object.assign({}, user, {
      initial: String(user.name || 'W').slice(0, 1),
      detail: [user.grade, user.major].filter(Boolean).join(' · ') || '同学'
    }),
    requestSent: false
  })
}

Page({
  data: {
    rideId: '',
    ride: null,
    members: [],
    joined: false,
    isOwner: false,
    actionLoading: false,
    loading: true,
    errorMessage: '',
    settlement: null,
    externalTrip: null,
    externalTripEditing: false,
    externalTripDraft: '',
    externalTripLoading: false
  },

  onLoad: function (options) {
    this.setData({ rideId: decodeURIComponent(options.rideId || '') })
    this.loadGroup()
  },

  onShow: function () {
    if (this.data.rideId && this.data.ride) {
      this.loadGroup()
    }
  },

  loadGroup: function () {
    const page = this
    const app = getApp()
    page.setData({ loading: true, errorMessage: '' })
    app.whenCloudReady().then(function (state) {
      if (!state.ready) {
        throw new Error('微信身份尚未连接')
      }
      return cloudService.rides('getGroup', { rideId: page.data.rideId })
    }).then(function (result) {
      page.setData({
        ride: result.ride,
        joined: result.joined,
        isOwner: result.isOwner,
        members: result.members.map(prepareMember),
        settlement: result.settlement || null,
        externalTrip: result.externalTrip || null,
        externalTripEditing: page.data.externalTripEditing,
        externalTripDraft: page.data.externalTripEditing ? page.data.externalTripDraft : '',
        loading: false
      })
      wx.setNavigationBarTitle({ title: result.ride.to + ' · 拼车团' })
    }).catch(function (error) {
      page.setData({ loading: false, errorMessage: error.message })
    })
  },

  startExternalTripEdit: function () {
    const page = this
    const draft = this.data.externalTrip ? this.data.externalTrip.url : ''
    page.setData({
      externalTripEditing: true,
      externalTripDraft: draft
    }, function () {
      if (!draft) {
        page.pasteExternalTrip()
      }
    })
  },

  cancelExternalTripEdit: function () {
    this.setData({
      externalTripEditing: false,
      externalTripDraft: '',
      externalTripLoading: false
    })
  },

  onExternalTripInput: function (event) {
    this.setData({ externalTripDraft: event.detail.value })
  },

  pasteExternalTrip: function () {
    const page = this
    wx.getClipboardData({
      success: function (result) {
        const value = String(result.data || '').trim()
        if (!value) {
          wx.showToast({ title: '剪贴板里没有链接', icon: 'none' })
          return
        }
        page.setData({ externalTripDraft: value })
        wx.showToast({ title: '已读取剪贴板', icon: 'none' })
      },
      fail: function () {
        wx.showToast({ title: '无法读取剪贴板，请手动粘贴', icon: 'none' })
      }
    })
  },

  saveExternalTrip: function () {
    const page = this
    const url = String(page.data.externalTripDraft || '').trim()
    if (!url) {
      wx.showToast({ title: '请先粘贴行程分享链接', icon: 'none' })
      return
    }
    if (page.data.externalTripLoading) {
      return
    }
    page.setData({ externalTripLoading: true })
    cloudService.rides('saveExternalTrip', {
      rideId: page.data.rideId,
      url: url
    }).then(function (result) {
      page.setData({
        externalTrip: result.externalTrip || null,
        externalTripEditing: false,
        externalTripDraft: '',
        externalTripLoading: false
      })
      wx.showToast({ title: '行程链接已同步', icon: 'success' })
    }).catch(function (error) {
      page.setData({ externalTripLoading: false })
      wx.showModal({
        title: '无法同步链接',
        content: error.message,
        showCancel: false
      })
    })
  },

  copyExternalTrip: function () {
    const trip = this.data.externalTrip
    if (!trip || !trip.url) {
      wx.showToast({ title: '发布人还没有同步链接', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: trip.url,
      success: function () {
        wx.showToast({ title: '行程链接已复制', icon: 'none' })
      }
    })
  },

  removeExternalTrip: function () {
    const page = this
    wx.showModal({
      title: '删除行程链接',
      content: '删除后同行人将看不到网约车行程链接，确定继续吗？',
      confirmColor: '#b4442a',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        cloudService.rides('removeExternalTrip', { rideId: page.data.rideId }).then(function () {
          page.setData({
            externalTrip: null,
            externalTripEditing: false,
            externalTripDraft: ''
          })
          wx.showToast({ title: '行程链接已删除', icon: 'success' })
        }).catch(function (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        })
      }
    })
  },

  externalTripHelp: function () {
    wx.showModal({
      title: '如何获取行程链接',
      content: '在滴滴或高德完成下单后，打开订单详情，点“分享行程”并复制链接。回到这里点“粘贴行程链接”，保存后同行人就能在拼车团里查看。\n\n小程序不提供司机联系、支付、开票和售后，实际服务以滴滴/高德为准。',
      showCancel: false
    })
  },

  joinGroup: function () {
    const page = this
    const ride = page.data.ride
    if (ride && ride.canJoin === false) {
      wx.showToast({ title: ride.started ? '行程已发车，不能再加入' : '该行程已满', icon: 'none' })
      return
    }
    page.setData({ loading: true })
    cloudService.rides('join', { rideId: page.data.rideId })
      .then(function () {
        wx.showToast({ title: '已加入拼车团', icon: 'success' })
        page.loadGroup()
      })
      .catch(function (error) {
        page.setData({ loading: false })
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
        wx.showToast({ title: error.message, icon: 'none' })
        if (error.code === 'RIDE_STARTED') {
          page.loadGroup()
        }
      })
  },

  addBuddy: function (event) {
    const page = this
    const userId = event.currentTarget.dataset.userId
    cloudService.social('sendGroupRequest', {
      rideId: page.data.rideId,
      targetUserId: userId,
      message: '我们在同一个拼车团，想和你成为搭子'
    }).then(function () {
      const members = page.data.members.map(function (item) {
        return item.user.userId === userId
          ? Object.assign({}, item, { requestSent: true })
          : item
      })
      page.setData({ members: members })
      wx.showToast({ title: '搭子申请已发送', icon: 'success' })
    }).catch(function (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  openGroupChat: function () {
    if (!this.data.joined) {
      wx.showToast({ title: '加入拼车团后才能群聊', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: '/pages/chat/chat?groupRideId=' + encodeURIComponent(this.data.rideId)
    })
  },

  editRide: function () {
    wx.navigateTo({
      url: '/pages/ride-edit/ride-edit?rideId=' + encodeURIComponent(this.data.rideId)
    })
  },

  confirmRideAction: function (event) {
    const page = this
    const action = event.currentTarget.dataset.action
    if (action === 'end') {
      wx.navigateTo({
        url: '/pages/settlement/settlement?rideId=' + encodeURIComponent(page.data.rideId) + '&mode=create'
      })
      return
    }
    const copy = {
      cancel: ['取消行程', '取消后行程下架，并自动删除临时拼车群及群消息；已经成为的搭子仍会保留。']
    }[action]
    if (!copy) {
      return
    }
    wx.showModal({
      title: copy[0],
      content: copy[1],
      confirmColor: '#b4442a',
      success: function (result) {
        if (result.confirm) {
          page.runRideAction(action)
        }
      }
    })
  },

  openSettlement: function () {
    wx.navigateTo({
      url: '/pages/settlement/settlement?rideId=' + encodeURIComponent(this.data.rideId)
    })
  },

  runRideAction: function (action) {
    const page = this
    page.setData({ actionLoading: true })
    cloudService.rides(action, { rideId: page.data.rideId }).then(function () {
      page.setData({ actionLoading: false })
      wx.showToast({ title: '操作已完成', icon: 'success' })
      page.loadGroup()
    }).catch(function (error) {
      page.setData({ actionLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  leaveGroup: function () {
    const page = this
    if (page.data.ride && page.data.ride.started) {
      wx.showToast({ title: '行程已发车，不能退出拼车团', icon: 'none' })
      return
    }
    wx.showModal({
      title: '退出拼车团',
      content: '退出后将不能查看成员和群聊消息，确定继续吗？',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        cloudService.rides('leave', { rideId: page.data.rideId }).then(function () {
          wx.showToast({ title: '已退出拼车团', icon: 'success' })
          setTimeout(function () { wx.navigateBack() }, 500)
        }).catch(function (error) {
          wx.showToast({ title: error.message, icon: 'none' })
          if (error.code === 'RIDE_STARTED') {
            page.loadGroup()
          }
        })
      }
    })
  },

  removeMember: function (event) {
    const page = this
    const userId = event.currentTarget.dataset.userId
    const name = event.currentTarget.dataset.name
    wx.showModal({
      title: '移除成员',
      content: '确定将 ' + name + ' 移出拼车团吗？',
      confirmColor: '#b4442a',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        cloudService.rides('removeMember', { rideId: page.data.rideId, targetUserId: userId }).then(function () {
          wx.showToast({ title: '成员已移除', icon: 'success' })
          page.loadGroup()
        }).catch(function (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        })
      }
    })
  }
})
