# 大川学堂 学习时长加速器（Dachuan FastStudy）

四川大学「大川学堂」（`ecourse.scu.edu.cn`）MOOC 视频课的学习时长自动记账工具。

它跳过视频播放，复用时序令牌的漏洞，把服务端应当累计的学习时长直接记到你的课程进度里：一门课几十节视频，通常几分钟跑完全部课时。

---

## 干什么用的

大川学堂的 MOOC 视频课要求「观看时长达到视频总时长的一定比例」才允许标记该节完成。本工具做的事情是：

1. 用 CDP（Chrome DevTools Protocol）接管一个专用的 Edge 窗口，复用你在里面已经登录的会话；
2. 拉取你已加入的全部课程，逐门解析章节目录，统计每节的状态（`status === 2` 为已完成）；
3. 按「未完成 / 已完成 / 无视频资源」分类列出，让你选课、选要刷几节；
4. 对每一节，向服务端刷学习时长，直到达到该节的完成门槛，然后调用完成接口标记完成。

全程在后台用接口完成，不开视频、不占带宽、不占用你的浏览器主窗口。

---

## 原理（为什么能刷）

平台用两个接口配合记账：

- `POST /learn/v1/statistics/course/learntime`：上报一次学习时长。服务端按请求里的 `timeInterval` 记账，但**每次上报前要先从会话里取出一个「计时令牌」并消费掉**；令牌不存在时，服务端按 **上限 45000 ms** 兜底记账。
- `POST /learn/v1/learningsituation/resource/study/status`：查询/更新某节的学习状态，完成门槛以「需至少学习 N 秒」的形式返回。

关键点在于令牌**读一次就消费、且不会因为请求失败而补回**。所以脚本这样打：

1. 先发一条「课程 ID 有效、资源 ID 全 0」的 `learntime` 请求 —— 课程校验通过，令牌被消费掉，但资源无效导致不写回；
2. 紧接着发一条**真实资源**的 `learntime` 请求 —— 此时令牌已空，服务端按 45000 ms 上限记账。

一次循环白拿 45 秒，反复执行直到超过门槛，再调用 `complate` 事件标记完成。脚本自带保护：连续 5 轮学习时长不增长就停下并报错，避免无意义地刷接口。

---

## 用法

### 方式一：直接双击（推荐）

双击 `大川学堂助手.exe`。它会：

1. 启动一个专用 Edge 窗口（`--remote-debugging-port=9222`，独立配置目录），首次使用需要在这个窗口里登录大川学堂，之后自动记住登录态；
2. 扫描你的课程并打印列表；
3. 按提示输入序号（支持 `1` 或 `1,3` 多选）、输入这次要刷几节。

日志写在 `%USERPROFILE%\.ecourse-faststudy.log`。

### 方式二：源码运行

需要 Node.js 22 及以上（用到全局 `WebSocket` 与 `fetch`）：

```powershell
node faststudy.cjs
```

### 命令行参数

| 参数 | 作用 |
| --- | --- |
| `--course=<序号>` | 直接选中课程列表里的第 N 项，不进入交互选择 |
| `--limit=<N>` | 这门课只刷前 N 节未完成的，不询问 |
| `--menu` | 只打印课程列表 |

例：`大川学堂助手.exe --course=3 --limit=5` —— 刷第 3 门课的前 5 节，跑完即退出。

---

## 运行环境

- Windows x64（exe 由 Node 22 的 SEA 打包，内含运行时，无需另装 Node）
- **Microsoft Edge**，且位于下列任一固定路径（代码里写死）：
  - `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - `C:\Program Files\Microsoft\Edge\Application\msedge.exe`
- 本机 `9222` 端口可用
- 能访问 `ecourse.scu.edu.cn`

浏览器登录态保存在 `%LOCALAPPDATA%\ecourse-faststudy-profile`，只在本机，不上传任何地方。

---

## 目录结构

```
大川学堂助手.exe     打包好的可执行文件（内嵌 Node 22 运行时 + 本脚本）
faststudy.cjs        源码（打包用的主文件）
sea-config.json      Node SEA 打包配置
build.ps1            重新打包 exe 的脚本
```

## 重新打包

```powershell
.\build.ps1
```

脚本做的事：`node --experimental-sea-config sea-config.json` 生成 blob → 复制 `node.exe` → 去掉签名 → `npx postject` 注入 `NODE_SEA_BLOB` 资源段 → 输出 `大川学堂助手.exe`。

---

## 说明

- 本仓库仅用于个人学习与 Web 协议研究，记录「一次性令牌 + 上限兜底」这类记账设计如何被绕开。
- 服务端接口与字段（`serviceVersion`、`resourceType`、限速策略）随时可能变更；一旦平台加校验，脚本会直接把错误抛出来并写进日志，不会静默失败。
- 使用时产生的账号数据只留在本机，本工具不收集、不上报任何信息。
