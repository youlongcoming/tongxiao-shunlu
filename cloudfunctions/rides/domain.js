const crypto = require('crypto')

const SETTLEMENT_GRACE_MS = 24 * 60 * 60 * 1000

const EXTERNAL_TRIP_PROVIDERS = [
  {
    id: 'didi',
    label: '滴滴',
    domains: ['didiglobal.com', 'didichuxing.com', 'xiaojukeji.com', 'udache.com', '99taxis.mobi']
  },
  {
    id: 'amap',
    label: '高德',
    domains: ['amap.com', 'autonavi.com']
  }
]

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function hostMatches(host, domain) {
  return host === domain || host.slice(-(domain.length + 1)) === '.' + domain
}

function validateExternalTripUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) {
    throw new Error('请粘贴行程分享链接')
  }
  if (raw.length > 2048) {
    throw new Error('行程分享链接过长')
  }

  const urlMatch = raw.match(/https:\/\/[^\s<>"']+/i)
  const candidate = urlMatch
    ? urlMatch[0].replace(/[),，。；;]+$/, '')
    : raw

  let parsed
  try {
    parsed = new URL(candidate)
  } catch (error) {
    throw new Error('行程分享链接格式不正确')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('请使用 https 开头的行程分享链接')
  }
  if (parsed.username || parsed.password) {
    throw new Error('行程分享链接不能包含账号信息')
  }
  if (parsed.port) {
    throw new Error('行程分享链接不能包含自定义端口')
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const provider = EXTERNAL_TRIP_PROVIDERS.find(function (item) {
    return item.domains.some(function (domain) { return hostMatches(host, domain) })
  })
  if (!provider) {
    throw new Error('仅支持滴滴或高德的官方行程分享链接')
  }

  return {
    url: parsed.toString(),
    provider: provider.id,
    providerLabel: provider.label,
    host: host
  }
}

function parseRideDate(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(time || ''))
  if (!match || !timeMatch) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  if (month < 1 || month > 12 || hour > 23 || minute > 59) {
    return null
  }
  const dateOnly = new Date(Date.UTC(year, month - 1, day))
  if (dateOnly.getUTCFullYear() !== year || dateOnly.getUTCMonth() !== month - 1 || dateOnly.getUTCDate() !== day) {
    return null
  }
  // 行程时间固定解释为中国标准时间，避免云函数 UTC 时区导致提前 8 小时过期。
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0))
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function cstNowParts(now) {
  const current = now === undefined
    ? Date.now()
    : (now instanceof Date ? now.getTime() : Number(now))
  const shifted = new Date(current + 8 * 60 * 60 * 1000)
  return {
    date: shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate()),
    time: pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes())
  }
}

function cstDateString(now) {
  return cstNowParts(now).date
}

function cstTimeString(now) {
  return cstNowParts(now).time
}

function hasStarted(ride, now) {
  const departure = parseRideDate(ride && ride.date, ride && ride.time)
  if (!departure) {
    return true
  }
  const current = now === undefined
    ? Date.now()
    : (now instanceof Date ? now.getTime() : Number(now))
  return current >= departure.getTime()
}

function isRideExpired(ride, now) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ride && ride.date || ''))
  if (!match) {
    return true
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const dateOnly = new Date(Date.UTC(year, month - 1, day))
  if (dateOnly.getUTCFullYear() !== year || dateOnly.getUTCMonth() !== month - 1 || dateOnly.getUTCDate() !== day) {
    return true
  }
  const current = now === undefined
    ? Date.now()
    : (now instanceof Date ? now.getTime() : Number(now))
  // 行程在出发日当天结束前一直有效；次日 00:00 后仍保留 24 小时用于补结算，
  // 列表按出发日期隐藏，但拼车团和结算入口仍可访问。
  const expiresAt = Date.UTC(year, month - 1, day, 16, 0, 0) + SETTLEMENT_GRACE_MS
  return current >= expiresAt
}

function validateRide(input, options) {
  const allowedTypes = ['找乘客', '找车主']
  const allowedDirections = ['出校', '返校', '周边']
  const ride = {
    type: cleanText(input && input.type, 10),
    direction: cleanText(input && input.direction, 10),
    from: cleanText(input && input.from, 30),
    to: cleanText(input && input.to, 30),
    date: cleanText(input && input.date, 10),
    time: cleanText(input && input.time, 5),
    seats: Math.max(1, Math.min(6, Number(input && input.seats) || 1)),
    price: Math.max(0, Math.min(999, Number(input && input.price) || 0)),
    ownerName: cleanText(input && input.owner, 16),
    note: cleanText(input && input.note, 120) || '发布者暂未填写补充说明。'
  }

  if (allowedTypes.indexOf(ride.type) === -1 || allowedDirections.indexOf(ride.direction) === -1) {
    throw new Error('行程类型无效')
  }
  if (!ride.from || !ride.to || !ride.ownerName) {
    throw new Error('请填写完整的路线和称呼')
  }
  const departure = parseRideDate(ride.date, ride.time)
  if (!departure) {
    throw new Error('出发日期或时间无效')
  }
  return ride
}

function stableId(prefix, parts) {
  const digest = crypto.createHash('sha256').update(parts.join(':')).digest('hex')
  return prefix + digest.slice(0, 40)
}

function membershipId(rideId, openid) {
  return stableId('rm_', [rideId, openid])
}

function conversationIdForRide(rideId) {
  return stableId('rg_', [rideId])
}

function pageOptions(input, defaultLimit) {
  const page = Math.max(1, Math.min(10000, Number(input && input.page) || 1))
  const limit = Math.max(1, Math.min(30, Number(input && input.limit) || defaultLimit || 10))
  return { page: page, limit: limit, skip: (page - 1) * limit }
}

module.exports = {
  SETTLEMENT_GRACE_MS: SETTLEMENT_GRACE_MS,
  cleanText: cleanText,
  conversationIdForRide: conversationIdForRide,
  cstDateString: cstDateString,
  cstNowParts: cstNowParts,
  cstTimeString: cstTimeString,
  hasStarted: hasStarted,
  isRideExpired: isRideExpired,
  membershipId: membershipId,
  pageOptions: pageOptions,
  parseRideDate: parseRideDate,
  stableId: stableId,
  validateExternalTripUrl: validateExternalTripUrl,
  validateRide: validateRide
}
