function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11)
}

function isValidPhone(value) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(value))
}

module.exports = {
  isValidPhone: isValidPhone,
  normalizePhone: normalizePhone
}
