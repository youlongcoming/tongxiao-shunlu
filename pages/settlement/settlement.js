const cloudService = require('../../utils/cloud')

function statusText(status) {
  return {
    owner: '自己承担',
    pending: '待转账',
    claimed: '已转账，待确认',
    confirmed: '已确认收款'
  }[status] || '待转账'
}

function prepareSettlement(settlement) {
  if (!settlement) {
    return null
  }
  return Object.assign({}, settlement, {
    myShareLabel: (Number(settlement.myShareFen || 0) / 100).toFixed(2),
    participants: (settlement.participants || []).map(function (participant) {
      return Object.assign({}, participant, {
        statusText: statusText(participant.status)
      })
    })
  })
}

Page({
  data: {
    rideId: '',
    mode: 'view',
    ride: null,
    settlement: null,
    isOwner: false,
    loading: true,
    errorMessage: '',
    amount: '',
    members: [],
    selectedCount: 0,
    estimateLabel: '0.00',
    submitting: false,
    actionLoading: false
  },

  onLoad: function (options) {
    this.setData({
      rideId: decodeURIComponent(options.rideId || ''),
      mode: options.mode === 'create' ? 'create' : 'view'
    })
    this.loadSettlement()
  },

  onShow: function () {
    if (this.data.rideId && this.data.ride && this.data.mode === 'view') {
      this.loadSettlement()
    }
  },

  loadSettlement: function () {
    const page = this
    page.setData({ loading: true, errorMessage: '' })
    cloudService.rides('getGroup', { rideId: page.data.rideId }).then(function (result) {
      const ride = result.ride
      let mode = page.data.mode
      if (result.settlement && mode !== 'edit') {
        mode = 'view'
      }
      if (mode === 'create' && (!result.isOwner || ride.status !== 'active')) {
        mode = 'view'
      }
      if (mode === 'edit' && (!result.isOwner || ride.status !== 'settling' || !result.settlement)) {
        mode = 'view'
      }
      const selectedIds = mode === 'edit' && result.settlement
        ? (result.settlement.participants || []).map(function (participant) { return participant.userId })
        : null
      const members = (result.members || []).map(function (member) {
        return Object.assign({}, member, {
          selected: selectedIds ? selectedIds.indexOf(member.user.userId) !== -1 : true
        })
      })
      const selectedCount = members.filter(function (member) { return member.selected }).length
      page.setData({
        mode: mode,
        ride: ride,
        settlement: prepareSettlement(result.settlement),
        isOwner: result.isOwner,
        members: members,
        selectedCount: selectedCount,
        amount: mode === 'edit' && result.settlement
          ? (Number(result.settlement.totalFen || 0) / 100).toFixed(2)
          : page.data.amount,
        loading: false
      })
      page.updateEstimate()
    }).catch(function (error) {
      page.setData({ loading: false, errorMessage: error.message })
    })
  },

  onAmountInput: function (event) {
    const page = this
    page.setData({ amount: event.detail.value }, function () {
      page.updateEstimate()
    })
  },

  toggleMember: function (event) {
    const page = this
    const userId = event.currentTarget.dataset.userId
    const members = page.data.members.map(function (member) {
      return member.user.userId === userId
        ? Object.assign({}, member, { selected: !member.selected })
        : member
    })
    const selectedCount = members.filter(function (member) { return member.selected }).length
    page.setData({
      members: members,
      selectedCount: selectedCount
    }, function () {
      page.updateEstimate()
    })
  },

  updateEstimate: function () {
    const amount = Number(this.data.amount)
    const count = Number(this.data.selectedCount) || 0
    if (!count || !isFinite(amount) || amount <= 0) {
      this.setData({ estimateLabel: '0.00' })
      return
    }
    this.setData({ estimateLabel: (amount / count).toFixed(2) })
  },

  submitSettlement: function () {
    const page = this
    const amount = String(page.data.amount || '').trim()
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      wx.showToast({ title: '请输入正确的车费金额', icon: 'none' })
      return
    }
    const participantUserIds = page.data.members.filter(function (member) {
      return member.selected
    }).map(function (member) {
      return member.user.userId
    })
    if (!participantUserIds.length) {
      wx.showToast({ title: '请至少选择一位乘车人', icon: 'none' })
      return
    }
    if (page.data.submitting) {
      return
    }
    const isEdit = page.data.mode === 'edit'
    page.setData({ submitting: true })
    cloudService.rides(isEdit ? 'updateSettlement' : 'createSettlement', {
      rideId: page.data.rideId,
      totalAmount: amount,
      participantUserIds: participantUserIds
    }).then(function () {
      page.setData({ submitting: false, mode: 'view' })
      wx.showToast({ title: isEdit ? '结算已更新' : '结算已生成', icon: 'success' })
      page.loadSettlement()
    }).catch(function (error) {
      page.setData({ submitting: false })
      if (error.code === 'PAYMENT_CODE_REQUIRED') {
        wx.showModal({
          title: '请先上传收款码',
          content: '请先在“我的”页面上传收款码，再回来结束行程并结算。',
          confirmText: '去上传',
          success: function (result) {
            if (result.confirm) {
              wx.switchTab({ url: '/pages/profile/profile' })
            }
          }
        })
        return
      }
      wx.showModal({
        title: isEdit ? '无法保存结算' : '无法生成结算',
        content: error.message,
        showCancel: false
      })
    })
  },

  startEditSettlement: function () {
    const page = this
    const settlement = page.data.settlement
    if (!settlement) {
      return
    }
    if (settlement.confirmedCount > 0) {
      wx.showToast({ title: '已有同行人确认收款，不能修改', icon: 'none' })
      return
    }
    if (settlement.claimedCount > 0) {
      wx.showToast({ title: '已有同行人标记转账，请先撤销结算', icon: 'none' })
      return
    }
    const selectedIds = (settlement.participants || []).map(function (participant) {
      return participant.userId
    })
    const members = page.data.members.map(function (member) {
      return Object.assign({}, member, {
        selected: selectedIds.indexOf(member.user.userId) !== -1
      })
    })
    const selectedCount = members.filter(function (member) { return member.selected }).length
    page.setData({
      mode: 'edit',
      amount: (Number(settlement.totalFen) / 100).toFixed(2),
      members: members,
      selectedCount: selectedCount
    }, function () {
      page.updateEstimate()
    })
  },

  cancelEdit: function () {
    this.setData({ mode: 'view' })
    this.loadSettlement()
  },

  withdrawSettlement: function () {
    const page = this
    const settlement = page.data.settlement
    if (!settlement) {
      return
    }
    if (settlement.confirmedCount > 0) {
      wx.showToast({ title: '已有同行人确认收款，不能撤销', icon: 'none' })
      return
    }
    const hasClaimed = Number(settlement.claimedCount) > 0
    wx.showModal({
      title: '撤销结算',
      content: hasClaimed
        ? '已有同行人标记“我已转账”，撤销后这些标记会失效，行程会恢复到进行中。确定继续吗？'
        : '撤销后行程会恢复到进行中，可以重新生成结算。确定继续吗？',
      confirmColor: '#b4442a',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        page.setData({ actionLoading: true })
        cloudService.rides('withdrawSettlement', { rideId: page.data.rideId }).then(function () {
          wx.showToast({ title: '结算已撤销', icon: 'success' })
          setTimeout(function () { wx.navigateBack() }, 700)
        }).catch(function (error) {
          page.setData({ actionLoading: false })
          wx.showModal({ title: '无法撤销结算', content: error.message, showCancel: false })
        })
      }
    })
  },

  copyReminder: function () {
    const page = this
    const settlement = page.data.settlement
    const ride = page.data.ride
    if (!settlement || !ride) {
      return
    }
    const lines = [
      '【拼车结算】',
      ride.date + ' ' + ride.time + ' ' + ride.from + ' → ' + ride.to,
      '总车费 ¥' + settlement.totalLabel + '，' + settlement.riderCount + ' 人，人均约 ¥' + settlement.perPersonLabel
    ]
    const payers = (settlement.participants || []).filter(function (participant) {
      return participant.role !== 'owner'
    })
    if (payers.length) {
      lines.push(payers.map(function (participant) {
        return participant.name + ' ¥' + participant.shareLabel
      }).join('、'))
    }
    lines.push('请到小程序拼车团查看收款码并转账，转账后点“我已转账”。')
    wx.setClipboardData({
      data: lines.join('\n'),
      success: function () {
        wx.showToast({ title: '催付文案已复制', icon: 'none' })
      }
    })
  },

  markPaid: function () {
    const page = this
    if (page.data.actionLoading) {
      return
    }
    page.setData({ actionLoading: true })
    cloudService.rides('markSettlementPaid', { rideId: page.data.rideId }).then(function () {
      wx.showToast({ title: '已标记转账', icon: 'success' })
      page.setData({ actionLoading: false })
      page.loadSettlement()
    }).catch(function (error) {
      page.setData({ actionLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  confirmPayment: function (event) {
    const page = this
    const userId = event.currentTarget.dataset.userId
    if (page.data.actionLoading) {
      return
    }
    page.setData({ actionLoading: true })
    cloudService.rides('confirmSettlementPayment', {
      rideId: page.data.rideId,
      targetUserId: userId
    }).then(function () {
      wx.showToast({ title: '已确认收款', icon: 'success' })
      page.setData({ actionLoading: false })
      page.loadSettlement()
    }).catch(function (error) {
      page.setData({ actionLoading: false })
      wx.showToast({ title: error.message, icon: 'none' })
    })
  },

  completeSettlement: function () {
    const page = this
    if (!page.data.settlement || !page.data.settlement.canComplete) {
      wx.showToast({ title: '还有同行人未确认收款', icon: 'none' })
      return
    }
    wx.showModal({
      title: '完成结算',
      content: '完成后拼车团和群聊将关闭，确定已经收齐所有车费吗？',
      success: function (result) {
        if (!result.confirm) {
          return
        }
        page.setData({ actionLoading: true })
        cloudService.rides('completeSettlement', { rideId: page.data.rideId }).then(function () {
          wx.showToast({ title: '结算已完成', icon: 'success' })
          setTimeout(function () {
            wx.switchTab({ url: '/pages/messages/messages' })
          }, 700)
        }).catch(function (error) {
          page.setData({ actionLoading: false })
          wx.showModal({ title: '无法完成结算', content: error.message, showCancel: false })
        })
      }
    })
  },

  previewPaymentCode: function () {
    const url = this.data.settlement && this.data.settlement.paymentCodeUrl
    if (!url) {
      wx.showToast({ title: '发布人还没有上传收款码', icon: 'none' })
      return
    }
    wx.previewImage({ current: url, urls: [url] })
  },

  copyMyShare: function () {
    const settlement = this.data.settlement
    if (!settlement || !settlement.myShareFen) {
      return
    }
    wx.setClipboardData({
      data: (Number(settlement.myShareFen) / 100).toFixed(2),
      success: function () {
        wx.showToast({ title: '金额已复制', icon: 'none' })
      }
    })
  }
})
