const cloudService = require('../../utils/cloud')
const schoolStore = require('../../utils/school')

function pad(number) {
  return number < 10 ? '0' + number : String(number)
}

function getDefaultDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function getDateLabel(date) {
  const parts = date.split('-')
  return Number(parts[1]) + '月' + pad(Number(parts[2])) + '日'
}

function getMinutes(time) {
  const parts = time.split(':')
  return Number(parts[0]) * 60 + Number(parts[1])
}

function normalizeLocation(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '')
}

function locationMatches(location, keyword, schoolName) {
  if (!keyword) {
    return true
  }

  const locationText = normalizeLocation(location)
  const keywordText = normalizeLocation(keyword)

  if (locationText.indexOf(keywordText) !== -1 || keywordText.indexOf(locationText) !== -1) {
    return true
  }

  const campusAliases = [schoolName, '学校', '校园', '本校'].filter(Boolean).map(normalizeLocation)
  const keywordIsCampus = campusAliases.some(function (alias) {
    return keywordText.indexOf(alias) !== -1
  })
  const locationIsCampus = campusAliases.some(function (alias) {
    return locationText.indexOf(alias) !== -1
  })

  return keywordIsCampus && locationIsCampus
}

Page({
  data: {
    filters: ['全部', '出校', '返校', '周边'],
    activeFilter: '全部',
    rides: [],
    cloudRides: [],
    visibleRides: [],
    cloudPage: 1,
    hasMoreCloud: false,
    loadingMore: false,
    joiningRideId: '',
    isMatching: false,
    matchedRides: [],
    matchSummary: '',
    schoolName: '',
    cloudMessage: '正在读取云端行程',
    locationOptions: {
      from: [],
      to: []
    },
    fromSuggestions: [],
    toSuggestions: [],
    matchForm: {
      from: '',
      to: '',
      date: getDefaultDate(),
      startTime: '08:00',
      endTime: '22:00'
    }
  },

  onShow: function () {
    const school = schoolStore.getSelectedSchool()
    if (!school) {
      wx.reLaunch({ url: '/pages/school-select/school-select' })
      return
    }
    this.setData({
      schoolName: school.name,
      fromSuggestions: [],
      toSuggestions: []
    })
    this.loadRides()
    this.loadLocationOptions()
  },

  onPullDownRefresh: function () {
    this.loadRides().then(function () {
      wx.stopPullDownRefresh()
      wx.showToast({ title: '列表已刷新', icon: 'none' })
    })
  },

  loadRides: function () {
    const page = this
    page.setData({
      rides: [],
      cloudRides: [],
      visibleRides: [],
      cloudPage: 1,
      hasMoreCloud: false,
      cloudMessage: '正在读取云端行程'
    })

    return getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        page.setData({ cloudMessage: '云端连接失败，暂时无法读取行程' })
        page.applyRideSource([])
        return
      }
      return cloudService.rides('list', { page: 1, limit: 10 }).then(function (result) {
        const cloudRides = result.rides.map(function (ride) {
          return Object.assign({}, ride, {
            ownerInitial: String(ride.owner || 'W').slice(0, 1)
          })
        })
        page.setData({
          cloudMessage: cloudRides.length ? '仅显示' + page.data.schoolName + '的真实行程' : page.data.schoolName + '还没有可用行程',
          cloudRides: cloudRides,
          cloudPage: 1,
          hasMoreCloud: Boolean(result.pagination && result.pagination.hasMore)
        })
        page.applyRideSource(cloudRides)
      }).catch(function (error) {
        page.setData({ cloudMessage: '云端行程加载失败：' + (error.message || '请稍后重试') })
        page.applyRideSource([])
      })
    })
  },

  loadMoreCloudRides: function () {
    if (this.data.loadingMore || !this.data.hasMoreCloud) {
      return
    }
    const page = this
    const nextPage = this.data.cloudPage + 1
    page.setData({ loadingMore: true })
    cloudService.rides('list', { page: nextPage, limit: 10 }).then(function (result) {
      const existingIds = {}
      page.data.cloudRides.forEach(function (ride) { existingIds[ride.id] = true })
      const nextRides = result.rides.filter(function (ride) {
        return !existingIds[ride.id]
      }).map(function (ride) {
        return Object.assign({}, ride, {
          ownerInitial: String(ride.owner || 'W').slice(0, 1)
        })
      })
      const cloudRides = page.data.cloudRides.concat(nextRides)
      page.setData({
        cloudRides: cloudRides,
        cloudPage: nextPage,
        hasMoreCloud: Boolean(result.pagination && result.pagination.hasMore),
        loadingMore: false
      })
      page.applyRideSource(cloudRides)
    }).catch(function (error) {
      page.setData({ loadingMore: false })
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    })
  },

  applyRideSource: function (rides) {
    const preparedSource = rides.map(function (ride) {
      return Object.assign({}, ride)
    })
    this.setData({ rides: preparedSource })
    this.mergeOptionsFromRides(preparedSource)
    if (this.data.isMatching) {
      this.performMatch(false, preparedSource)
    } else {
      this.applyFilter(this.data.activeFilter, preparedSource)
    }
  },

  loadLocationOptions: function () {
    const page = this
    return getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        return null
      }
      return cloudService.rides('locationOptions')
    }).then(function (result) {
      if (!result) {
        return
      }
      page.setData({
        locationOptions: {
          from: result.from || [],
          to: result.to || []
        }
      })
    }).catch(function () {
      // 地点提示失败不影响筛选和列表。
    })
  },

  mergeOptionsFromRides: function (rides) {
    const current = this.data.locationOptions
    if (current.from.length || current.to.length) {
      return
    }
    const from = {}
    const to = {}
    ;(rides || []).forEach(function (ride) {
      if (ride.from) {
        from[ride.from] = true
      }
      if (ride.to) {
        to[ride.to] = true
      }
    })
    this.setData({
      locationOptions: {
        from: Object.keys(from).slice(0, 40),
        to: Object.keys(to).slice(0, 40)
      }
    })
  },

  buildLocationSuggestions: function (field, keyword) {
    const query = normalizeLocation(keyword)
    if (!query) {
      return []
    }
    const options = this.data.locationOptions[field] || []
    return options.filter(function (item) {
      const text = normalizeLocation(item)
      return text && text.indexOf(query) !== -1 && text !== query
    }).sort(function (first, second) {
      const firstText = normalizeLocation(first)
      const secondText = normalizeLocation(second)
      const firstPrefix = firstText.indexOf(query) === 0 ? 0 : 1
      const secondPrefix = secondText.indexOf(query) === 0 ? 0 : 1
      return firstPrefix - secondPrefix ||
        first.length - second.length ||
        first.localeCompare(second)
    }).slice(0, 5)
  },

  selectLocationSuggestion: function (event) {
    const field = event.currentTarget.dataset.field
    const value = event.currentTarget.dataset.value
    const update = {}
    update['matchForm.' + field] = value
    update[field + 'Suggestions'] = []
    this.setData(update)
    if (wx.hideKeyboard) {
      wx.hideKeyboard()
    }
  },

  selectFilter: function (event) {
    const filter = event.currentTarget.dataset.filter
    this.setData({ activeFilter: filter })
    const sourceRides = this.data.isMatching ? this.data.matchedRides : this.data.rides
    this.applyFilter(filter, sourceRides)
  },

  applyFilter: function (filter, rides) {
    const visibleRides = filter === '全部'
      ? rides
      : rides.filter(function (ride) {
        return ride.direction === filter
      })

    const isMatching = this.data.isMatching
    const preparedRides = visibleRides.map(function (ride, index) {
      return Object.assign({}, ride, {
        isBestMatch: isMatching && index === 0
      })
    })

    this.setData({ visibleRides: preparedRides })
  },

  onMatchInput: function (event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value
    const otherField = field === 'from' ? 'to' : 'from'
    const update = {}
    update['matchForm.' + field] = value
    update[field + 'Suggestions'] = this.buildLocationSuggestions(field, value)
    update[otherField + 'Suggestions'] = []
    this.setData(update)
  },

  onMatchBlur: function (event) {
    const page = this
    const field = event.currentTarget.dataset.field
    setTimeout(function () {
      const update = {}
      update[field + 'Suggestions'] = []
      page.setData(update)
    }, 180)
  },

  onMatchDateChange: function (event) {
    this.setData({ 'matchForm.date': event.detail.value })
  },

  onMatchTimeChange: function (event) {
    const field = event.currentTarget.dataset.field
    const update = {}
    update['matchForm.' + field] = event.detail.value
    this.setData(update)
  },

  findMatches: function () {
    this.performMatch(true, this.data.rides)
  },

  performMatch: function (showFeedback, rides) {
    const form = this.data.matchForm
    const from = form.from.trim()
    const to = form.to.trim()
    const startMinutes = getMinutes(form.startTime)
    const endMinutes = getMinutes(form.endTime)

    if (!from && !to) {
      if (showFeedback) {
        wx.showToast({ title: '请至少填写一个地点', icon: 'none' })
      }
      return
    }

    if (startMinutes > endMinutes) {
      if (showFeedback) {
        wx.showToast({ title: '结束时间不能早于开始时间', icon: 'none' })
      }
      return
    }

    const targetDate = getDateLabel(form.date)
    const centerMinutes = (startMinutes + endMinutes) / 2
    const schoolName = this.data.schoolName
    const matchedRides = rides
      .filter(function (ride) {
        const rideMinutes = getMinutes(ride.time)
        return ride.date === targetDate &&
          rideMinutes >= startMinutes &&
          rideMinutes <= endMinutes &&
          locationMatches(ride.from, from, schoolName) &&
          locationMatches(ride.to, to, schoolName)
      })
      .map(function (ride) {
        const distanceFromCenter = Math.abs(getMinutes(ride.time) - centerMinutes)
        return Object.assign({}, ride, { matchDistance: distanceFromCenter })
      })
      .sort(function (a, b) {
        return a.matchDistance - b.matchDistance
      })
      .map(function (ride, index) {
        return Object.assign({}, ride, { isBestMatch: index === 0 })
      })

    const summary = matchedRides.length
      ? '找到 ' + matchedRides.length + ' 条符合行程，最合适的已排在首位'
      : '暂时没有完全符合时间和地点的行程'

    this.setData({
      isMatching: true,
      matchedRides: matchedRides,
      matchSummary: summary
    })
    this.applyFilter(this.data.activeFilter, matchedRides)

    if (showFeedback && matchedRides.length) {
      wx.showToast({ title: '匹配完成', icon: 'success' })
    }
  },

  clearMatch: function () {
    this.setData({
      isMatching: false,
      matchedRides: [],
      matchSummary: '',
      fromSuggestions: [],
      toSuggestions: []
    })
    this.applyFilter(this.data.activeFilter, this.data.rides)
  },

  contactOwner: function (event) {
    const rideId = event.currentTarget.dataset.id
    wx.navigateTo({
      url: '/pages/group/group?rideId=' + encodeURIComponent(rideId)
    })
  },

  handleRideAction: function (event) {
    const page = this
    const rideId = event.currentTarget.dataset.id
    const ride = page.data.visibleRides.filter(function (item) {
      return item.id === rideId
    })[0]
    if (ride && ride.action === 'join') {
      page.joinRide(rideId)
      return
    }
    page.contactOwner(event)
  },

  joinRide: function (rideId) {
    const page = this
    if (!rideId || page.data.joiningRideId) {
      return
    }
    page.setData({ joiningRideId: rideId })
    cloudService.rides('join', { rideId: rideId }).then(function () {
      page.setData({ joiningRideId: '' })
      wx.showToast({ title: '已加入拼车团', icon: 'success' })
      setTimeout(function () {
        wx.navigateTo({
          url: '/pages/group/group?rideId=' + encodeURIComponent(rideId)
        })
      }, 400)
    }).catch(function (error) {
      page.setData({ joiningRideId: '' })
      if (error.code === 'PHONE_REQUIRED') {
        wx.showModal({
          title: '请先填写手机号',
          content: '加入拼车团前需要在“我的”页面填写并云端保存手机号。',
          confirmText: '去填写',
          success: function (result) {
            if (result.confirm) {
              wx.switchTab({ url: '/pages/profile/profile' })
            }
          }
        })
        return
      }
      wx.showToast({ title: error.message || '加入失败', icon: 'none' })
      page.loadRides()
    })
  },

  changeSchool: function () {
    wx.navigateTo({ url: '/pages/school-select/school-select?change=1' })
  }
})

