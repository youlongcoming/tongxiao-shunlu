const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function dateLabel(value) {
  const parts = String(value || '').split('-')
  if (parts.length !== 3) {
    return String(value || '')
  }
  return Number(parts[1]) + '月' + String(Number(parts[2])).padStart(2, '0') + '日'
}

function publicUser(user) {
  return user ? {
    userId: user._id,
    name: user.name || '未命名同学',
    avatar: user.avatar || '',
    gender: user.gender || '不公开',
    grade: user.grade || '',
    major: user.major || '',
    bio: user.bio || ''
  } : null
}

async function getUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid: openid }).limit(1).get()
  return result.data[0] || null
}

async function getRide(rideId) {
  try {
    const result = await db.collection('rides').doc(rideId).get()
    return result.data || null
  } catch (error) {
    return null
  }
}

async function getMembers(rideId) {
  const result = await db.collection('ride_members').where({ rideId: rideId }).get()
  return result.data
}

function publicRide(ride, owner, memberCount, joined) {
  const passengerCount = Math.max(0, memberCount - 1)
  return {
    id: ride._id,
    isCloud: true,
    type: ride.type,
    direction: ride.direction,
    from: ride.from,
    to: ride.to,
    rawDate: ride.date,
    date: dateLabel(ride.date),
    time: ride.time,
    seats: Math.max(0, ride.seats - passengerCount),
    price: ride.price,
    note: ride.note,
    owner: owner && owner.name || ride.ownerName || '同学',
    memberCount: memberCount,
    joined: Boolean(joined),
    createdAt: ride.createdAt
  }
}

function validateRide(input) {
  const allowedTypes = ['找乘客', '找车主']
  const allowedDirections = ['出校', '返校', '周边']
  const ride = {
    type: cleanText(input.type, 10),
    direction: cleanText(input.direction, 10),
    from: cleanText(input.from, 30),
    to: cleanText(input.to, 30),
    date: cleanText(input.date, 10),
    time: cleanText(input.time, 5),
    seats: Math.max(1, Math.min(6, Number(input.seats) || 1)),
    price: Math.max(0, Math.min(999, Number(input.price) || 0)),
    ownerName: cleanText(input.owner, 16),
    note: cleanText(input.note, 120) || '发布者暂未填写补充说明。'
  }

  if (allowedTypes.indexOf(ride.type) === -1 || allowedDirections.indexOf(ride.direction) === -1) {
    throw new Error('行程类型无效')
  }
  if (!ride.from || !ride.to || !/^\d{4}-\d{2}-\d{2}$/.test(ride.date) || !/^\d{2}:\d{2}$/.test(ride.time)) {
    throw new Error('请填写完整的路线和时间')
  }
  return ride
}

exports.main = async function (event) {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const action = event.action
  const currentUser = await getUserByOpenid(openid)

  if (!currentUser) {
    return { ok: false, message: '请先重新进入小程序完成微信登录' }
  }

  if (action === 'publish') {
    let ride
    try {
      ride = validateRide(event.ride || {})
    } catch (error) {
      return { ok: false, message: error.message }
    }

    const created = await db.collection('rides').add({
      data: Object.assign({}, ride, {
        ownerOpenid: openid,
        status: 'active',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      })
    })
    await db.collection('ride_members').add({
      data: {
        rideId: created._id,
        userOpenid: openid,
        role: 'owner',
        joinedAt: db.serverDate()
      }
    })
    const stored = Object.assign({ _id: created._id }, ride)
    return { ok: true, ride: publicRide(stored, currentUser, 1, true) }
  }

  if (action === 'list') {
    const rideResult = await db.collection('rides').where({ status: 'active' }).get()
    const myMemberships = await db.collection('ride_members').where({ userOpenid: openid }).get()
    const myRideIds = myMemberships.data.map(function (item) { return item.rideId })
    const rides = []
    for (let i = 0; i < rideResult.data.length; i += 1) {
      const ride = rideResult.data[i]
      const owner = await getUserByOpenid(ride.ownerOpenid)
      const members = await getMembers(ride._id)
      rides.push(publicRide(ride, owner, members.length, myRideIds.indexOf(ride._id) !== -1))
    }
    rides.sort(function (a, b) {
      return String(a.rawDate + ' ' + a.time).localeCompare(String(b.rawDate + ' ' + b.time))
    })
    return { ok: true, rides: rides }
  }

  if (action === 'join') {
    const rideId = cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride || ride.status !== 'active') {
      return { ok: false, message: '该拼车团不存在或已结束' }
    }
    const members = await getMembers(rideId)
    const existing = members.find(function (item) { return item.userOpenid === openid })
    if (existing) {
      return { ok: true, joined: true }
    }
    const passengerCount = members.filter(function (item) { return item.role !== 'owner' }).length
    if (passengerCount >= ride.seats) {
      return { ok: false, message: '该行程座位已满' }
    }
    await db.collection('ride_members').add({
      data: {
        rideId: rideId,
        userOpenid: openid,
        role: 'member',
        joinedAt: db.serverDate()
      }
    })
    return { ok: true, joined: true }
  }

  if (action === 'getGroup') {
    const rideId = cleanText(event.rideId, 128)
    const ride = await getRide(rideId)
    if (!ride) {
      return { ok: false, message: '拼车团不存在' }
    }
    const memberships = await getMembers(rideId)
    const membership = memberships.find(function (item) { return item.userOpenid === openid })
    const owner = await getUserByOpenid(ride.ownerOpenid)
    const members = []
    if (membership) {
      for (let i = 0; i < memberships.length; i += 1) {
        const user = await getUserByOpenid(memberships[i].userOpenid)
        if (user) {
          members.push({
            membershipId: memberships[i]._id,
            role: memberships[i].role,
            isSelf: memberships[i].userOpenid === openid,
            user: publicUser(user)
          })
        }
      }
    }
    return {
      ok: true,
      joined: Boolean(membership),
      isOwner: ride.ownerOpenid === openid,
      ride: publicRide(ride, owner, memberships.length, Boolean(membership)),
      members: members
    }
  }

  if (action === 'listMyGroups') {
    const memberships = await db.collection('ride_members').where({ userOpenid: openid }).get()
    const rides = []
    for (let i = 0; i < memberships.data.length; i += 1) {
      const ride = await getRide(memberships.data[i].rideId)
      if (ride && ride.status === 'active') {
        const owner = await getUserByOpenid(ride.ownerOpenid)
        const members = await getMembers(ride._id)
        rides.push(publicRide(ride, owner, members.length, true))
      }
    }
    return { ok: true, rides: rides }
  }

  return { ok: false, message: '不支持的行程操作' }
}

// 新版服务保留旧入口文件，便于已部署函数平滑升级和快速回滚。
module.exports = require('./service')
