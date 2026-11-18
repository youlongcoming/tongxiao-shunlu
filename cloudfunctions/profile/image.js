const ALLOWED_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) {
    return ''
  }
  const bytes = Buffer.from(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg'
  }
  if (bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png'
  }
  if (bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'webp'
  }
  return ''
}

function validateImageBuffer(buffer, maxBytes, label) {
  const limit = maxBytes || 2 * 1024 * 1024
  const name = label || '图片'
  if (!buffer || !buffer.length) {
    throw new Error(name + '文件为空')
  }
  if (buffer.length > limit) {
    throw new Error(name + '不能超过 2MB')
  }
  const type = detectImageType(buffer)
  if (!ALLOWED_TYPES[type]) {
    throw new Error(name + '仅支持 JPG、PNG 或 WebP 格式')
  }
  return { type: type, contentType: ALLOWED_TYPES[type] }
}

module.exports = {
  detectImageType: detectImageType,
  validateImageBuffer: validateImageBuffer
}
