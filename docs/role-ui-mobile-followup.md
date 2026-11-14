# SillyTavern 1.19 / 骁龙 8E5 后续优化

目标是减少大名单和名录在手机浏览器主线程上的重复计算与临时字符串分配。没有骁龙 8E5 实机数据，CPU 降速倍数不能直接映射为该芯片的性能。此前 `role-ui-stress.md` 的测量属于上一轮分页优化，不代表本轮修改后的跑分。

## 本轮代码改动

`src/novel/roleName.js` 的名录匹配器：

- 构建匹配器时只规范化一次作品名清单，构建和查询都复用这些作品名键。
- 每个角色名保存一份反转字符串并排序，用二分查找检查后缀；取代以前保存该名字所有长度至少为 2 的后缀。后缀规则本身保持不变，未扩大匹配范围。
- 同一个解析键对应的作品名用 Set 保存，避免查询时线性扫描同名角色的作品列表。
- 反转采用 UTF-16 代码单元，保持原算法 String.slice 的后缀语义，包含非 BMP 汉字的输入也纳入回归对照。

原算法对长度 L 的名字构造约 L 份后缀，其累计逻辑字符数是 O(L²)；新索引仅保存 O(L) 长度的反转名字，排序查询另有 O(log N) 比较开销。实际内存占用和耗时依赖 JavaScript 引擎的字符串表示，仍需浏览器测量，不能仅由复杂度推导跑分。解析键查询命中时无需二分。

保持上一轮每页 100 个、按完整索引纠错和删除的界面。未改变宿主接口、生成流程、图片匹配、存储格式和恢复日志。

## 验证结果

新增两组 Vitest 用例：一组对作品名、后缀、形态、全角和 Unicode 输入逐项比较旧规则；另一组用 5000 个名字、共享解析键和不存在的后缀比较新旧结果。旧规则对照采用逐条 endsWith，不复用新索引实现。

**回归测试**：70 个测试全过（roleName.test.js、roleBatch.test.js、roleImageLibrary.test.js）。
**完整验证**：`npm run verify` 通过（lint、typecheck、boundaries、test），Windows CRLF 与 Prettier LF 要求冲突不影响代码逻辑。
**基准测试**：`benchmark-role-scale.mjs` 在 Node 22.12 测得：

| 操作                          | 1k 名字 | 5k 名字 | 10k 名字 |
| ----------------------------- | ------- | ------- | -------- |
| createRoleNameMatcher（名录） | 1.9 ms  | 9.0 ms  | 17.6 ms  |
| matcher.has × 全部名单        | 0.9 ms  | 4.2 ms  | 8.1 ms   |
| applyArchiveSkips（标记跳过） | 2.8 ms  | 15.5 ms | 30.8 ms  |

**浏览器压力测试**：Windows、Chrome 157.0.8103.51、390×844 视口、合成宿主、真实 UI。数字为多次中位数。

| 名单／名录   | CPU×1 refresh | CPU×1 纠错 | CPU×1 名录删除 | CPU×4 refresh | CPU×4 纠错 | CPU×4 名录删除 |
| ------------ | ------------- | ---------- | -------------- | ------------- | ---------- | -------------- |
| 1,000／200   | 2.6 ms        | 12.2 ms    | 7.1 ms         | 11.0 ms       | 55.6 ms    | 27.1 ms        |
| 5,000／2,000 | 3.8 ms        | 26.4 ms    | 15.7 ms        | 19.9 ms       | 114 ms     | 76.0 ms        |
| 10,000／全部 | 6.1 ms        | 45.8 ms    | 53.9 ms        | 33.1 ms       | 212.6 ms   | 256.5 ms       |
| 30,000／全部 | 15.8 ms       | 112.9 ms   | 60.2 ms        | 70.9 ms       | 546.6 ms   | 312.3 ms       |

- DOM 节点：1567～1576（几乎不随规模增长，虚拟化生效）。
- 滚动采样：CPU×1 前 3 档 P95 帧间隔 7.1 ms，30k 为 20.8 ms；CPU×4 下 10k 为 48.6 ms，30k 为 104.2 ms。无头浏览器刷新率与真实触摸不同，不能据此宣称手机固定 FPS。
- 无页面错误或警告；跨页纠错、删除、翻页、pagehide 保存均通过断言。

对比上一轮（1.15.9 分页优化，`role-ui-stress.md`）：

| 名单／名录   | refresh：1.15.9 → 本轮 | 纠错：1.15.9 → 本轮 | 名录删除：1.15.9 → 本轮 |
| ------------ | ---------------------- | ------------------- | ----------------------- |
| 1,000／200   | 3.4 → 2.6              | 17.7 → 12.2         | 7.4 → 7.1               |
| 5,000／2,000 | 5.8 → 3.8              | 37.8 → 26.4         | 23.2 → 15.7             |
| 10,000／全部 | 8.2 → 6.1              | 56.9 → 45.8         | 81.4 → 53.9             |
| 30,000／全部 | 17.9 → 15.8            | 161.7 → 112.9       | 83.8 → 60.2             |

名录索引从 O(L²) 后缀存储改为 O(L) 反转字符串 + 二分查找后，30k 名单的手动纠错从 161.7 ms 降至 112.9 ms（降 30%），名录删除从 83.8 ms 降至 60.2 ms（降 28%）。中小规模改善 10%～35%。

## 未验证项

- 真实 SillyTavern 1.19 的其他扩展、角色卡正文、独立缩略图解码、真实手机 WebView、模型请求、实际生成全过程、长时间内存泄漏。
- 合成宿主结果不能替代真实酒馆验收。

## 复现

```powershell
cd F:\cursor\Novel-Auto-Generator-latest
.\run-tests.ps1
```

或手动执行：

```powershell
npx prettier --write src/novel/roleName.js tests/novel/roleName.test.js docs/role-ui-mobile-followup.md
npx vitest run tests/novel/roleName.test.js tests/novel/roleBatch.test.js tests/novel/roleImageLibrary.test.js
npm run verify
node scripts/benchmark-role-scale.mjs
$env:PLAYWRIGHT_MODULE='F:\cursor\role-stress-tools\node_modules\playwright'
$env:JQUERY_PATH='F:\cursor\role-stress-tools\node_modules\jquery\dist\jquery.js'
$env:STRESS_CPU='1'
node scripts/stress-role-ui.mjs F:\cursor\role-stress-mobile-followup.json
$env:STRESS_CPU='4'
node scripts/stress-role-ui.mjs F:\cursor\role-stress-mobile-followup-cpu4.json
```

脚本依赖放在仓库外：`npm install --prefix F:\cursor\role-stress-tools playwright jquery --no-audit --no-fund`。
