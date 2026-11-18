const fs = require('fs')
const https = require('https')
const path = require('path')

const BASE_URL = 'https://hudong.moe.gov.cn/school/wcmdata/getDataIndex.jsp'
const EXPECTED_MINIMUM = 2900
const PAGE_SIZE = 20
const TOTAL_PAGES = 148
const OUTPUT_PATH = path.resolve(__dirname, '..', 'utils', 'schools.js')

const PROVINCES = {
  '11': '北京市',
  '12': '天津市',
  '13': '河北省',
  '14': '山西省',
  '15': '内蒙古自治区',
  '21': '辽宁省',
  '22': '吉林省',
  '23': '黑龙江省',
  '31': '上海市',
  '32': '江苏省',
  '33': '浙江省',
  '34': '安徽省',
  '35': '福建省',
  '36': '江西省',
  '37': '山东省',
  '41': '河南省',
  '42': '湖北省',
  '43': '湖南省',
  '44': '广东省',
  '45': '广西壮族自治区',
  '46': '海南省',
  '50': '重庆市',
  '51': '四川省',
  '52': '贵州省',
  '53': '云南省',
  '54': '西藏自治区',
  '61': '陕西省',
  '62': '甘肃省',
  '63': '青海省',
  '64': '宁夏回族自治区',
  '65': '新疆维吾尔自治区'
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
}

function requestPage(page) {
  const url = BASE_URL + '?listid=10000101&page=' + page + '&keyword='
  return new Promise(function (resolve, reject) {
    const request = https.get(url, {
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': 'CampusCarpoolSchoolCatalog/1.0'
      },
      timeout: 20000
    }, function (response) {
      if (response.statusCode !== 200) {
        reject(new Error('教育部目录请求失败，状态码：' + response.statusCode))
        response.resume()
        return
      }
      let html = ''
      response.setEncoding('utf8')
      response.on('data', function (chunk) { html += chunk })
      response.on('end', function () { resolve(html) })
    })
    request.on('timeout', function () { request.destroy(new Error('教育部目录请求超时')) })
    request.on('error', reject)
  })
}

function parseRows(html) {
  const schools = []
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowPattern.exec(html))) {
    const cells = []
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi
    let cellMatch
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      cells.push(decodeHtml(cellMatch[1]))
    }
    if (cells.length < 6 || !/^\d{10}$/.test(cells[2])) {
      continue
    }
    const province = PROVINCES[cells[2].slice(2, 4)]
    if (!province) {
      throw new Error('无法根据学校标识码识别省份：' + cells[1] + ' ' + cells[2])
    }
    schools.push({
      id: cells[2],
      name: cells[1],
      province: province,
      city: cells[4] || province,
      level: cells[5]
    })
  }
  return schools
}

async function fetchAllPages() {
  const pages = Array.from({ length: TOTAL_PAGES }, function (_, index) { return index + 1 })
  const results = []
  const concurrency = 8
  let cursor = 0

  async function worker() {
    while (cursor < pages.length) {
      const page = pages[cursor]
      cursor += 1
      const rows = parseRows(await requestPage(page))
      if (!rows.length) {
        throw new Error('第 ' + page + ' 页没有解析到学校数据')
      }
      results[page - 1] = rows
      process.stdout.write('已读取 ' + Math.min(page * PAGE_SIZE, TOTAL_PAGES * PAGE_SIZE) + ' 条目录位置\r')
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return results.reduce(function (all, rows) { return all.concat(rows) }, [])
}

function validateSchools(schools) {
  if (schools.length < EXPECTED_MINIMUM) {
    throw new Error('学校数量异常，仅解析到 ' + schools.length + ' 所')
  }
  const ids = {}
  schools.forEach(function (school) {
    if (ids[school.id]) {
      throw new Error('学校标识码重复：' + school.id)
    }
    ids[school.id] = true
  })
}

function writeModule(schools) {
  const banner = [
    '// 本文件由 scripts/sync-schools.js 自动生成，请勿手工编辑。',
    '// 数据源：中华人民共和国教育部“全国普通高等学校名单”（截至 2026-06-17）。',
    '// 范围：中国大陆普通高等学校，不含成人高校及港澳台高校。',
    ''
  ].join('\n')
  const body = 'module.exports = ' + JSON.stringify(schools, null, 2) + '\n'
  fs.writeFileSync(OUTPUT_PATH, banner + body, 'utf8')
}

async function main() {
  const schools = await fetchAllPages()
  validateSchools(schools)
  writeModule(schools)
  process.stdout.write('\n已生成 ' + schools.length + ' 所高校目录：' + OUTPUT_PATH + '\n')
}

main().catch(function (error) {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
