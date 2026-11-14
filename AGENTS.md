# 项目协作（所有 AI 先读）

> **动手之前先读 [开发准则](docs/开发准则.md)**：易用性第一、UI 一致、代码复用、该宽则宽该严则严、按用户意图做。冲突时按准则里的优先级取舍。收工前按准则里的「收尾准则」清理残留、合并推送、核对远端。

这是 SillyTavern（酒馆）扩展“小说自动生成器”。用户主要在手机上使用，默认暗色主题。

- **先搜再写**：新功能先在 `src/`、`txtToWorldbook/` 和 `style.css` 里找已有的函数、组件和类名，能复用就复用。界面沿用 `menu_button`、`nag-setting-item`、`nag-checkbox-label`、`nag-status-badge`、`nag-modal`、`nag-collapsible` 等现有样式。
- **角色图片库**（`src/novel/roleImageLibrary.js`）：作品 ZIP 来自三个图片仓库，清单 `00-清单.md` 是唯一数据源；名字匹配规则以 CHANGELOG 1.14.0 为准，不做包含或模糊匹配。改匹配或清单解析时，同步更新图片仓库的《图片收集通用经验》第五节。
- **先翻 [问题与解决记录](docs/问题与解决记录.md)**，遇到问题边做边记，解决后补上解法。命名约定见 [角色命名规则](docs/角色命名规则.md)。
- **提交前**：`npm run verify`（lint、Prettier、TypeScript、模块边界、vitest）。已有失败测试要在汇报里说明，不能新增失败。每次发布先写 `CHANGELOG.md`，同步 `manifest.json`、`package.json`、`package-lock.json` 和 `src/novel/runtime.js` 里的版本号，用中文约定式提交（如 `feat(role-batch): …`）。
- 可以直接提交到 main，不要强推。不要提交凭据或私人聊天内容。汇报写清哪些在模拟环境测过、哪些还没在用户手机或真实酒馆里试过。
