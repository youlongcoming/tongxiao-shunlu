const STORAGE_KEY = 'selectedSchool'

function normalizeSchool(value) {
  const school = value || {}
  const id = String(school.id || school.schoolId || '').trim()
  const name = String(school.name || school.schoolName || '').trim()
  if (!/^\d{10}$/.test(id) || !name) {
    return null
  }
  return {
    id: id,
    name: name.slice(0, 60),
    province: String(school.province || school.schoolProvince || '').trim().slice(0, 20),
    city: String(school.city || school.schoolCity || '').trim().slice(0, 30),
    level: String(school.level || school.schoolLevel || '').trim().slice(0, 12)
  }
}

function getSelectedSchool() {
  return normalizeSchool(wx.getStorageSync(STORAGE_KEY))
}

function setSelectedSchool(school) {
  const normalized = normalizeSchool(school)
  if (!normalized) {
    throw new Error('学校信息无效')
  }
  wx.setStorageSync(STORAGE_KEY, normalized)
  return normalized
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  getSelectedSchool: getSelectedSchool,
  normalizeSchool: normalizeSchool,
  setSelectedSchool: setSelectedSchool
}
