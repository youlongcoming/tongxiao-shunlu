const cloudService = require('../../utils/cloud')
const schoolStore = require('../../utils/school')

Page({
  data: {
    rideId: '',
    loading: true,
    saving: false,
    schoolName: '',
    directions: ['出校', '返校', '周边'],
    form: null
  },

  onLoad: function (options) {
    this.setData({ rideId: decodeURIComponent(options.rideId || '') })
    this.loadRide()
  },

  loadRide: function () {
    const page = this
    cloudService.rides('getGroup', { rideId: page.data.rideId }).then(function (result) {
      if (!result.isOwner || result.ride.status !== 'active') {
        throw new Error('只有发布者可以编辑进行中的行程')
      }
      const ride = result.ride
      const selectedSchool = schoolStore.getSelectedSchool()
      const schoolName = ride.schoolName || (selectedSchool && selectedSchool.name) || ''
      page.setData({
        loading: false,
        schoolName: schoolName,
        form: {
          type: ride.type,
          direction: ride.direction,
          from: ride.direction === '出校' ? schoolName : ride.from,
          to: ride.direction === '返校' ? schoolName : ride.to,
          date: ride.rawDate,
          time: ride.time,
          seats: ride.totalSeats,
          price: 0,
          owner: ride.owner,
          note: ride.note
        }
      })
    }).catch(function (error) {
      page.setData({ loading: false })
      wx.showModal({ title: '无法编辑', content: error.message, showCancel: false, success: function () { wx.navigateBack() } })
    })
  },

  selectValue: function (event) {
    const field = event.currentTarget.dataset.field
    if (field === 'direction') {
      this.changeDirection(event.currentTarget.dataset.value)
      return
    }
    const update = {}
    update['form.' + field] = event.currentTarget.dataset.value
    this.setData(update)
  },

  changeDirection: function (nextDirection) {
    const page = this
    const form = page.data.form
    const previousDirection = form.direction
    const schoolName = page.data.schoolName
    const update = { 'form.direction': nextDirection }
    if (previousDirection === '出校' && form.from === schoolName) {
      update['form.from'] = ''
    }
    if (previousDirection === '返校' && form.to === schoolName) {
      update['form.to'] = ''
    }
    if (nextDirection === '出校') {
      update['form.from'] = schoolName
    }
    if (nextDirection === '返校') {
      update['form.to'] = schoolName
    }
    page.setData(update)
  },

  goProfile: function () {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  onInput: function (event) {
    const update = {}
    update['form.' + event.currentTarget.dataset.field] = event.detail.value
    this.setData(update)
  },

  onDateChange: function (event) {
    this.setData({ 'form.date': event.detail.value })
  },

  onTimeChange: function (event) {
    this.setData({ 'form.time': event.detail.value })
  },

  changeSeats: function (event) {
    this.setData({
      'form.seats': Math.max(1, Math.min(6, Number(this.data.form.seats) + Number(event.currentTarget.dataset.delta)))
    })
  },

  saveRide: function () {
    const page = this
    const form = page.data.form
    if (!String(form.owner || '').trim()) {
      wx.showModal({
        title: '请先填写称呼',
        content: '发布人称呼自动使用“我的”页面名称，请先补充姓名或昵称。',
        confirmText: '去填写',
        success: function (result) {
          if (result.confirm) {
            wx.switchTab({ url: '/pages/profile/profile' })
          }
        }
      })
      return
    }
    if (!form.from.trim() || !form.to.trim()) {
      wx.showToast({ title: '请填写完整路线', icon: 'none' })
      return
    }
    page.setData({ saving: true })
    cloudService.rides('update', { rideId: page.data.rideId, ride: form }).then(function () {
      wx.showToast({ title: '行程已更新', icon: 'success' })
      setTimeout(function () { wx.navigateBack() }, 600)
    }).catch(function (error) {
      page.setData({ saving: false })
      if (error.code === 'PROFILE_NAME_REQUIRED') {
        wx.showModal({
          title: '请先填写称呼',
          content: '编辑行程前需要在“我的”页面填写姓名或昵称。',
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
    })
  }
})
