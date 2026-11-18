// 替换成自己的微信云开发环境 ID；不要把真实环境 ID 提交到公开仓库。
const ENV_ID = 'YOUR_CLOUD_ENV_ID'

let initialized = false

function isAvailable() {
  return Boolean(wx.cloud)
}

function init() {
  if (!isAvailable() || initialized) {
    return
  }

  wx.cloud.init({
    env: ENV_ID,
    traceUser: true
  })
  initialized = true
}

function callFunction(name, data) {
  if (!isAvailable()) {
    return Promise.reject(new Error('当前基础库不支持云开发'))
  }

  init()
  return wx.cloud.callFunction({
    name: name,
    data: data || {}
  }).then(function (response) {
    const result = response.result || {}
    if (result.ok === false) {
      const error = new Error(result.message || '云端操作失败')
      error.code = result.code || 'CLOUD_OPERATION_FAILED'
      error.data = result
      throw error
    }
    return result
  })
}

function login() {
  return callFunction('login')
}

function getProfile() {
  return callFunction('profile', { action: 'get' })
}

function saveProfile(profile) {
  return callFunction('profile', {
    action: 'save',
    profile: profile
  })
}

function setSchool(school) {
  return callFunction('profile', {
    action: 'setSchool',
    school: school
  })
}

function getImageMeta(localPath) {
  return Promise.all([
    new Promise(function (resolve, reject) {
      wx.getFileInfo({
        filePath: localPath,
        success: resolve,
        fail: reject
      })
    }),
    new Promise(function (resolve, reject) {
      wx.getImageInfo({
        src: localPath,
        success: resolve,
        fail: reject
      })
    })
  ]).then(function (results) {
    const fileInfo = results[0]
    const imageInfo = results[1]
    const type = String(imageInfo.type || '').toLowerCase()
    if (Number(fileInfo.size || 0) > 2 * 1024 * 1024) {
      throw new Error('图片不能超过 2MB')
    }
    if (['jpg', 'jpeg', 'png', 'webp'].indexOf(type) === -1) {
      throw new Error('图片仅支持 JPG、PNG 或 WebP 格式')
    }
    return { extension: type === 'jpeg' ? 'jpg' : type }
  })
}

function compressAvatarIfNeeded(localPath) {
  if (!wx.compressImage) {
    return Promise.resolve(localPath)
  }

  return new Promise(function (resolve) {
    wx.getFileInfo({
      filePath: localPath,
      success: function (fileInfo) {
        if (Number(fileInfo.size || 0) <= 1024 * 1024) {
          resolve(localPath)
          return
        }
        wx.compressImage({
          src: localPath,
          quality: 70,
          success: function (result) {
            resolve(result.tempFilePath || localPath)
          },
          fail: function () {
            resolve(localPath)
          }
        })
      },
      fail: function () {
        resolve(localPath)
      }
    })
  })
}

function uploadAvatar(localPath) {
  if (!localPath || localPath.indexOf('cloud://') === 0) {
    return Promise.resolve(localPath)
  }

  init()
  let uploadedFileId = ''
  let uploadPath = localPath
  return compressAvatarIfNeeded(localPath).then(function (preparedPath) {
    uploadPath = preparedPath
    return getImageMeta(uploadPath)
  }).then(function (meta) {
    return callFunction('profile', { action: 'prepareAvatar', extension: meta.extension })
  }).then(function (prepared) {
    return wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: uploadPath })
  }).then(function (result) {
    uploadedFileId = result.fileID
    return callFunction('profile', { action: 'commitAvatar', fileID: uploadedFileId })
  }).then(function (result) {
    return result.avatar
  }).catch(function (error) {
    if (uploadedFileId) {
      wx.cloud.deleteFile({ fileList: [uploadedFileId] }).catch(function () {})
    }
    throw error
  })
}

function uploadPaymentCode(localPath) {
  if (!localPath) {
    return Promise.reject(new Error('请选择收款码图片'))
  }

  init()
  let uploadedFileId = ''
  return getImageMeta(localPath).then(function (meta) {
    return callFunction('profile', { action: 'preparePaymentCode', extension: meta.extension })
  }).then(function (prepared) {
    return wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: localPath })
  }).then(function (result) {
    uploadedFileId = result.fileID
    return callFunction('profile', { action: 'commitPaymentCode', fileID: uploadedFileId })
  }).then(function (result) {
    return {
      paymentCode: result.paymentCode,
      paymentCodeUrl: result.paymentCodeUrl || ''
    }
  }).catch(function (error) {
    if (uploadedFileId) {
      wx.cloud.deleteFile({ fileList: [uploadedFileId] }).catch(function () {})
    }
    throw error
  })
}

function removePaymentCode() {
  return callFunction('profile', { action: 'removePaymentCode' })
}

function social(action, data) {
  return callFunction('social', Object.assign({ action: action }, data || {}))
}

function chat(action, data) {
  return callFunction('chat', Object.assign({ action: action }, data || {}))
}

function rides(action, data) {
  return callFunction('rides', Object.assign({ action: action }, data || {}))
}

module.exports = {
  ENV_ID: ENV_ID,
  chat: chat,
  getProfile: getProfile,
  init: init,
  isAvailable: isAvailable,
  login: login,
  removePaymentCode: removePaymentCode,
  rides: rides,
  saveProfile: saveProfile,
  setSchool: setSchool,
  social: social,
  uploadAvatar: uploadAvatar,
  uploadPaymentCode: uploadPaymentCode
}

