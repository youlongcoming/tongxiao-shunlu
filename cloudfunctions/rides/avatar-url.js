function createResolver(cloud, serviceName) {
  const pending = Object.create(null)

  return function resolveAvatarUrl(value) {
    const fileID = String(value || '').trim()
    if (!fileID || fileID.indexOf('cloud://') !== 0) {
      return Promise.resolve(fileID)
    }
    if (!pending[fileID]) {
      pending[fileID] = cloud.getTempFileURL({ fileList: [fileID] }).then(function (result) {
        const file = result && Array.isArray(result.fileList) ? result.fileList[0] : null
        if (!file || Number(file.status || 0) !== 0 || !file.tempFileURL) {
          return ''
        }
        return file.tempFileURL
      }).catch(function (error) {
        console.warn('[' + serviceName + '] avatar temporary URL failed:', error.errCode || error.message)
        return ''
      })
    }
    return pending[fileID]
  }
}

module.exports = { createResolver: createResolver }
