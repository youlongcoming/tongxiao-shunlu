const DEFAULT_PROFILE = {
  avatar: '',
  paymentCode: '',
  paymentCodeUrl: '',
  studentId: '',
  name: '',
  phone: '',
  gender: '不公开',
  grade: '大一',
  major: '',
  bio: ''
}

const cloudService = require('../../utils/cloud')
const schoolStore = require('../../utils/school')
const phoneHelper = require('../../utils/phone')

Page({
  data: {
    genders: ['男', '女', '不公开'],
    grades: ['大一', '大二', '大三', '大四', '研究生', '其他'],
    gradeIndex: 0,
    avatarText: '友',
    avatarDirty: false,
    paymentCodeUploading: false,
    saved: false,
    syncing: false,
    friendCode: '',
    cloudStatusType: 'pending',
    cloudStatusText: '正在连接微信身份',
    selectedSchool: null,
    profile: Object.assign({}, DEFAULT_PROFILE)
  },

  onShow: function () {
    const savedProfile = wx.getStorageSync('userProfile') || {}
    const profile = Object.assign({}, DEFAULT_PROFILE, savedProfile)
    const gradeIndex = Math.max(0, this.data.grades.indexOf(profile.grade))
    const avatarDirty = Boolean(profile.avatar && profile.avatar.indexOf('cloud://') !== 0)

    this.setData({
      profile: profile,
      gradeIndex: gradeIndex,
      avatarText: this.getAvatarText(profile.name),
      avatarDirty: avatarDirty,
      selectedSchool: schoolStore.getSelectedSchool(),
      saved: Boolean(savedProfile.name) && phoneHelper.isValidPhone(savedProfile.phone) && !avatarDirty
    })

    this.loadCloudProfile(profile)
  },

  loadCloudProfile: function (localProfile) {
    const page = this
    const app = getApp()

    app.whenCloudReady().then(function (cloudState) {
      if (!cloudState.ready) {
        page.setData({
          cloudStatusType: 'pending',
          cloudStatusText: '云函数待部署，本地资料仍可使用'
        })
        return
      }

      page.setData({
        cloudStatusType: 'syncing',
        cloudStatusText: '微信身份已连接，正在同步资料'
      })

      cloudService.getProfile().then(function (result) {
        const cloudProfile = result.profile
        if (cloudProfile && cloudProfile.name) {
          const profile = Object.assign({}, DEFAULT_PROFILE, cloudProfile)
          const pendingAvatar = page.data.avatarDirty ? page.data.profile.avatar : ''
          if (pendingAvatar) {
            profile.avatar = pendingAvatar
          }
          wx.setStorageSync('userProfile', profile)
          page.applyProfile(profile, !pendingAvatar)
          if (pendingAvatar) {
            page.setData({
              avatarDirty: true,
              saved: false,
              cloudStatusType: 'connected',
              cloudStatusText: '新头像已选择，点击保存后同步到云端'
            })
          }
          return
        }

        if (cloudProfile && cloudProfile.friendCode) {
          page.setData({ friendCode: cloudProfile.friendCode })
        }

        if (localProfile.name) {
          page.syncProfileToCloud(localProfile, false)
          return
        }

        page.setData({
          cloudStatusType: 'connected',
          cloudStatusText: '微信身份已连接，填写资料后将同步到云端'
        })
      }).catch(function (error) {
        page.setData({
          cloudStatusType: 'error',
          cloudStatusText: '云端资料暂时无法读取：' + error.message
        })
      })
    })
  },

  applyProfile: function (profile, cloudSynced) {
    const gradeIndex = Math.max(0, this.data.grades.indexOf(profile.grade))
    this.setData({
      profile: profile,
      friendCode: profile.friendCode || this.data.friendCode,
      gradeIndex: gradeIndex,
      avatarText: this.getAvatarText(profile.name),
      avatarDirty: false,
      saved: Boolean(profile.name) && phoneHelper.isValidPhone(profile.phone),
      cloudStatusType: cloudSynced ? 'connected' : this.data.cloudStatusType,
      cloudStatusText: cloudSynced ? '微信身份与云端资料已同步' : this.data.cloudStatusText
    })
  },

  copyFriendCode: function () {
    if (!this.data.friendCode) {
      wx.showToast({ title: '搭子码生成中', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.friendCode,
      success: function () {
        wx.showToast({ title: '搭子码已复制', icon: 'success' })
      }
    })
  },

  getAvatarText: function (name) {
    const cleanName = String(name || '').trim()
    return cleanName ? cleanName.slice(0, 1).toUpperCase() : '友'
  },

  changeSchool: function () {
    wx.navigateTo({ url: '/pages/school-select/school-select?change=1' })
  },

  chooseAvatar: function () {
    const page = this

    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: function (result) {
          page.persistAvatar(result.tempFiles[0].tempFilePath)
        }
      })
      return
    }

    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (result) {
        page.persistAvatar(result.tempFilePaths[0])
      }
    })
  },

  persistAvatar: function (tempFilePath) {
    const page = this

    function keepSelectedAvatar(avatarPath) {
      const profile = Object.assign({}, page.data.profile, { avatar: avatarPath })
      wx.setStorageSync('userProfile', profile)
      page.setData({
        profile: profile,
        avatarDirty: true,
        saved: false,
        cloudStatusType: page.data.cloudStatusType === 'syncing' ? 'connected' : page.data.cloudStatusType,
        cloudStatusText: '新头像已选择，点击保存后同步到云端'
      })
      wx.showToast({ title: '已选择，请点击保存', icon: 'none' })
    }

    wx.saveFile({
      tempFilePath: tempFilePath,
      success: function (result) {
        keepSelectedAvatar(result.savedFilePath)
      },
      fail: function () {
        keepSelectedAvatar(tempFilePath)
      }
    })
  },

  choosePaymentCode: function () {
    const page = this
    if (page.data.paymentCodeUploading) {
      return
    }

    function doUpload(localPath) {
      page.setData({ paymentCodeUploading: true })
      cloudService.uploadPaymentCode(localPath).then(function (result) {
        const profile = Object.assign({}, page.data.profile, {
          paymentCode: result.paymentCode,
          paymentCodeUrl: result.paymentCodeUrl
        })
        wx.setStorageSync('userProfile', profile)
        page.setData({
          profile: profile,
          paymentCodeUploading: false
        })
        wx.showToast({ title: '收款码已保存', icon: 'success' })
      }).catch(function (error) {
        page.setData({ paymentCodeUploading: false })
        wx.showModal({
          title: '收款码上传失败',
          content: error.message || '请稍后重试',
          showCancel: false
        })
      })
    }

    function confirmUpload(localPath) {
      wx.showModal({
        title: '确认上传收款码',
        content: '请确认这是你的收款码，不是付款码。付款码是出示给商家扣款的凭证，泄露可能被盗刷。收款码只会展示给同一结算行程的成员。',
        confirmText: '确认上传',
        cancelText: '重新选择',
        success: function (result) {
          if (result.confirm) {
            doUpload(localPath)
            return
          }
          page.choosePaymentCode()
        }
      })
    }

    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['original'],
        success: function (result) {
          confirmUpload(result.tempFiles[0].tempFilePath)
        }
      })
      return
    }

    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: function (result) {
        confirmUpload(result.tempFilePaths[0])
      }
    })
  },

  previewPaymentCode: function () {
    const url = this.data.profile.paymentCodeUrl
    if (!url) {
      wx.showToast({ title: '请先上传收款码', icon: 'none' })
      return
    }
    wx.previewImage({
      current: url,
      urls: [url]
    })
  },

  removePaymentCode: function () {
    const page = this
    wx.showModal({
      title: '删除收款码',
      content: '删除后，发布行程前需要重新上传；已经生成的结算单可能无法显示你的收款码。',
      confirmColor: '#b4442a',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        cloudService.removePaymentCode().then(function () {
          const profile = Object.assign({}, page.data.profile, {
            paymentCode: '',
            paymentCodeUrl: ''
          })
          wx.setStorageSync('userProfile', profile)
          page.setData({ profile: profile })
          wx.showToast({ title: '收款码已删除', icon: 'success' })
        }).catch(function (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        })
      }
    })
  },

  onInput: function (event) {
    const field = event.currentTarget.dataset.field
    let value = event.detail.value
    if (field === 'studentId') {
      value = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)
    } else if (field === 'phone') {
      value = phoneHelper.normalizePhone(value)
    }
    const update = { saved: false }
    update['profile.' + field] = value

    if (field === 'name') {
      update.avatarText = this.getAvatarText(value)
    }

    this.setData(update)
  },

  selectGender: function (event) {
    this.setData({
      'profile.gender': event.currentTarget.dataset.value,
      saved: false
    })
  },

  onGradeChange: function (event) {
    const gradeIndex = Number(event.detail.value)
    this.setData({
      gradeIndex: gradeIndex,
      'profile.grade': this.data.grades[gradeIndex],
      saved: false
    })
  },

  saveProfile: function () {
    const profile = Object.assign({}, this.data.profile, {
      studentId: String(this.data.profile.studentId || '').trim(),
      name: this.data.profile.name.trim(),
      phone: phoneHelper.normalizePhone(this.data.profile.phone),
      major: this.data.profile.major.trim(),
      bio: this.data.profile.bio.trim()
    })

    if (profile.studentId && !/^[A-Za-z0-9_-]{4,20}$/.test(profile.studentId)) {
      wx.showToast({ title: '学号格式不正确', icon: 'none' })
      return
    }

    if (!profile.name) {
      wx.showToast({ title: '请填写姓名或昵称', icon: 'none' })
      return
    }

    if (!phoneHelper.isValidPhone(profile.phone)) {
      wx.showToast({ title: '请输入正确的 11 位手机号', icon: 'none' })
      return
    }

    wx.setStorageSync('userProfile', profile)
    this.setData({ profile: profile, saved: true })
    this.syncProfileToCloud(profile, true)
  },

  syncProfileToCloud: function (profile, showFeedback) {
    const page = this
    const app = getApp()
    page.setData({ syncing: true })

    app.whenCloudReady().then(function (cloudState) {
      if (!cloudState.ready) {
        page.setData({
          syncing: false,
          cloudStatusType: 'pending',
          cloudStatusText: '资料已保存在本机，部署云函数后可同步'
        })
        if (showFeedback) {
          wx.showToast({ title: '已保存到本机', icon: 'success' })
        }
        return
      }

      const uploadPromise = profile.avatar
        ? cloudService.uploadAvatar(profile.avatar)
        : Promise.resolve('')

      uploadPromise.then(function (avatarFileId) {
        const cloudProfile = Object.assign({}, profile, { avatar: avatarFileId })
        return cloudService.saveProfile(cloudProfile).then(function () {
          wx.setStorageSync('userProfile', cloudProfile)
          page.applyProfile(cloudProfile, true)
          page.setData({ syncing: false })
          if (showFeedback) {
            wx.showToast({ title: '资料已云端保存', icon: 'success' })
          }
        })
      }).catch(function (error) {
        const message = error && error.message ? error.message : '请稍后重试'
        page.setData({
          syncing: false,
          cloudStatusType: 'error',
          cloudStatusText: '本地已保存，云端同步失败：' + message
        })
        if (showFeedback) {
          wx.showModal({
            title: '头像或资料同步失败',
            content: message,
            showCancel: false,
            confirmText: '知道了'
          })
        }
      })
    })
  }
})

