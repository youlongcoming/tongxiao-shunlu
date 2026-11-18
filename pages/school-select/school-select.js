const schools = require('../../utils/schools')
const schoolStore = require('../../utils/school')
const cloudService = require('../../utils/cloud')

function buildCatalog(items) {
  const provinceNames = []
  const byProvince = {}
  items.forEach(function (school) {
    if (!byProvince[school.province]) {
      provinceNames.push(school.province)
      byProvince[school.province] = { cityNames: [], byCity: {} }
    }
    const province = byProvince[school.province]
    const city = school.city || school.province
    if (!province.byCity[city]) {
      province.cityNames.push(city)
      province.byCity[city] = []
    }
    province.byCity[city].push(school)
  })
  return { provinceNames: provinceNames, byProvince: byProvince }
}

const catalog = buildCatalog(schools)

function schoolFromUser(user) {
  return schoolStore.normalizeSchool({
    id: user && user.schoolId,
    name: user && user.schoolName,
    province: user && user.schoolProvince,
    city: user && user.schoolCity,
    level: user && user.schoolLevel
  })
}

Page({
  data: {
    changeMode: false,
    currentSchool: null,
    canChangeSchool: true,
    changePolicyText: '',
    loading: true,
    submitting: false,
    errorMessage: '',
    searchQuery: '',
    searchResults: [],
    provinceNames: catalog.provinceNames,
    cityNames: [],
    schoolNames: [],
    pickerValue: [0, 0, 0],
    selectedSchool: null,
    schoolCount: schools.length
  },

  onLoad: function (options) {
    this.changeMode = options && options.change === '1'
    const selected = schoolStore.getSelectedSchool()
    this.initializePicker(selected)
    this.setData({ changeMode: this.changeMode })

    if (this.changeMode) {
      this.loadChangePolicy(selected)
      return
    }

    this.restoreSchool(selected)
  },

  loadChangePolicy: function (localSchool) {
    const page = this
    getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        throw new Error(state.reason || '云服务暂时不可用')
      }
      return cloudService.getProfile()
    }).then(function (result) {
      const currentSchool = schoolFromUser(result.profile) || localSchool
      const policy = result.schoolChangePolicy || {
        canChange: true,
        message: '本月还可以更换 1 次学校'
      }
      if (currentSchool) {
        schoolStore.setSelectedSchool(currentSchool)
        getApp().globalData.school = currentSchool
      }
      page.setData({
        currentSchool: currentSchool,
        canChangeSchool: policy.canChange !== false,
        changePolicyText: policy.message || '',
        loading: false
      })
    }).catch(function (error) {
      page.setData({
        loading: false,
        canChangeSchool: false,
        errorMessage: error.message || '换校规则读取失败，请稍后重试'
      })
    })
  },

  initializePicker: function (selected) {
    let provinceIndex = 0
    let cityIndex = 0
    let schoolIndex = 0

    if (selected) {
      const matchedProvince = catalog.provinceNames.indexOf(selected.province)
      provinceIndex = Math.max(0, matchedProvince)
      const province = catalog.byProvince[catalog.provinceNames[provinceIndex]]
      cityIndex = Math.max(0, province.cityNames.indexOf(selected.city))
      const citySchools = province.byCity[province.cityNames[cityIndex]] || []
      const matchedSchool = citySchools.findIndex(function (item) { return item.id === selected.id })
      schoolIndex = Math.max(0, matchedSchool)
    }

    this.applyPicker([provinceIndex, cityIndex, schoolIndex])
  },

  applyPicker: function (value) {
    const provinceIndex = Math.max(0, Math.min(value[0] || 0, catalog.provinceNames.length - 1))
    const provinceName = catalog.provinceNames[provinceIndex]
    const province = catalog.byProvince[provinceName]
    const cityIndex = Math.max(0, Math.min(value[1] || 0, province.cityNames.length - 1))
    const cityName = province.cityNames[cityIndex]
    const citySchools = province.byCity[cityName] || []
    const schoolIndex = Math.max(0, Math.min(value[2] || 0, citySchools.length - 1))

    this.setData({
      cityNames: province.cityNames,
      schoolNames: citySchools.map(function (item) { return item.name }),
      pickerValue: [provinceIndex, cityIndex, schoolIndex],
      selectedSchool: citySchools[schoolIndex] || null
    })
  },

  restoreSchool: function (localSchool) {
    const page = this
    getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        page.setData({
          loading: false,
          errorMessage: state.reason || '云服务暂时不可用，请稍后重试'
        })
        return
      }
      const cloudSchool = schoolFromUser(state.user)
      if (cloudSchool) {
        schoolStore.setSelectedSchool(cloudSchool)
        getApp().globalData.school = cloudSchool
        wx.switchTab({ url: '/pages/index/index' })
        return
      }
      if (localSchool) {
        page.saveSchool(localSchool, true)
        return
      }
      page.setData({ loading: false })
    }).catch(function (error) {
      page.setData({ loading: false, errorMessage: error.message || '学校信息读取失败' })
    })
  },

  onPickerChange: function (event) {
    const next = event.detail.value || [0, 0, 0]
    const current = this.data.pickerValue
    if (next[0] !== current[0]) {
      next[1] = 0
      next[2] = 0
    } else if (next[1] !== current[1]) {
      next[2] = 0
    }
    this.applyPicker(next)
  },

  onSearchInput: function (event) {
    const query = String(event.detail.value || '').trim()
    const keyword = query.toLowerCase().replace(/\s+/g, '')
    const results = keyword
      ? schools.filter(function (school) {
        return [school.name, school.province, school.city, school.id].some(function (value) {
          return String(value || '').toLowerCase().replace(/\s+/g, '').indexOf(keyword) !== -1
        })
      }).slice(0, 50)
      : []
    this.setData({ searchQuery: query, searchResults: results })
  },

  clearSearch: function () {
    this.setData({ searchQuery: '', searchResults: [] })
  },

  chooseSearchResult: function (event) {
    const schoolId = event.currentTarget.dataset.id
    const school = schools.find(function (item) { return item.id === schoolId })
    if (school) {
      this.confirmSchool(school)
    }
  },

  confirmPickerSchool: function () {
    if (!this.data.selectedSchool) {
      wx.showToast({ title: '请选择学校', icon: 'none' })
      return
    }
    this.confirmSchool(this.data.selectedSchool)
  },

  confirmSchool: function (school) {
    const page = this
    const current = schoolStore.getSelectedSchool()
    if (current && current.id === school.id) {
      wx.showToast({ title: '当前已是这所学校', icon: 'none' })
      return
    }
    if (this.changeMode && current && current.id !== school.id) {
      if (!this.data.canChangeSchool) {
        wx.showModal({
          title: '本月暂时不能换校',
          content: this.data.changePolicyText || '每个自然月只能更换一次学校',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }
      wx.showModal({
        title: '切换到' + school.name,
        content: '每个自然月只能更换一次学校。切换后，首页和拼车列表只显示新学校的行程；原学校的临时拼车团不会出现在当前列表。',
        confirmText: '确认切换',
        confirmColor: '#0b6b57',
        success: function (result) {
          if (result.confirm) {
            page.saveSchool(school, false)
          }
        }
      })
      return
    }
    this.saveSchool(school, false)
  },

  saveSchool: function (school, silent) {
    if (this.data.submitting) {
      return
    }
    const page = this
    page.setData({ submitting: true, loading: false, errorMessage: '' })
    getApp().whenCloudReady().then(function (state) {
      if (!state.ready) {
        throw new Error(state.reason || '云服务暂时不可用')
      }
      return cloudService.setSchool(school)
    }).then(function (result) {
      const saved = schoolStore.setSelectedSchool(result.school || school)
      const app = getApp()
      app.globalData.school = saved
      if (app.globalData.cloudState && app.globalData.cloudState.user) {
        app.globalData.cloudState.user.schoolId = saved.id
        app.globalData.cloudState.user.schoolName = saved.name
        app.globalData.cloudState.user.schoolProvince = saved.province
        app.globalData.cloudState.user.schoolCity = saved.city
        app.globalData.cloudState.user.schoolLevel = saved.level
      }
      page.setData({
        submitting: false,
        currentSchool: saved,
        canChangeSchool: result.schoolChangePolicy ? result.schoolChangePolicy.canChange !== false : page.data.canChangeSchool,
        changePolicyText: result.schoolChangePolicy ? result.schoolChangePolicy.message : page.data.changePolicyText
      })
      if (!silent) {
        wx.showToast({ title: page.changeMode ? '学校已更换' : '学校已锁定', icon: 'success' })
      }
      setTimeout(function () {
        wx.switchTab({ url: '/pages/index/index' })
      }, silent ? 0 : 500)
    }).catch(function (error) {
      const policy = error && error.data && error.data.schoolChangePolicy
      page.setData({
        submitting: false,
        loading: false,
        canChangeSchool: policy ? policy.canChange !== false : page.data.canChangeSchool,
        changePolicyText: policy ? policy.message : page.data.changePolicyText,
        errorMessage: error.message || '学校保存失败，请重试'
      })
    })
  }
})
