function pad(number) {
  return number < 10 ? '0' + number : String(number)
}

const MIN_LEAD_MINUTES = 30

function getDefaultDeparture() {
  const date = new Date(Date.now() + MIN_LEAD_MINUTES * 60 * 1000)
  return {
    date: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    time: pad(date.getHours()) + ':' + pad(date.getMinutes())
  }
}

const INITIAL_DEPARTURE = getDefaultDeparture()
const cloudService = require('../../utils/cloud')
const schoolStore = require('../../utils/school')

Page({
  data: {
    directions: ['出校', '返校', '周边'],
    schoolName: '',
    cloudConnected: false,
    submitting: false,
    dateTouched: false,
    timeTouched: false,
    form: {
      type: '找乘客',
      direction: '出校',
      from: '',
      to: '',
      date: INITIAL_DEPARTURE.date,
      time: INITIAL_DEPARTURE.time,
      seats: 1,
      price: 0,
      owner: '',
      note: ''
    }
  },

  onShow: function () {
    const page = this
    const school = schoolStore.getSelectedSchool()
    if (!school) {
      wx.reLaunch({ url: '/pages/school-select/school-select' })
      return
    }
    const previousSchoolName = page.data.schoolName
    const update = { schoolName: school.name }
    const now = getDefaultDeparture()
    if (!page.data.dateTouched) {
      update['form.date'] = now.date
    }
    if (!page.data.timeTouched) {
      update['form.time'] = now.time
    }
    const profile = wx.getStorageSync('userProfile') || {}
    if (profile.name) {
      update['form.owner'] = String(profile.name).trim()
    }
    if (page.data.form.direction === '出校' && (!page.data.form.from || page.data.form.from === previousSchoolName)) {
      update['form.from'] = school.name
    }
    if (page.data.form.direction === '返校' && (!page.data.form.to || page.data.form.to === previousSchoolName)) {
      update['form.to'] = school.name
    }
    page.setData(update)
    getApp().whenCloudReady().then(function (state) {
      page.setData({ cloudConnected: Boolean(state.ready) })
    })
  },

  selectDirection: function (event) {
    const page = this
    const nextDirection = event.currentTarget.dataset.value
    const previousDirection = page.data.form.direction
    const schoolName = page.data.schoolName
    const update = { 'form.direction': nextDirection }
    if (previousDirection === '出校' && page.data.form.from === schoolName) {
      update['form.from'] = ''
    }
    if (previousDirection === '返校' && page.data.form.to === schoolName) {
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
    const field = event.currentTarget.dataset.field
    const update = {}
    update['form.' + field] = event.detail.value
    this.setData(update)
  },

  onDateChange: function (event) {
    this.setData({
      'form.date': event.detail.value,
      dateTouched: true
    })
  },

  onTimeChange: function (event) {
    this.setData({
      'form.time': event.detail.value,
      timeTouched: true
    })
  },

  changeSeats: function (event) {
    const delta = Number(event.currentTarget.dataset.delta)
    const seats = Math.max(1, Math.min(6, this.data.form.seats + delta))
    this.setData({ 'form.seats': seats })
  },

  submitRide: function () {
    const page = this
    let form = page.data.form
    const now = getDefaultDeparture()
    if (!page.data.dateTouched || !page.data.timeTouched) {
      form = Object.assign({}, form)
      if (!page.data.dateTouched) {
        form.date = now.date
      }
      if (!page.data.timeTouched) {
        form.time = now.time
      }
      page.setData({ form: form })
    }
    if (!String(form.owner || '').trim()) {
      wx.showModal({
        title: '请先填写称呼',
        content: '发布人称呼会自动使用“我的”页面名称，请先补充姓名或昵称。',
        confirmText: '去填写',
        success: function (result) {
          if (result.confirm) {
            wx.switchTab({ url: '/pages/profile/profile' })
          }
        }
      })
      return
    }
    const requiredFields = [form.from, form.to, form.owner]
    const isComplete = requiredFields.every(function (value) {
      return String(value).trim().length > 0
    })

    if (!isComplete) {
      wx.showToast({ title: '请填写完整的必填信息', icon: 'none' })
      return
    }

    page.setData({ submitting: true })
    getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        page.setData({ submitting: false })
        wx.showModal({
          title: '暂时无法发布',
          content: '微信云服务当前不可用，请稍后重试。行程不会保存为本地数据。',
          showCancel: false
        })
        return
      }
      return cloudService.rides('publish', { ride: form })
        .then(function (result) {
          page.setData({ submitting: false, dateTouched: false, timeTouched: false })
          wx.showToast({ title: '云端发布成功', icon: 'success' })
          setTimeout(function () {
            wx.navigateTo({
              url: '/pages/group/group?rideId=' + encodeURIComponent(result.ride.id)
            })
          }, 700)
        })
        .catch(function (error) {
          page.setData({ submitting: false })
          if (error.code === 'PHONE_REQUIRED') {
            wx.showModal({
              title: '请先填写手机号',
              content: '发布行程前需要在“我的”页面填写并云端保存手机号，方便拼车成员快速联系。',
              confirmText: '去填写',
              success: function (result) {
                if (result.confirm) {
                  wx.switchTab({ url: '/pages/profile/profile' })
                }
              }
            })
            return
          }
          if (error.code === 'PROFILE_NAME_REQUIRED') {
            wx.showModal({
              title: '请先填写称呼',
              content: '发布行程前需要在“我的”页面填写姓名或昵称，发布人称呼会自动使用该名称。',
              confirmText: '去填写',
              success: function (result) {
                if (result.confirm) {
                  wx.switchTab({ url: '/pages/profile/profile' })
                }
              }
            })
            return
          }
          if (error.code === 'PAYMENT_CODE_REQUIRED') {
            wx.showModal({
              title: '请先上传收款码',
              content: '发布行程前需要在“我的”页面上传收款码，行程结束后用它向同行人收取平摊的车费。',
              confirmText: '去上传',
              success: function (result) {
                if (result.confirm) {
                  wx.switchTab({ url: '/pages/profile/profile' })
                }
              }
            })
            return
          }
          wx.showModal({
            title: '云端发布失败',
            content: error.message || '请稍后重试，当前行程没有被保存。',
            showCancel: false
          })
        })
    })
  }
})

