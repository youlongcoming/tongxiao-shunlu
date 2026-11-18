function parseAmountToFen(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw)) {
    throw new Error('请输入正确的车费金额，最多两位小数')
  }
  const parts = raw.split('.')
  const fen = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'))
  if (!Number.isSafeInteger(fen) || fen <= 0) {
    throw new Error('车费必须大于 0 元')
  }
  if (fen > 1000000) {
    throw new Error('车费不能超过 10000 元')
  }
  return fen
}

function buildShares(totalFen, participants) {
  if (!Number.isInteger(totalFen) || totalFen <= 0) {
    throw new Error('车费金额无效')
  }
  if (!Array.isArray(participants) || !participants.length) {
    throw new Error('请至少选择一位实际乘车人')
  }
  const base = Math.floor(totalFen / participants.length)
  const remainder = totalFen % participants.length
  return participants.map(function (participant, index) {
    return Object.assign({}, participant, {
      shareFen: base + (index < remainder ? 1 : 0),
      status: participant.role === 'owner' ? 'owner' : 'pending'
    })
  })
}

function allConfirmed(settlement) {
  if (!settlement || !Array.isArray(settlement.participants)) {
    return false
  }
  const payers = settlement.participants.filter(function (participant) {
    return participant.role !== 'owner'
  })
  return payers.every(function (participant) {
    return participant.status === 'confirmed'
  })
}

function counts(settlement) {
  const payers = settlement && Array.isArray(settlement.participants)
    ? settlement.participants.filter(function (participant) { return participant.role !== 'owner' })
    : []
  return {
    payerCount: payers.length,
    claimedCount: payers.filter(function (participant) { return participant.status === 'claimed' }).length,
    confirmedCount: payers.filter(function (participant) { return participant.status === 'confirmed' }).length
  }
}

module.exports = {
  allConfirmed: allConfirmed,
  buildShares: buildShares,
  counts: counts,
  parseAmountToFen: parseAmountToFen
}
