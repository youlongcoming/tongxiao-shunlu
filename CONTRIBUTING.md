# 贡献指南

感谢你愿意改进「同校顺路」。这是一个原生微信小程序 + 微信云开发项目，保持简单、可审计和可部署比引入更多框架更重要。

## 开始之前

1. 阅读 [README.md](README.md)、[AGENTS.md](AGENTS.md) 和 [docs/PROGRESS.md](docs/PROGRESS.md)。
2. 检查 `git status`，不要覆盖其他人正在进行的修改。
3. 不要在仓库中写入真实手机号、学号、OpenID、AppSecret、支付密钥或访问令牌。

## 开发约束

- 使用微信原生 WXML / WXSS / JavaScript。
- 不引入 npm 运行时依赖、第三方 UI 框架或构建工具；云函数只使用 `wx-server-sdk`。
- 页面注册同步更新 `app.json`，每个页面保持 `.js/.json/.wxml/.wxss` 四件套。
- 云端身份只能来自 `cloud.getWXContext()`；不要相信客户端传入的 OPENID。
- 敏感写操作必须经过云函数并校验成员关系；不要为了“离线可用”在本地伪造订单、成员或聊天。
- 云端失败时明确报错或显示空状态，不做静默本地降级。
- 手机号、学号、收款码等敏感数据只进入私有资料/私有存储，不进入公开列表或日志。

## 本地检查

```bash
node tests/run.js
```

测试会检查 JSON、页面文件、事件绑定、私有 sitemap、行程时区/过期逻辑和结算领域逻辑。修改页面后，如果条件允许，再用微信开发者工具完整编译并跑双账号流程。

## 提交 PR

1. 从 `main` 创建分支，例如 `feat/group-filter`、`fix/settlement-rounding`。
2. 提交信息用简短的英文祈使句，例如 `fix: reject join after departure`。
3. PR 描述写清楚：改了什么、为什么、如何验证、是否有数据/权限变更。
4. 涉及云函数或数据库权限时，在 PR 中注明需要重新部署的函数和集合。
5. 不要提交 `project.private.config.json`、`.dsh/`、`*.pptx`、云函数 `node_modules` 或任何密钥。

## 隐私与合规

涉及手机号、学号、收款码、聊天、举报、账号注销的改动，必须在 PR 中说明数据流和权限边界。上线前请阅读 [docs/COMPLIANCE.md](docs/COMPLIANCE.md)。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
