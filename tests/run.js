const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce(function (files, entry) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      return files.concat(walk(fullPath))
    }
    return entry.isFile() ? files.concat(fullPath) : files
  }, [])
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function testJsonFiles() {
  walk(root).filter(function (file) { return file.endsWith('.json') }).forEach(function (file) {
    assert.doesNotThrow(function () { JSON.parse(fs.readFileSync(file, 'utf8')) }, 'JSON 无法解析：' + file)
  })
}

function testPages() {
  const app = JSON.parse(read('app.json'))
  app.pages.forEach(function (pagePath) {
    ;['.js', '.json', '.wxml', '.wxss'].forEach(function (extension) {
      assert.ok(fs.existsSync(path.join(root, pagePath + extension)), '页面文件缺失：' + pagePath + extension)
    })

    const wxml = read(pagePath + '.wxml')
    const javascript = read(pagePath + '.js')
    const bindingPattern = /(?:bind|catch)(?:tap|input|change|confirm|chooseavatar|longpress)="([A-Za-z_$][\w$]*)"/g
    let match
    while ((match = bindingPattern.exec(wxml))) {
      const handlerPattern = new RegExp('\\b' + match[1].replace(/[$]/g, '\\$&') + '\\s*:\\s*function\\b')
      assert.ok(handlerPattern.test(javascript), pagePath + ' 缺少事件处理函数：' + match[1])
    }
  })
}

function testPrivateSitemap() {
  const sitemap = JSON.parse(read('sitemap.json'))
  const denied = sitemap.rules.filter(function (rule) { return rule.action === 'disallow' }).map(function (rule) { return rule.page })
  ;['pages/school-select/school-select', 'pages/chat/chat', 'pages/group/group', 'pages/settlement/settlement', 'pages/messages/messages', 'pages/profile/profile', 'pages/ride-edit/ride-edit'].forEach(function (page) {
    assert.ok(denied.indexOf(page) !== -1, '私有页面未禁止索引：' + page)
  })
}

function testRideDomain() {
  const domain = require(path.join(root, 'cloudfunctions/rides/domain'))
  const parsed = domain.parseRideDate('2026-11-10', '08:00')
  assert.strictEqual(parsed.toISOString(), '2026-11-10T00:00:00.000Z', '行程时间必须按中国标准时间解释')
  assert.strictEqual(domain.parseRideDate('2026-02-30', '08:00'), null)
  assert.strictEqual(domain.isRideExpired({ date: '2000-01-01', time: '00:00' }), true)
  const dayNow = Date.parse('2026-11-12T04:05:00Z')
  assert.strictEqual(domain.isRideExpired({ date: '2026-11-12', time: '00:01' }, dayNow), false, '当天行程不应按分钟过期')
  assert.strictEqual(domain.isRideExpired({ date: '2026-11-11', time: '23:59' }, dayNow), false, '前一天行程应保留 24 小时补结算窗口')
  assert.strictEqual(domain.isRideExpired({ date: '2026-11-11', time: '23:59' }, Date.parse('2026-11-12T16:00:00Z')), true, '补结算窗口结束后应过期')
  assert.strictEqual(domain.isRideExpired({ date: '2026-11-10', time: '08:00' }, dayNow), true, '超过补结算窗口的行程应过期')
  assert.strictEqual(domain.isRideExpired({ date: '2026-11-13', time: '00:00' }, dayNow), false, '未来日期行程应有效')
  assert.strictEqual(domain.cstDateString(Date.parse('2026-11-11T16:30:00Z')), '2026-11-12', '中国时间跨夜后应进入次日')
  assert.strictEqual(domain.cstTimeString(Date.parse('2026-11-11T16:30:00Z')), '00:30', '中国时间应换算到东八区')
  assert.strictEqual(domain.hasStarted({ date: '2026-11-12', time: '08:00' }, Date.parse('2026-11-12T00:30:00Z')), true, '出发时刻后应判定为已发车')
  assert.strictEqual(domain.hasStarted({ date: '2026-11-12', time: '09:00' }, Date.parse('2026-11-12T00:30:00Z')), false, '出发时刻前不应判定为已发车')
  assert.strictEqual(domain.hasStarted({ date: '2026-11-12', time: '08:00' }, Date.parse('2026-11-12T00:00:00Z')), true, '出发时刻当刻即视为已发车')
  assert.doesNotThrow(function () {
    domain.validateRide({
      type: '找乘客', direction: '出校', from: '本校校园', to: '高铁站',
      date: '2099-01-01', time: '08:00', seats: 2, price: 20, owner: '测试用户'
    })
  })
  assert.doesNotThrow(function () {
    domain.validateRide({
      type: '找乘客', direction: '出校', from: '本校校园', to: '高铁站',
      date: '2000-01-01', time: '08:00', seats: 2, price: 20, owner: '测试用户'
    })
  }, '不再限制出发时间必须晚于当前时间')
  assert.strictEqual(domain.membershipId('ride-a', 'openid-a'), domain.membershipId('ride-a', 'openid-a'))

  const didiTrip = domain.validateExternalTripUrl('https://dc.didiglobal.com/share/trip?order=1')
  assert.strictEqual(didiTrip.provider, 'didi')
  assert.strictEqual(didiTrip.providerLabel, '滴滴')
  assert.strictEqual(didiTrip.host, 'dc.didiglobal.com')
  const amapTrip = domain.validateExternalTripUrl('https://m.amap.com/share/trip?order=1')
  assert.strictEqual(amapTrip.provider, 'amap')
  assert.strictEqual(amapTrip.providerLabel, '高德')
  const textTrip = domain.validateExternalTripUrl('点击查看行程 https://dc.didiglobal.com/share/trip?order=1 。')
  assert.strictEqual(textTrip.provider, 'didi')
  assert.throws(function () { domain.validateExternalTripUrl('http://dc.didiglobal.com/share/trip') }, /https/)
  assert.throws(function () { domain.validateExternalTripUrl('https://example.com/share/trip') }, /仅支持/)
  assert.throws(function () { domain.validateExternalTripUrl('https://didiglobal.com.evil.example/share') }, /仅支持/)
  assert.throws(function () { domain.validateExternalTripUrl('') }, /请粘贴/)

  const settlement = require(path.join(root, 'cloudfunctions/rides/settlement'))
  assert.strictEqual(settlement.parseAmountToFen('86.50'), 8650, '车费必须转换为分')
  assert.throws(function () { settlement.parseAmountToFen('0') }, /大于 0/)
  assert.throws(function () { settlement.parseAmountToFen('12.345') }, /两位小数/)
  const shares = settlement.buildShares(8650, [
    { openid: 'a', role: 'owner' },
    { openid: 'b', role: 'member' },
    { openid: 'c', role: 'member' },
    { openid: 'd', role: 'member' }
  ])
  assert.deepStrictEqual(shares.map(function (item) { return item.shareFen }), [2163, 2163, 2162, 2162], '车费尾差必须完整分配')
  assert.strictEqual(shares[0].status, 'owner')
  assert.strictEqual(shares[1].status, 'pending')
  assert.strictEqual(settlement.allConfirmed({ participants: shares }), false)
  shares.forEach(function (item) { if (item.role !== 'owner') { item.status = 'confirmed' } })
  assert.strictEqual(settlement.allConfirmed({ participants: shares }), true)
}

function testAvatarValidation() {
  const image = require(path.join(root, 'cloudfunctions/profile/image'))
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.strictEqual(image.detectImageType(pngHeader), 'png')
  assert.throws(function () { image.validateImageBuffer(Buffer.from('not an image')) }, /仅支持/)
  assert.throws(function () { image.validateImageBuffer(Buffer.alloc(2 * 1024 * 1024 + 1)) }, /2MB/)
}

async function testPrivateAvatarResolver() {
  const helperPaths = [
    'cloudfunctions/chat/avatar-url.js',
    'cloudfunctions/social/avatar-url.js',
    'cloudfunctions/rides/avatar-url.js'
  ]
  const canonical = read(helperPaths[0])
  helperPaths.slice(1).forEach(function (helperPath) {
    assert.strictEqual(read(helperPath), canonical, '三个云函数的私有头像解析逻辑必须保持一致：' + helperPath)
  })

  let calls = 0
  const helper = require(path.join(root, helperPaths[0]))
  const resolveAvatar = helper.createResolver({
    getTempFileURL: function (request) {
      calls += 1
      return Promise.resolve({
        fileList: [{
          fileID: request.fileList[0],
          status: 0,
          tempFileURL: 'https://example.test/private-avatar.jpg'
        }]
      })
    }
  }, 'test')

  assert.strictEqual(await resolveAvatar('https://example.test/public.jpg'), 'https://example.test/public.jpg')
  assert.strictEqual(await resolveAvatar('cloud://example/private.jpg'), 'https://example.test/private-avatar.jpg')
  assert.strictEqual(await resolveAvatar('cloud://example/private.jpg'), 'https://example.test/private-avatar.jpg')
  assert.strictEqual(calls, 1, '同一次云函数调用内相同头像只应换取一次临时链接')
}

function testSchoolChangePolicy() {
  const policy = require(path.join(root, 'cloudfunctions/profile/school-change'))
  const november = Date.parse('2026-11-20T04:00:00.000Z')
  const december = Date.parse('2026-12-01T04:00:00.000Z')

  assert.strictEqual(policy.buildSchoolChangePolicy({}, november).canChange, true, '首次选校不应受换校次数限制')
  assert.strictEqual(policy.buildSchoolChangePolicy({ schoolId: '4133016405' }, november).canChange, true, '未在本月换校的老用户应可更换一次')

  const changed = policy.buildSchoolChangePolicy({
    schoolId: '4133016405',
    schoolChangeMonth: '2026-11'
  }, november)
  assert.strictEqual(changed.canChange, false, '本月已经换校后必须禁止再次更换')
  assert.strictEqual(changed.nextAvailableAt, '2026-11-30T16:00:00.000Z', '下次可换时间必须是中国时区下月 1 日')
  assert.ok(changed.message.indexOf('12月1日') !== -1, '受限提示必须包含下次可换日期')
  assert.strictEqual(policy.buildSchoolChangePolicy({
    schoolId: '4133016405',
    schoolChangeMonth: '2026-11'
  }, december).canChange, true, '进入下一个自然月后应恢复换校次数')
}

function testArchitectureGuards() {
  const chat = read('pages/chat/chat.js')
  assert.strictEqual(chat.indexOf('setInterval'), -1, '聊天页应使用可停止的递归定时器，避免固定间隔重叠请求')
  assert.ok(chat.indexOf('CHAT_POLL_INTERVAL_MS = 1500') !== -1, '聊天页缺少 1.5 秒前台自动同步')
  assert.ok(chat.indexOf('startMessagePolling') !== -1, '聊天页缺少自动同步启动逻辑')
  assert.ok(chat.indexOf('syncNewMessages') !== -1, '聊天页必须保留手动/降级增量同步')
  assert.ok(chat.indexOf('waitForMessages') !== -1, '聊天页缺少低延迟长轮询')
  assert.ok(chat.indexOf('startRealtimeSync') !== -1, '聊天页缺少实时同步启动逻辑')
  assert.ok(chat.indexOf("collection('chat_events')") !== -1, '聊天页缺少数据库实时推送监听')
  assert.ok(chat.indexOf('ownerOpenid: openid') !== -1, '实时事件监听必须限定为本人')
  assert.ok(chat.indexOf('.watch(') !== -1, '聊天页没有调用数据库 watch()')
  assert.ok(chat.indexOf('markRead: false') !== -1, '轮询新消息时不应每次重复写入已读游标')
  assert.ok(chat.indexOf('markConversationRead') !== -1, '用户看到最新消息后必须更新已读游标')
  assert.ok(chat.indexOf('newMessageCount') !== -1, '聊天页缺少新消息提示')
  assert.ok(chat.indexOf('clearTimeout') !== -1, '聊天页离开时必须清理自动同步定时器')
  assert.ok(chat.indexOf('onHide') !== -1 && chat.indexOf('onUnload') !== -1, '聊天页必须在隐藏和卸载时停止自动同步')
  const messagesPage = read('pages/messages/messages.js')
  assert.ok(messagesPage.indexOf('MESSAGES_POLL_INTERVAL_MS = 3000') !== -1, '消息页缺少 3 秒降级刷新')
  assert.ok(messagesPage.indexOf('refreshLiveConversations') !== -1, '消息页缺少降级会话刷新逻辑')
  assert.ok(messagesPage.indexOf('waitForConversations') !== -1, '消息页缺少低延迟长轮询')
  assert.ok(messagesPage.indexOf('startRealtimeSync') !== -1, '消息页缺少实时同步启动逻辑')
  assert.ok(messagesPage.indexOf("collection('chat_events')") !== -1, '消息页缺少数据库实时推送监听')
  assert.ok(messagesPage.indexOf('ownerOpenid: openid') !== -1, '消息页实时监听必须限定为本人')
  assert.ok(messagesPage.indexOf('.watch(') !== -1, '消息页没有调用数据库 watch()')
  assert.ok(messagesPage.indexOf('onHide') !== -1 && messagesPage.indexOf('onUnload') !== -1, '消息页必须在隐藏和卸载时停止自动刷新')
  const appJs = read('app.js')
  assert.ok(appJs.indexOf('BADGE_POLL_INTERVAL_MS = 8000') !== -1, '全局未读角标缺少前台自动刷新')
  assert.ok(appJs.indexOf('startBadgePolling') !== -1 && appJs.indexOf('stopBadgePolling') !== -1, '全局未读角标必须可启动和停止')
  const indexes = JSON.parse(read('database/indexes.json'))
  const collectionNames = indexes.collections.map(function (item) { return item.name })
  ;['users', 'rides', 'ride_members', 'conversations', 'messages', 'chat_events', 'conversation_reads', 'subscriptions'].forEach(function (name) {
    assert.ok(collectionNames.indexOf(name) !== -1, '索引清单缺少集合：' + name)
  })
  const profileWxml = read('pages/profile/profile.wxml')
  const profileJs = read('pages/profile/profile.js')
  const cloudClient = read('utils/cloud.js')
  const profileService = read('cloudfunctions/profile/service.js')
  const clientConfig = read('utils/config.js')
  const chatService = read('cloudfunctions/chat/service.js')
  const ridesService = read('cloudfunctions/rides/service.js')
  const socialService = read('cloudfunctions/social/service.js')
  const messagesWxml = read('pages/messages/messages.wxml')
  const messagesJs = read('pages/messages/messages.js')
  const groupWxml = read('pages/group/group.wxml')
  const settlementWxml = read('pages/settlement/settlement.wxml')
  const settlementJs = read('pages/settlement/settlement.js')
  const publishJs = read('pages/publish/publish.js')
  const publishWxml = read('pages/publish/publish.wxml')
  const rideEditJs = read('pages/ride-edit/ride-edit.js')
  const rideEditWxml = read('pages/ride-edit/ride-edit.wxml')
  const indexWxml = read('pages/index/index.wxml')
  const indexJs = read('pages/index/index.js')
  const ridesWxml = read('pages/rides/rides.wxml')
  const ridesJs = read('pages/rides/rides.js')
  const phoneHelper = require(path.join(root, 'utils/phone'))
  assert.ok(profileWxml.indexOf('学号') !== -1, '个人资料页必须提供学号字段')
  assert.ok(/maxlength="20"/.test(profileWxml), '学号输入框必须限制为最多 20 位')
  assert.ok(/A-Za-z0-9_-/ .test(profileJs), '客户端必须校验通用学号格式')
  assert.ok(profileService.indexOf('studentId') !== -1, '云端资料服务必须保存学号')
  assert.ok(/A-Za-z0-9_-/ .test(profileService), '云端必须校验通用学号格式')
  assert.ok(profileWxml.indexOf('手机号') !== -1 && /maxlength="11"/.test(profileWxml), '个人资料页必须提供 11 位必填手机号')
  assert.strictEqual(phoneHelper.isValidPhone('1' + '38' + '0'.repeat(8)), true, '客户端手机号校验应接受合法格式')
  assert.strictEqual(phoneHelper.isValidPhone('12345'), false, '客户端手机号校验必须拒绝错误格式')
  assert.ok(profileService.indexOf("code: 'PHONE_REQUIRED'") !== -1, '云端资料保存必须强制校验手机号')
  assert.ok(ridesService.indexOf("code: 'PHONE_REQUIRED'") !== -1, '发布和加入拼车团必须要求手机号')
  assert.ok(chatService.indexOf('event.markRead !== false') !== -1, '聊天轮询必须支持不重复写入已读游标')
  assert.ok(chatService.indexOf('contactPhone') !== -1, '聊天会话必须按授权关系返回联系电话')
  assert.ok(chatService.indexOf('senderUserId: currentUser._id') !== -1, '实时事件必须使用公开用户 ID 而不是 OPENID')
  assert.ok(chatService.indexOf("collection('chat_events')") !== -1, '聊天云函数没有写入实时事件')
  assert.ok(ridesService.indexOf("'chat_events'") !== -1, '行程结束时必须清理实时事件')
  assert.ok(socialService.indexOf("'chat_events'") !== -1, '解除搭子时必须清理实时事件')
  assert.ok(chatService.indexOf('ownerOpenid: ownerOpenid') !== -1, '实时事件必须按接收人隔离')
  const cloudSetup = read('docs/CLOUD_SETUP.md')
  assert.ok(cloudSetup.indexOf('auth.openid == doc.ownerOpenid') !== -1, '部署文档必须写明实时事件安全规则')
  assert.ok(chatService.indexOf("action === 'waitForMessages'") !== -1, '聊天云函数缺少实时消息长轮询')
  assert.ok(chatService.indexOf("action === 'waitForConversations'") !== -1, '聊天云函数缺少会话列表长轮询')
  assert.ok(chatService.indexOf('await sleep(60)') !== -1, '长轮询必须以约 60ms 间隔检查新消息')
  assert.ok(messagesWxml.indexOf('catchtap="callContact"') !== -1, '消息页缺少电话联系入口')
  assert.ok(messagesJs.indexOf('wx.makePhoneCall') !== -1, '消息页没有接入微信原生拨号')
  assert.ok(/ownerPhone: includeOwnerPhone/.test(ridesService), '联系电话只能由云函数按成员关系显式返回')
  assert.ok(ridesService.indexOf('enrichRides(pageResult.rides, openid, true)') !== -1, '已加入拼车团列表必须能拿到发起人电话')
  assert.ok(ridesService.indexOf('listOpenGroupsForUser') !== -1, '我的拼车团必须使用过滤后分页')
  assert.ok(ridesService.indexOf("transaction.collection('rides')") !== -1, '结算状态更新必须使用数据库事务')
  assert.ok(messagesWxml.indexOf('电话联系发起人') !== -1, '消息页拼车团卡片缺少发起人电话入口')
  const chatWxml = read('pages/chat/chat.wxml')
  assert.ok(chatWxml.indexOf('catchtap="callContact"') !== -1, '聊天页缺少电话联系入口')
  assert.ok(chat.indexOf('wx.makePhoneCall') !== -1, '聊天页没有接入微信原生拨号')
  ;[chatService, ridesService, socialService].forEach(function (service) {
    const publicUserSource = service.match(/(?:async )?function publicUser[\s\S]*?\n}/)
    assert.ok(publicUserSource && publicUserSource[0].indexOf('phone:') === -1, '公开用户资料不得包含手机号')
  })
  assert.ok(cloudClient.indexOf('compressAvatarIfNeeded') !== -1, '头像上传前应压缩较大的手机照片')
  assert.ok(cloudClient.indexOf('wx.compressImage') !== -1, '头像上传缺少客户端图片压缩')
  assert.ok(profileJs.indexOf('头像或资料同步失败') !== -1, '头像上传失败时必须显示具体原因')
  assert.ok(profileJs.indexOf('avatarDirty') !== -1, '个人资料页必须记录尚未同步的新头像')
  assert.ok(profileJs.indexOf("profile.avatar.indexOf('cloud://') !== 0") !== -1, '重新进入页面时必须识别尚未同步的本地头像')
  assert.ok(profileJs.indexOf("wx.setStorageSync('userProfile', profile)") !== -1, '选择头像后必须立即暂存到本机')
  assert.ok(profileJs.indexOf('pendingAvatar') !== -1, '云端资料返回时必须保留用户刚选择的头像')
  ;[chatService, ridesService, socialService].forEach(function (service) {
    assert.ok(service.indexOf("require('./avatar-url')") !== -1, '公开用户资料必须把私有头像换成临时链接')
    assert.ok(service.indexOf('await resolveAvatar(user.avatar)') !== -1, '公开用户头像不得直接返回私有 cloud:// 文件 ID')
  })
  assert.ok(clientConfig.indexOf('CHAT_SUBSCRIBE_TEMPLATE_ID') !== -1, '客户端缺少订阅消息模板配置项')
  assert.ok(chatService.indexOf('process.env.CHAT_SUBSCRIBE_TEMPLATE_ID') !== -1, '聊天云函数应从环境变量读取订阅消息模板 ID')
  assert.ok(ridesService.indexOf('process.env.CHAT_SUBSCRIBE_TEMPLATE_ID') !== -1, '行程云函数应从环境变量读取加入提醒模板 ID')
  assert.strictEqual(/cgzy_[A-Za-z0-9_-]{20,}/.test(clientConfig + chatService + ridesService), false, '不得在仓库中硬编码真实订阅模板 ID')
  ;['thing1', 'thing2', 'thing14', 'time3'].forEach(function (field) {
    assert.ok(ridesService.indexOf(field) !== -1, '行程云函数缺少订阅模板字段：' + field)
  })
  assert.ok(ridesService.indexOf('subscribeMessage.send') !== -1, '加入拼车团时缺少订阅通知')
  assert.ok(ridesService.indexOf('加入了你的拼车团') !== -1, '订阅通知必须说明有人加入了拼车团')
  assert.strictEqual(chatService.indexOf('subscribeMessage.send'), -1, '聊天消息不应再发订阅通知')
  assert.ok(read('cloudfunctions/rides/config.json').indexOf('subscribeMessage.send') !== -1, 'rides 云函数缺少订阅消息权限')
  ;['sendRequest', 'sendGroupRequest', 'deleteBuddy'].forEach(function (action) {
    assert.ok(socialService.indexOf(action) !== -1, '搭子服务缺少操作：' + action)
  })
  assert.ok(chatService.indexOf('搭子关系已解除') !== -1, '解除搭子后必须禁止继续访问旧私聊')
  assert.strictEqual(chatService.indexOf('STUDENT_ID_REQUIRED'), -1, '聊天功能不应要求填写学号')
  assert.strictEqual(socialService.indexOf('STUDENT_ID_REQUIRED'), -1, '搭子功能不应要求填写学号')
  assert.strictEqual(chatService.indexOf('hasValidStudentId'), -1, '聊天功能仍残留旧学号门槛')
  assert.strictEqual(socialService.indexOf('hasValidStudentId'), -1, '搭子功能仍残留旧学号门槛')
  assert.ok(ridesService.indexOf('cleanupRideGroup') !== -1, '行程终态缺少临时群清理流程')
  ;['messages', 'conversation_reads', 'buddy_requests', 'ride_members', 'conversations'].forEach(function (collection) {
    assert.ok(ridesService.indexOf("'" + collection + "'") !== -1, '临时群清理缺少集合：' + collection)
  })
  assert.ok(messagesWxml.indexOf('catchtap="deleteBuddy"') !== -1, '消息页缺少删除搭子入口')
  assert.strictEqual(messagesWxml.indexOf('reminder-button'), -1, '消息提醒不应继续使用突兀的圆角按钮')
  assert.ok(messagesWxml.indexOf('reminder-strip') !== -1, '消息页缺少轻量提醒入口')
  assert.ok(messagesJs.indexOf('normalizeFriendCode') !== -1, '消息页必须过滤旧版搭子码')
  assert.ok(messagesJs.indexOf('friendCodeNeedsRefresh') !== -1, '旧版搭子码必须显示更新状态')
  assert.ok(groupWxml.indexOf('申请搭子') !== -1, '拼车群成员列表缺少搭子申请入口')
  assert.ok(groupWxml.indexOf('搭子码和群成员列表') !== -1, '页面必须说明两种入口都只是发送申请')
  assert.strictEqual(publishWxml.indexOf('发布类型'), -1, '发布页不应继续显示发布类型选择')
  assert.strictEqual(rideEditWxml.indexOf('发布类型'), -1, '编辑页不应继续显示发布类型选择')
  assert.strictEqual(publishJs.indexOf('找车主'), -1, '发布页不应保留找车主选项')
  assert.strictEqual(rideEditJs.indexOf('找车主'), -1, '编辑页不应保留找车主选项')
  assert.ok(indexWxml.indexOf('<view class="ride-type">发布</view>') !== -1, '首页行程卡片应统一显示发布')
  assert.ok(indexWxml.indexOf('可选行程') !== -1, '首页必须显示可选行程统计')
  assert.strictEqual(indexWxml.indexOf('今日出发'), -1, '首页不应显示今日出发统计')
  assert.strictEqual(indexWxml.indexOf('我的拼车团'), -1, '首页不应显示我的拼车团统计')
  assert.strictEqual(indexWxml.indexOf('stats'), -1, '首页不应恢复旧的统计卡类名')
  assert.ok(indexJs.indexOf("scope: 'joinable'") !== -1, '首页必须只读取未发车且未满座的行程')
  assert.ok(indexJs.indexOf('limit: 10') !== -1, '首页近期行程最多 10 条')
  assert.ok(indexJs.indexOf('withTotal') !== -1, '首页必须读取可选行程总数')
  assert.strictEqual(indexJs.indexOf('canJoin'), -1, '首页不得排除自己发布或已加入的行程')
  assert.ok(indexJs.indexOf('joinRide') !== -1, '首页必须支持直接加入')
  assert.strictEqual(indexJs.indexOf('listMyGroups'), -1, '首页不应为统计卡额外读取拼车团')
  assert.ok(ridesService.indexOf("scope === 'joinable'") !== -1, '行程云函数必须支持只查询未发车行程')
  assert.ok(indexWxml.indexOf('item.actionText') !== -1, '首页按钮必须按行程状态显示')
  assert.ok(ridesService.indexOf('withTotal') !== -1, '行程云函数必须支持返回可选行程总数')
  assert.ok(ridesService.indexOf('where(joinableWhere).count()') !== -1, '可选统计必须与首页范围分开计算')
  assert.ok(ridesService.indexOf('domain.hasStarted') !== -1, '加入、退出和编辑必须按出发时刻校验')
  assert.ok(ridesService.indexOf("code: 'RIDE_STARTED'") !== -1, '发车后必须返回明确的拒绝状态')
  assert.ok(ridesService.indexOf('seatsLabel') !== -1, '行程必须返回进行中/缺人/已满标签')
  assert.ok(ridesService.indexOf('backfillSeatsLeft') !== -1, '旧行程必须补齐剩余座位字段')
  assert.ok(ridesService.indexOf('seatsLeft: _.exists(false)') !== -1, '剩余座位回填必须只处理缺失字段')
  assert.ok(ridesService.indexOf('seatsLeft: db.command.gt(0)') !== -1, '可选行程必须排除已满行程')
  assert.ok(ridesService.indexOf('seatsLeft: ride.seats') !== -1, '发布行程必须写入剩余座位')
  assert.ok(ridesService.indexOf('domain.SETTLEMENT_GRACE_MS') !== -1, '过期清理必须保留补结算窗口')
  assert.ok(ridesService.indexOf('date: db.command.lt(graceDate)') !== -1, '过期清理必须按补结算窗口处理')
  assert.ok(ridesService.indexOf('settlementDue') !== -1, '跨日未结算行程必须显示待结算')
  assert.ok(ridesService.indexOf('alreadyJoined') !== -1, '重复加入必须幂等')
  assert.ok(ridesService.indexOf('removedCount') !== -1, '重复退出必须按实际移除数量扣减')
  assert.ok(ridesService.indexOf('externalTrip: db.command.set') !== -1, '网约车链接必须整体替换，不能合并 null')
  assert.ok(ridesService.indexOf('行程已发车，不能移除成员') !== -1, '发车后必须禁止发布人移除成员')
  assert.ok(ridesService.indexOf("code: 'RIDE_LIMIT'") !== -1, '必须限制同一用户同时发布的活动行程数量')
  assert.ok(ridesService.indexOf('remainingQuota: db.command.inc(1)') !== -1, '订阅发送失败必须回补额度')
  assert.ok(chatService.indexOf('MAX_SUBSCRIPTION_QUOTA') !== -1, '订阅额度必须有上限')
  assert.ok(profileService.indexOf("fileID.endsWith('/' + pendingPath)") !== -1, '上传文件路径必须做精确后缀校验')
  assert.ok(ridesService.indexOf('date: db.command.gte(today)') !== -1, '行程列表必须过滤过期行程')
  assert.strictEqual(ridesWxml.indexOf('云端拼车团'), -1, '行程卡片不应重复显示云端徽标')
  assert.strictEqual(ridesWxml.indexOf('余 {{item.seats}} 座'), -1, '行程卡片不应再重复显示余座')
  assert.ok(ridesWxml.indexOf('item.seatsLabel') !== -1, '行程卡片必须显示状态标签')
  assert.ok(ridesWxml.indexOf('item.ownerAvatar') !== -1, '行程卡片必须展示发布者头像')
  assert.ok(ridesService.indexOf('ownerAvatar: ownerAvatar') !== -1, '行程接口必须返回发布者头像')
  assert.ok(ridesService.indexOf('getTempFileURL') !== -1, '发布者头像必须换成临时链接')
  assert.ok(ridesWxml.indexOf('handleRideAction') !== -1, '行程卡片必须能直接加入')
  assert.ok(ridesJs.indexOf('joinRide') !== -1, '行程列表缺少直接加入逻辑')
  assert.strictEqual(ridesJs.indexOf('actionText: ride.joined'), -1, '列表不得覆盖云端返回的按钮文案')
  assert.ok(groupWxml.indexOf('ride.canJoin') !== -1, '拼车团必须按可加入状态显示入口')
  assert.ok(groupWxml.indexOf('ride.started') !== -1, '拼车团必须锁定已发车行程')
  assert.ok(read('pages/group/group.js').indexOf('ride.started') !== -1, '已发车行程的退出操作必须在客户端拦截')
  assert.ok(messagesWxml.indexOf('item.seatsLabel') !== -1, '消息页拼车团卡片必须显示真实状态')
  assert.ok(ridesWxml.indexOf('<text class="type-text">发布</text>') !== -1, '行程列表卡片应统一显示发布')
  assert.ok(ridesService.indexOf("action === 'locationOptions'") !== -1, '行程云函数缺少出发地/目的地候选接口')
  assert.ok(ridesJs.indexOf('buildLocationSuggestions') !== -1, '智能匹配输入框缺少地点联想逻辑')
  assert.ok(ridesWxml.indexOf('selectLocationSuggestion') !== -1, '智能匹配输入框下方缺少可点击的地点提示')
  assert.ok(ridesWxml.indexOf('bindblur="onMatchBlur"') !== -1, '地点提示必须在输入框失焦后收起')
  const groupJs = read('pages/group/group.js')
  assert.ok(ridesService.indexOf("action === 'saveExternalTrip'") !== -1, '行程云函数缺少保存网约车行程链接操作')
  assert.ok(ridesService.indexOf("action === 'removeExternalTrip'") !== -1, '行程云函数缺少删除网约车行程链接操作')
  assert.ok(ridesService.indexOf('validateExternalTripUrl') !== -1, '保存网约车链接前必须校验官方域名')
  assert.ok(ridesService.indexOf('externalTrip: null') !== -1, '行程结束或过期时必须清理网约车链接')
  assert.ok(ridesService.indexOf('canViewExternalTrip') !== -1, '网约车链接只能对发布者或已加入成员返回')
  const publicRideSource = ridesService.match(/function publicRide[\s\S]*?\n}/)
  assert.ok(publicRideSource && publicRideSource[0].indexOf('externalTrip') === -1, '公开行程卡片不得携带网约车链接')
  assert.ok(groupWxml.indexOf('saveExternalTrip') !== -1, '拼车团页面缺少保存网约车链接入口')
  assert.ok(groupWxml.indexOf('copyExternalTrip') !== -1, '拼车团页面缺少复制网约车链接入口')
  assert.ok(groupWxml.indexOf('非平台实时同步') !== -1, '页面必须说明链接不是平台实时同步')
  assert.ok(groupJs.indexOf('wx.getClipboardData') !== -1, '发布人应能读取剪贴板中的行程链接')
  assert.ok(groupJs.indexOf('wx.setClipboardData') !== -1, '同行人应能复制行程链接')
  assert.strictEqual(publishWxml.indexOf('每人费用'), -1, '发布页不应在开始时填写金额')
  assert.strictEqual(publishWxml.indexOf('车费'), -1, '发布页不应再显示车费标签')
  assert.strictEqual(publishWxml.indexOf('结束后按乘车人数 AA'), -1, '发布页必须移除车费 AA 文案')
  assert.ok(publishWxml.indexOf('可用座位') !== -1, '发布页必须保留座位选择')
  assert.strictEqual(indexWxml.indexOf('车费结束后 AA'), -1, '首页必须移除车费 AA 文案')
  assert.strictEqual(ridesWxml.indexOf('车费结束后 AA'), -1, '行程列表必须移除车费 AA 文案')
  assert.strictEqual(rideEditWxml.indexOf('车费结束后 AA'), -1, '编辑页必须移除车费 AA 文案')
  assert.ok(publishJs.indexOf('getDefaultDeparture') !== -1, '发布页默认时间必须留出 30 分钟余量')
  assert.ok(publishWxml.indexOf('默认 30 分钟后') !== -1, '发布页必须说明默认 30 分钟后出发')
  assert.ok(publishWxml.indexOf('publish-actions') !== -1, '发布按钮必须放在独立操作卡片中')
  assert.ok(profileWxml.indexOf('profile-save-panel') !== -1, '保存资料按钮必须放在底部操作面板中')
  assert.ok(publishWxml.indexOf('route-auto-note') !== -1, '出校/返校必须提示学校端自动填写')
  assert.ok(publishWxml.indexOf('owner-readonly') !== -1, '发布人称呼必须只读展示')
  assert.ok(publishJs.indexOf("page.data.form.direction === '出校'") !== -1, '发布页必须自动填写出校出发点')
  assert.ok(publishJs.indexOf("page.data.form.direction === '返校'") !== -1, '发布页必须自动填写返校目的地')
  assert.ok(publishJs.indexOf('profile.name') !== -1, '发布页必须从我的资料读取称呼')
  assert.ok(rideEditWxml.indexOf('field-input-locked') !== -1, '编辑页必须锁定学校端路线')
  assert.ok(rideEditJs.indexOf("ride.direction === '出校'") !== -1, '编辑页必须自动填写出校出发点')
  assert.ok(ridesService.indexOf('rideInput.from = school.schoolName') !== -1, '云端必须强制出校出发点为学校名称')
  assert.ok(ridesService.indexOf('rideInput.to = school.schoolName') !== -1, '云端必须强制返校目的地为学校名称')
  assert.ok(ridesService.indexOf('ride.ownerName = currentUser.name') !== -1, '云端必须强制发布人称呼为我的名称')
  assert.ok(publishJs.indexOf('const requiredFields = [form.from, form.to, form.owner]') !== -1, '发布校验不应继续要求金额')
  assert.ok(publishJs.indexOf('PAYMENT_CODE_REQUIRED') !== -1, '发布页必须处理未上传收款码的错误')
  assert.ok(ridesService.indexOf('PAYMENT_CODE_REQUIRED') !== -1, '发布和结算前必须校验收款码')
  assert.ok(ridesService.indexOf("action === 'createSettlement'") !== -1, '行程云函数缺少生成结算单操作')
  assert.ok(ridesService.indexOf("action === 'markSettlementPaid'") !== -1, '行程云函数缺少同行人标记转账操作')
  assert.ok(ridesService.indexOf("action === 'confirmSettlementPayment'") !== -1, '行程云函数缺少发布人确认收款操作')
  assert.ok(ridesService.indexOf("action === 'completeSettlement'") !== -1, '行程云函数缺少完成结算操作')
  assert.ok(ridesService.indexOf("action === 'updateSettlement'") !== -1, '行程云函数缺少修改结算操作')
  assert.ok(ridesService.indexOf("action === 'withdrawSettlement'") !== -1, '行程云函数缺少撤销结算操作')
  assert.ok(ridesService.indexOf('settlement: db.command.set(record)') !== -1, '结算对象必须用 set 替换，不能与 null 合并')
  assert.ok(ridesService.indexOf('settlement: db.command.set(ride.settlement)') !== -1, '结算状态更新必须用 set 替换整个对象')
  assert.strictEqual(ridesService.indexOf('record.createdAt = db.serverDate()'), -1, '结算对象内不能嵌套 serverDate 命令')
  assert.ok(settlementWxml.indexOf('startEditSettlement') !== -1, '结算页缺少修改结算入口')
  assert.ok(settlementWxml.indexOf('withdrawSettlement') !== -1, '结算页缺少撤销结算入口')
  assert.ok(settlementWxml.indexOf('copyReminder') !== -1, '结算页缺少催付文案入口')
  assert.ok(ridesService.indexOf("status: 'settling'") !== -1, '结束行程后必须保留待结算状态')
  assert.ok(profileService.indexOf("event.action === 'preparePaymentCode'") !== -1, '资料云函数缺少收款码上传准备操作')
  assert.ok(profileService.indexOf("event.action === 'commitPaymentCode'") !== -1, '资料云函数缺少收款码提交操作')
  assert.ok(profileService.indexOf("event.action === 'removePaymentCode'") !== -1, '资料云函数缺少收款码删除操作')
  assert.ok(profileWxml.indexOf('收款码') !== -1, '我的页面缺少收款码入口')
  assert.ok(profileWxml.indexOf('不要上传付款码') !== -1, '上传收款码时必须明确禁止上传付款码')
  assert.ok(settlementWxml.indexOf('paymentCodeUrl') !== -1, '结算页缺少收款码展示')
  assert.ok(settlementWxml.indexOf('markPaid') !== -1, '结算页缺少我已转账入口')
  assert.ok(settlementWxml.indexOf('confirmPayment') !== -1, '结算页缺少发布人确认收款入口')
  assert.ok(settlementWxml.indexOf('completeSettlement') !== -1, '结算页缺少完成结算入口')
  assert.ok(settlementJs.indexOf('wx.previewImage') !== -1, '收款码必须支持查看大图')
  assert.ok(groupWxml.indexOf('结束并结算') !== -1, '拼车团页面缺少结束并结算入口')
  ;['verificationStatus', 'verification_requests'].forEach(function (legacyName) {
    assert.strictEqual(read('cloudfunctions/profile/service.js').indexOf(legacyName), -1, '资料服务仍包含旧认证字段：' + legacyName)
  })
  const app = JSON.parse(read('app.json'))
  assert.strictEqual(app.pages[0], 'pages/school-select/school-select', '学校选择页必须作为首次入口')
  assert.strictEqual(app.lazyCodeLoading, 'requiredComponents', '必须启用组件按需注入')
  const projectConfig = JSON.parse(read('project.config.json'))
  const ignored = projectConfig.packOptions.ignore.map(function (item) { return item.value })
  ;['tests', 'scripts', 'docs', 'database', 'cloudfunctions'].forEach(function (folder) {
    assert.ok(ignored.indexOf(folder) !== -1, '代码包应排除非运行时目录：' + folder)
  })
  assert.ok(ignored.indexOf('project.private.config.json') !== -1, '代码包应排除本机私有配置')
  const schoolPage = read('pages/school-select/school-select.js')
  const schoolWxml = read('pages/school-select/school-select.wxml')
  const loginService = read('cloudfunctions/login/index.js')
  assert.ok(schoolPage.indexOf("require('../../utils/schools')") !== -1, '学校选择页必须使用统一高校目录')
  assert.ok(profileService.indexOf("event.action === 'setSchool'") !== -1, '资料云函数缺少学校锁定操作')
  assert.ok(profileService.indexOf('db.runTransaction') !== -1, '换校次数必须通过云端事务校验')
  assert.ok(profileService.indexOf("code: 'SCHOOL_CHANGE_LIMIT'") !== -1, '资料云函数缺少每月换校限制错误')
  assert.ok(schoolPage.indexOf('loadChangePolicy') !== -1, '换校页必须读取云端换校规则')
  assert.ok(schoolWxml.indexOf('本月不可更换') !== -1, '换校页缺少受限按钮状态')
  assert.ok(ridesService.indexOf("schoolId: school.schoolId") !== -1, '行程云函数必须按当前学校查询')
  assert.ok(loginService.indexOf("'CP-'") !== -1, '搭子码必须使用通用 CP 前缀')
}

function testSchoolCatalog() {
  const schools = require(path.join(root, 'utils/schools'))
  assert.ok(schools.length >= 2900, '全国高校目录数量不足')
  const ids = new Set()
  const provinces = new Set()
  schools.forEach(function (school) {
    assert.ok(/^\d{10}$/.test(school.id), '学校标识码格式错误：' + school.name)
    assert.ok(school.name && school.province && school.city, '学校目录字段不完整：' + school.id)
    assert.strictEqual(ids.has(school.id), false, '学校标识码重复：' + school.id)
    ids.add(school.id)
    provinces.add(school.province)
  })
  assert.ok(provinces.size >= 31, '高校目录未覆盖大陆 31 个省级地区')
  assert.ok(schools.some(function (school) { return school.name === '北京大学' }), '高校目录缺少基础样本')
}

function testNoLocalDemoData() {
  assert.strictEqual(fs.existsSync(path.join(root, 'utils/mock.js')), false, '不应保留模拟行程模块')
  assert.strictEqual(fs.existsSync(path.join(root, 'utils/community.js')), false, '不应保留本地社区模块')

  const cloudOnlyClient = [
    'pages/index/index.js',
    'pages/rides/rides.js',
    'pages/publish/publish.js',
    'pages/messages/messages.js',
    'pages/chat/chat.js'
  ].map(read).join('\n')
  ;[
    "require('../../utils/mock')",
    "require('../../utils/community')",
    "getStorageSync('publishedRides')",
    "setStorageSync('publishedRides'",
    'saveLocalRide',
    'confirmLocalFallback',
    'initLocalRide'
  ].forEach(function (legacyToken) {
    assert.strictEqual(cloudOnlyClient.indexOf(legacyToken), -1, '客户端仍包含本地演示入口：' + legacyToken)
  })

  const app = read('app.js')
  ;['publishedRides', 'rideConversations', 'rideChatMessages', 'joinedRideGroups', 'carpoolBuddies', 'contactNotes'].forEach(function (key) {
    assert.ok(app.indexOf("'" + key + "'") !== -1, '启动清理缺少旧缓存键：' + key)
  })
  assert.ok(app.indexOf('wx.removeStorageSync(key)') !== -1, '启动时必须清除旧模拟缓存')
}

testJsonFiles()
testPages()
testPrivateSitemap()
testRideDomain()
testAvatarValidation()
testSchoolChangePolicy()
testArchitectureGuards()
testNoLocalDemoData()
testSchoolCatalog()

testPrivateAvatarResolver().then(function () {
  console.log('全部自动化检查通过。')
}).catch(function (error) {
  console.error(error)
  process.exitCode = 1
})
