# 项目协作（所有 AI 先读）

<!-- ai-dev-lessons:start -->

## 开工前必读：AI 经验仓库

> 本段由 [ai-dev-lessons](https://github.com/cjhkcjgk3-sys/ai-dev-lessons) 统一同步，所有 AI 都要遵守。**ai-dev-lessons 的 `正式/` 是唯一权威**；本文件其余内容只补充本仓库专属规定，与经验仓库冲突时以经验仓库为准。

1. **先读完 [ai-dev-lessons 的 `正式/`](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/tree/main/正式)**：通用准则、检查清单、工作流程、全部模型专项（不只读自己那份）。可 `git clone`／`git pull` 该仓库，拉不到就看网页版，并在汇报里写明没读到哪些。开工汇报第一句写本次相关的条目编号。
2. **先查能不能复用**：本仓库已有代码、SillyTavern 自带功能、兄弟插件，汇报里写明查了哪些。
3. **大改先提方案**：改布局、改交互方式、改数据格式、删功能前，按[方案确认](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/方案确认.md)发给用户，等回复“可以”再动手。
4. **第三次就停**：同一问题修到第 3 次还没好，停止打补丁，按[重新设计](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/重新设计.md)交方案，等用户确认。
5. **边做边记，分清通用和专门**：只在本插件出现的专门问题记在本仓库 [docs/问题与解决记录.md](docs/问题与解决记录.md)；写任何代码都可能遇到的通用问题，按[待审条目](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/待审条目.md)交到 ai-dev-lessons 的 `待审/`，本仓库只留一行链接；拿不准的先记本仓库并标“可能通用”。小问题写清原因、解决、状态，大问题写完整（[小](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-小.md)／[大](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-大.md)）。
6. **版本更新要署名**：谁做正式的版本更新或合并，谁就在 `CHANGELOG.md` 对应版本标题下写一行 `更新人：家族名`（Grok、GPT、Gemini、Claude、DeepSeek，用户自己改的写 human），只写家族名不写型号。只读、查看、审查不用署名；从下一次版本更新开始执行，以前的版本不补。
7. **收尾必须交[交付汇报](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/交付汇报.md)**：“未验证”和“同一问题第几次修”不能省略，没有就写“无”。
8. **待审不是规则**：ai-dev-lessons 里只有 `正式/` 算规则，`待审/` 只供参考；不要直接改它的 `正式/`。

<!-- ai-dev-lessons:end -->

> 通用开发准则已并入 ai-dev-lessons 的 `正式/`（见上），本仓库 [docs/开发准则.md](docs/开发准则.md) 只保留「本仓库专属」规定；冲突时以经验仓库为准。收工前按经验仓库[检查清单](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/检查清单.md)「收尾」清理残留、合并推送、核对远端。

这是 SillyTavern（酒馆）扩展“小说自动生成器”。用户主要在手机上使用，默认暗色主题。

- **先搜再写**：新功能先在 `src/`、`txtToWorldbook/` 和 `style.css` 里找已有的函数、组件和类名，能复用就复用。界面沿用 `menu_button`、`nag-setting-item`、`nag-checkbox-label`、`nag-status-badge`、`nag-modal`、`nag-collapsible` 等现有样式。
- **角色图片库**（`src/novel/roleImageLibrary.js`）：作品 ZIP 来自三个图片仓库，角色、皮肤分别读取 `00-角色清单.md` 和 `01-皮肤清单.md`，旧包兼容 `00-清单.md`；名字匹配规则以 CHANGELOG 1.14.0 为准，不做包含或模糊匹配。改匹配或清单解析时，同步更新图片仓库的《图片收集通用经验》第五节。
- **先翻 [问题与解决记录](docs/问题与解决记录.md)**，遇到问题边做边记，解决后补上解法。命名约定见 [角色命名规则](docs/角色命名规则.md)。
- **提交前**：`npm run verify`（lint、Prettier、TypeScript、模块边界、vitest）。已有失败测试要在汇报里说明，不能新增失败。每次发布先写 `CHANGELOG.md`，同步 `manifest.json`、`package.json`、`package-lock.json` 和 `src/novel/runtime.js` 里的版本号，用中文约定式提交（如 `feat(role-batch): …`）。
- 可以直接提交到 main，不要强推。不要提交凭据或私人聊天内容。汇报写清哪些在模拟环境测过、哪些还没在用户手机或真实酒馆里试过。
