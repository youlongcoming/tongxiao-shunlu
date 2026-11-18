const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000

function toTimestamp(value) {
  if (!value) {
    return 0
  }
  if (value instanceof Date) {
    return value.getTime()
  }
  if (typeof value === 'object' && value.$date) {
    return new Date(value.$date).getTime()
  }
  return new Date(value).getTime() || 0
}

function monthKey(timestamp) {
  const chinaDate = new Date(Number(timestamp) + CHINA_OFFSET_MS)
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, '0')
  return chinaDate.getUTCFullYear() + '-' + month
}

function nextMonthStart(timestamp) {
  const chinaDate = new Date(Number(timestamp) + CHINA_OFFSET_MS)
  const nextMonthUtc = Date.UTC(chinaDate.getUTCFullYear(), chinaDate.getUTCMonth() + 1, 1) - CHINA_OFFSET_MS
  return new Date(nextMonthUtc).toISOString()
}

function formatChinaMonthDay(isoString) {
  const timestamp = toTimestamp(isoString)
  const chinaDate = new Date(timestamp + CHINA_OFFSET_MS)
  return (chinaDate.getUTCMonth() + 1) + '月' + chinaDate.getUTCDate() + '日'
}

function buildSchoolChangePolicy(user, timestamp) {
  const source = user || {}
  const now = Number(timestamp) || Date.now()
  const hasSchool = /^\d{10}$/.test(String(source.schoolId || ''))
  const changedAt = toTimestamp(source.schoolChangedAt)
  const changedMonth = String(source.schoolChangeMonth || '') || (changedAt ? monthKey(changedAt) : '')
  const changedThisMonth = hasSchool && changedMonth === monthKey(now)
  const nextAvailableAt = changedThisMonth ? nextMonthStart(now) : ''

  return {
    canChange: !changedThisMonth,
    changedThisMonth: changedThisMonth,
    nextAvailableAt: nextAvailableAt,
    message: !hasSchool
      ? '首次选择学校不受更换次数限制'
      : changedThisMonth
        ? '本月更换次数已用完，下次可于' + formatChinaMonthDay(nextAvailableAt) + '更换'
        : '本月还可以更换 1 次学校'
  }
}

module.exports = {
  buildSchoolChangePolicy: buildSchoolChangePolicy,
  monthKey: monthKey,
  nextMonthStart: nextMonthStart
}
