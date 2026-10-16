# iPhone Fast

使用 iPhone 自带快捷指令和个人自动化，配合一个带网页的 Node.js 服务安排打卡。适用于本项目采用的流程：**手机在特定时间启动快捷指令 → 查询服务器 → 根据 `shouldRun` 等待指定秒数 → 打开打卡 App → 回报完成**。按本项目约定，打开指定 App 即为打卡；服务不读取第三方 App 内部的考勤结果。附带的测试快捷指令打开 iPhone 中的微信。

服务使用 Node.js 24 原生 HTTP、SQLite 和静态页面，无第三方运行依赖，支持 Docker Compose 部署。

## 运行方式与时间规则

网页负责设置计划、保存待办和显示手机回报。页面不定时自动刷新，点击“刷新”获取最新状态；首次打开、登录及提交操作后会加载一次状态。iPhone 上的“特定时间”个人自动化负责启动快捷指令，**手机的实际查询时间仍需在手机上配置**。服务器不能修改个人自动化，也不能主动唤醒手机。

| 功能 | 行为 |
| --- | --- |
| 固定时间 | 开始和结束设为同一分钟，例如 `09:00–09:00`。手机必须在 `09:00:00–09:00:59` 查询领取；错过后不补执行。 |
| 随机窗口 | 例如 `08:50–09:00`，每天从包含首尾的分钟中抽取一个目标分钟，保存到 SQLite。手机在目标分钟至结束分钟内的首次有效查询可以领取。 |
| 立即打卡 | 立即登记待办，等待手机下一次查询。待办从登记起 5 分钟有效，超过时间未领取即过期。 |
| 同日互斥 | 当天任意任务收到接口成功回报后，尚未领取的定时计划会标记为跳过，之后当天不会再触发定时计划；“立即打卡”仍可正常登记和领取。 |
| 暂停或删除计划 | 取消该计划尚未领取的待办。已领取的任务无法撤回，已领取或完成的同一计划当天不会自动重发。 |

随机目标不会因网页刷新或服务重启而重新抽取。修改仍处于 `pending` 状态的计划会按新配置重新生成当天任务；暂停后重新启用也会重新生成。如果当天任务已经过期、下发或完成，修改该计划不会再生成当天任务，新时间从下一个符合星期条件的日期生效。计划窗口必须在同一天内，星期一至星期日分别为 `1–7`，时间使用 `TIMEZONE`，默认 `Asia/Shanghai`。

**随机目标时间与实际执行时间不同。** 假设目标为 `08:56`，手机在 `08:55` 和 `09:00` 查询，实际在 `09:00` 领取。若每天只在 `09:00` 查询一次，随机窗口内的目标最终都会集中到 `09:00` 执行。需要分钟级效果，就要在手机上为窗口内各分钟配置查询自动化。例如 `08:50–09:00` 共 11 个时刻；本项目不依赖后台无限循环或长时间“等待”动作。

“立即打卡”同样受查询频率限制：如果下一次手机查询在 5 分钟以后，这次立即待办会过期。也可以在手机上手动运行同一个查询快捷指令来领取。

等待区间统一在首页“随机等待设置”中配置，例如 `5–10` 秒，对应 API 字段 `delayMinSeconds`、`delayMaxSeconds`。两端必须是 `0–3600` 的整数且最小值不大于最大值；包含两端，两端相同表示固定等待，默认 `0–0` 表示不等待。定时计划不再单独设置秒数。

点击“保存等待时长”后，全局区间写入 SQLite，刷新或重启后仍会回填。区间改变时，尚未领取且启用延迟的定时任务会重新抽取等待秒数，任务标识和计划时间保持不变；重复保存相同区间不会重抽。已经领取的任务和已登记的立即待办保持原等待秒数。

首页有两个按钮：“立即打卡（含定时）”按首页填写的区间抽取等待秒数；“立即打卡（不含定时）”直接使用 `0` 秒，不受区间输入影响。两者均创建立即待办，不更改已有定时计划，仍需手机在 5 分钟内主动查询领取。启用延迟的定时计划统一使用已保存的全局区间。

再次点击任一“立即打卡”按钮时，所有已下发但尚未回报的旧任务立即标记为“打卡失败”，结束旧任务的回报等待，再登记新任务供手机查询领取。尚未领取的立即待办仍防止重复登记。

每个任务生成时抽取等待秒数，保存后通过 `/api/device/poll` 的 `delaySeconds` 下发给手机；普通刷新或重启不会重抽。手机领取后才开始等待，延时不改变领取窗口，因此实际打开时间可能在窗口结束之后。升级为全局等待设置时，旧数据库中尚未领取的定时任务会一次性改用全局区间；已领取任务保持原值。旧计划请求中的独立等待字段不再生效，立即打卡接口仍支持 `delaySeconds` 固定等待。

定时计划的“使用延迟参数”（`useDelay`）默认勾选。勾选时使用全局等待区间，取消勾选后下发 `delaySeconds: 0`。此开关不改变时间窗口，也不修改已领取任务的延时。

**回报期限从手机领取任务开始计算，最多 1 分钟，包含手机的等待秒数。** 满 60 秒仍未回报即标记为“打卡失败”；设置延时不会延长期限。建议先用 `5` 秒测试，为打开 App 和回报留出时间。iOS 长时间等待、锁屏或切换到后台可能中断快捷指令；`3600` 是服务允许的参数上限，延时达到或超过 60 秒的任务会在回报前超时。

## 节假日与调休补班

节假日使用 [完整全年接口](https://holiday.ailcc.com/api/holiday/allyear/2026) `/api/holiday/allyear/{年份}`，仅读取 `data` 数组中的 `date` 和 `type`。原 `year` 接口只返回节假日、不返回补班，因此采用同站的完整年度接口。类型为 `0` 工作日、`1` 周末、`2` 节日、`3` 调休放假、`4` 补班。

服务按 `TIMEZONE` 在每月 1 日 00:00 同步当年数据并保存到 SQLite。首次启动或停机错过月初时会补同步一次；同月重启不会重复自动请求。自动同步失败后保留旧数据，可点击“更新节假日信息”重试，也会在下月再次自动同步。同步前校验年份、全年日期完整性、重复日期和类型，避免将上游返回的其他年份或残缺数据写入数据库。

首页“节假日月历”可以筛选月份，区分上班、周末、节日、调休和补班，并统计当月上班及补班天数。更新按钮同步所选月份的整个年份。尚未同步的年份只按普通星期预览，并明确提示需要更新。

定时计划的“启用调休补班”（`holidayAware`）默认关闭，原有计划继续按勾选的星期执行。启用后的规则：

- `type=4`：补班日执行，即使当天是未勾选的周六或周日。
- `type=1/2/3`：跳过周末、节日和调休放假。
- `type=0`：按照该计划勾选的星期执行。
- 当年数据尚未成功同步：该计划暂不生成任务，避免误把假期当工作日。

节假日更新会重新判断当天安排，取消不再符合条件的待领取任务，并生成需要执行的补班任务；其他待办的随机时间和已领取、已完成记录不变。原有的同日互斥规则仍然生效。“立即打卡”不受节假日开关影响。需要周末补班时，iPhone 个人自动化也要覆盖周末的查询时刻。

## Docker 部署

需要服务器已安装 Docker 和 Docker Compose 插件。

1. 复制配置文件并填写网页登录密码：

   ```sh
   cp .env.example .env
   ```

   `.env` 配置如下，尖括号内容须替换为自己的值：

   ```dotenv
   ADMIN_PASSWORD=<非空的网页登录密码，不限制长度>
   COOKIE_SECURE=false
   TIMEZONE=Asia/Shanghai
   HOST=0.0.0.0
   PORT=2580
   DATA_DIR=./data
   ```

   网页登录只限制控制台页面，业务 API 对知道地址的人开放，无需配置设备或管理员 Token。

2. 构建并启动：

   ```sh
   docker compose up -d --build
   docker compose logs --tail=50
   ```

3. 在浏览器访问 `http://你的服务器IP:2580`，使用 `ADMIN_PASSWORD` 登录。服务器本机也可访问 [http://127.0.0.1:2580](http://127.0.0.1:2580)。

Compose 使用 `2580:2580` 将宿主机端口映射到 Node 服务，手机可以直接通过 HTTP 访问。服务器安全组和防火墙需允许 TCP 2580。手机 URL 不能填写 `localhost` 或 `127.0.0.1`，它们在手机上指向手机自身。

构建后的镜像名称为 `iphonefast:latest`。旧配置未指定 `image`，Compose 会按“项目名-服务名”自动生成 `iphonefast-iphonefast`。镜像名与 Compose 项目名、容器名是不同概念；本次只固定镜像名，服务和数据卷定义保持不变。

HTTP 访问时保持 `COOKIE_SECURE=false`。HTTPS 是可选部署方式；如果另行配置 HTTPS 反向代理，将其转发到 `http://127.0.0.1:2580` 并保留请求的 `Host`，同时设置 `COOKIE_SECURE=true`。如果反向代理也在另一个容器内，可通过同一 Docker 网络访问 `iphonefast:2580`。

Compose 固定容器的 `PORT=2580`、`DATA_DIR=/app/data`，SQLite 文件为 `/app/data/state.sqlite`，保存在命名卷 `iphonefast-data` 中。普通重建或重启会保留数据；`docker compose down -v` 会删除该卷。记录保留约 90 天，网页返回最近 200 条。当前部署按**单实例、单台手机**使用，不要用多个副本共享这份数据。

部署后先用浏览器打开 `http://你的服务器IP:2580/healthz`，正常返回 `{"ok":true}`。`/api/device/poll` 必须使用 POST，直接在浏览器地址栏打开会发送 GET 并返回 HTTP 405，提示将请求方法设为 POST；这不会领取任务，也不表示服务没有启动。

### 更新已有 Docker 部署

在服务器的**原部署目录**操作，沿用原来的 Compose 项目名。默认项目名来自目录名；如果最初使用了 `docker compose -p 项目名`，下列命令也要带上相同的 `-p 项目名`；如果使用 `COMPOSE_PROJECT_NAME`，保留原值。可用 `docker compose ls` 查看已有项目。更换项目名会创建另一份数据卷，表现为原有计划和记录消失。

1. 更新前建议备份 `.env` 和数据库目录。以下为 Linux/macOS shell 命令，暂停服务后复制整个数据目录到部署目录的上一级，保证 SQLite 备份一致；备份完成立即启动原服务：

   ```sh
   backup_dir="../iphonefast-backup-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$backup_dir"
   cp .env "$backup_dir/.env"
   docker compose stop iphonefast
   docker compose cp iphonefast:/app/data "$backup_dir/data"
   docker compose start iphonefast
   ```

   确认复制成功再继续；如果复制失败，先执行 `docker compose start iphonefast` 恢复原服务。

2. 将新版源码更新到原目录。通过 Git 克隆部署的项目可以执行 `git pull --ff-only`；通过压缩包部署的项目，解压新版并覆盖原目录中的源码。保留原 `.env`、Compose 项目名及自行修改的端口等部署设置，不要重新复制 `.env.example` 覆盖已有配置。

3. 重新构建镜像并替换容器：

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=50 iphonefast
   curl -f http://127.0.0.1:2580/healthz
   ```

   健康检查应返回 `{"ok":true}`。随后打开网页，确认原有计划和记录仍在；手机页面如仍显示旧样式，刷新页面。

更新会短暂重启服务，并继续使用原来的数据卷；无需先执行 `down`，不要执行会删除数据卷的 `docker compose down -v`。本项目从本地源码构建镜像，单独执行 `docker compose pull` 或 `restart` 不会更新应用代码。旧的 `iphonefast-iphonefast` 镜像可能仍留在镜像列表中，新容器会使用 `iphonefast:latest`。

## iPhone 6s / iOS 15.8 快捷指令配置

### 直接导入微信测试版

项目提供 `shortcuts/wechat-checkin.shortcut`。用 iPhone 的 Safari 访问 `http://你的服务器IP:2580/shortcuts/wechat-checkin.shortcut` 下载，或将文件保存到 iPhone 的“文件”App 后打开，添加“查询打卡-微信测试”。导入时填写手机能够访问的服务器地址，例如 `http://你的服务器IP:2580`，末尾不要加 `/`，不要填 `localhost` 或 `127.0.0.1`。

附带的 `.shortcut` 已通过 Cherri Playground 签名服务生成，上传内容只含服务器地址占位符。`shortcuts/wechat-checkin.plist` 是可审查的源文件；运行 `node shortcuts/build-wechat.mjs` 只重新生成源文件。修改主体后需重新签名才能替换下载文件，例如在 macOS 上执行 `shortcuts sign --mode anyone --input shortcuts/wechat-checkin.plist --output shortcuts/wechat-checkin.shortcut`。部署更新使用 `docker compose up -d --build`，Docker 会打包签名成品。

测试步骤：网页设置等待区间 `5–10` 秒并点击“立即打卡（含定时）” → 5 分钟内在 iPhone 手动运行快捷指令 → 确认等待后打开手机微信并在领取后 1 分钟内回报 → 回到网页点击“刷新”，确认记录变为“打卡完成”。“立即打卡（不含定时）”下发 `0` 秒。没有待办时不会打开微信。首次运行先解锁手机，完成系统提示；本机代码和文件检查不能代替 iPhone 真机测试。

快捷指令主体已包含下面的请求、判断、等待、打开微信及回报动作。需要手工搭建或调整时可参考以下内容，两次网络请求均无需填写鉴权请求头。

### 1. 查询并保存响应

添加“URL”动作：

```text
http://YOUR_SERVER_IP:2580/api/device/poll
```

添加“获取 URL 内容”，展开“显示更多”：

- 方法：`POST`。
- 请求正文：不需要。如果界面要求选择正文，可选 JSON 并保持为空词典 `{}`。

将输出交给“从输入中获取词典”（不同语言界面名称可能略有差异），把词典保存为变量“查询结果”。随后使用“获取词典值”读取 `shouldRun`。

没有可领取任务时返回：

```json
{"shouldRun": false}
```

有任务时返回：

```json
{
  "shouldRun": true,
  "jobId": "任务标识",
  "ackToken": "本次领取返回的64位回报凭据",
  "source": "schedule",
  "scheduleName": "上午打卡",
  "delaySeconds": 5
}
```

### 2. 判断并打开 App

添加“如果”：仅在 `shouldRun` 的布尔值为 `true` 时进入分支。不要使用“有任何值”作为条件，因为 `false` 也是一个有效返回值。

在该分支中：

1. 创建“运行日志”变量，追加“已领取任务”等实际运行信息。
2. 从“查询结果”读取 `delaySeconds`；若大于 `0`，使用“等待”动作等待该秒数，并在前后追加日志。
3. 添加“打开 App”，选择手机中的“微信”进行测试。之后可改为实际使用的打卡 App。
4. 追加“已打开 App”日志，添加下文的完成回报请求。

`shouldRun=false` 时直接结束，不打开 App，也不回报完成。HTTP 请求失败或词典读取失败时，不应继续执行打开 App 的分支。

### 3. 打开 App 后回报完成

在“打开 App”后面添加“URL”与“获取 URL 内容”：

```text
http://YOUR_SERVER_IP:2580/api/device/ack
```

- 方法：`POST`。
- 请求正文：`JSON`。
- JSON 正文只需一个字段 `callbackJson`：选择快捷指令中逐步追加的“运行日志”变量，保留换行。发送累计日志全文，不需要传 `jobId`、`ackToken`，也不需要手动拼接或转义 JSON。

回报示例：

```json
{
  "callbackJson": "已领取任务\n等待 5 秒\n等待结束\n已打开 App"
}
```

`callbackJson` 支持文本、JSON 对象或数组，不能为空值 `null` 或省略；对象和数组会格式化为文本保存。首页“最近打卡记录”的“运行日志”列按原换行显示，日志作为纯文本展示。重复回报同一份日志不会重复追加；后续回报携带累计日志时更新为该全文。日志随记录保存在 SQLite，刷新和重启不会丢失。

服务将日志关联到最近一次已下发的任务。任务仍在等待回报且未超时时可确认完成，已完成的任务可重复提交日志；最近下发的任务已失败时返回 HTTP 409，不会退回关联更早的记录。没有任何已下发任务时也返回 HTTP 409，不会将尚未领取的任务标记为完成。此格式按单台手机顺序执行：没有任务标识，服务器无法区分新任务下发后的旧任务迟到回报。需要准确区分时，回报中同时保留本次领取的 `jobId`、`ackToken`，可附带 `callbackJson` 日志。

附带的已签名微信测试快捷指令仍可执行两种等待方式，服务兼容其原有 `jobId`、`ackToken` 回报格式。要显示运行日志，在手机上将回报 JSON 设置为仅包含 `callbackJson`，选择实际追加的日志变量即可；未回传日志时页面显示“暂无运行日志”。

JSON 正文会使用 `Content-Type: application/json`；若手动填写请求头，也使用这一值。成功返回 `{"ok":true}`，网页才会显示“打卡完成”。`/poll` 保留的 `jobId`、`ackToken` 用于兼容旧版快捷指令，新格式回报不需要读取或发送它们。

**回报必须位于实际打开 App 之后。** “打开 App”后快捷指令能否继续执行网络回报，需要在你的 iPhone 6s / iOS 15.8 上验证。如果切换 App 导致流程停止，服务会在领取满 1 分钟后将未回报任务标记为失败，不会把领取任务当作完成。

### 4. 创建“特定时间”个人自动化

1. 打开“快捷指令”→“自动化”→“创建个人自动化”。
2. 选择“特定时间”，设置实际查询时刻和重复日期。
3. 添加“运行快捷指令”，选择“查询打卡”。
4. 关闭“运行前询问”（Ask Before Running），确认“不询问”，保存自动化并保持启用。
5. 对需要的其他查询时刻重复配置；服务器端修改计划不会自动改变这些手机设置。

手机的时区应与服务的计划时区对应。第一次先解锁手动运行，完成访问域名等系统权限提示，再测试锁屏下由“特定时间”自动化启动整条流程。你已经验证过锁屏打开 App；本项目仍需验证“定时启动、联网查询、打开 App、回报”这一完整链路，不把单个动作的测试等同于完整验证。

Apple 的 iOS 15 官方文档明确列出“特定时间”可以关闭运行前询问，并说明部分动作还需单独允许自动运行：

- [启用或停用个人自动化（iOS 15 官方文档）](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/5.0/ios/15.0)
- [请求 API：获取 URL 内容、POST 和 JSON 正文（iOS 15 官方文档）](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/5.0/ios/15.0)

上述文档支持定时启动和 HTTP 请求能力；并不保证任意 App、任意锁屏状态或长期后台等待的可靠性。

## API

业务接口均可直接调用，无需网页登录或鉴权请求头。网页控制台仍使用 `ADMIN_PASSWORD` 登录，并通过 `GET /api/session` 检查登录会话。

| 方法和路径 | 权限 | 用途 |
| --- | --- | --- |
| `GET /healthz` | 无 | 服务健康检查 |
| `GET /shortcuts/wechat-checkin.shortcut` | 无 | 下载微信测试快捷指令 |
| `POST /api/login` | 网页密码 | JSON 字段为 `password`，成功后设置登录会话 Cookie |
| `GET /api/session` | 网页会话 | 未登录返回 HTTP 401，已登录返回 `{"ok":true}` |
| `POST /api/logout` | 网页会话 | 退出网页登录 |
| `POST /api/device/poll` | 无 | 原子领取一个有效任务，成功返回 `delaySeconds`；没有任务返回 `shouldRun:false` |
| `POST /api/device/ack` | 无 | JSON 正文只需 `callbackJson` 累计运行日志，自动关联已下发任务并记录完成 |
| `GET /api/state` | 无 | 计划、记录、服务器时间、手机最近查询时间 |
| `GET /api/holidays?month=2026-10` | 无 | 指定月的 `days: [{date,type}]` 和成功同步时间 `syncedAt`；省略月份使用服务器本月 |
| `POST /api/holidays/sync` | 无 | 可选 JSON `{ "year": 2026 }`，省略年份同步服务器当年；返回 `year`、`syncedAt`、`count` |
| `PUT /api/settings/trigger-delay` | 无 | 保存全局随机等待区间并更新未领取的定时任务，返回 `triggerDelay` |
| `POST /api/trigger` | 无 | 可选 JSON 字段 `delayMinSeconds`、`delayMaxSeconds`，或旧字段 `delaySeconds`；创建 5 分钟内需领取的待办，返回 HTTP 202 |
| `POST /api/schedules` | 无 | 创建计划 |
| `PUT /api/schedules/:id` | 无 | 完整更新计划 |
| `DELETE /api/schedules/:id` | 无 | 删除计划并取消未领取待办 |

以下为 Linux/macOS `curl` 示例，请将 YOUR_SERVER_IP 替换为服务器实际 IP。`/poll` 会实际领取任务，调试时使用测试计划或单独测试实例。

```sh
# 创建工作日随机计划；固定时间时令 startTime 与 endTime 相同。
curl -X POST 'http://YOUR_SERVER_IP:2580/api/schedules' \
  -H 'Content-Type: application/json' \
  --data '{"name":"上午打卡","startTime":"08:50","endTime":"09:00","days":[1,2,3,4,5],"enabled":true,"holidayAware":true,"useDelay":true}'

# 登记领取后随机等待 5–10 秒的待办，HTTP 202 不代表手机已执行。
curl -X POST 'http://YOUR_SERVER_IP:2580/api/trigger' \
  -H 'Content-Type: application/json' \
  --data '{"delayMinSeconds":5,"delayMaxSeconds":10}'

# 不含定时：领取后直接执行。
curl -X POST 'http://YOUR_SERVER_IP:2580/api/trigger' \
  -H 'Content-Type: application/json' \
  --data '{"delaySeconds":0}'

# 领取待办，不需要请求正文。
curl -X POST 'http://YOUR_SERVER_IP:2580/api/device/poll'

# 在手机实际打开 App 后，仅用 callbackJson 回报累计运行日志。
curl -X POST 'http://YOUR_SERVER_IP:2580/api/device/ack' \
  -H 'Content-Type: application/json' \
  --data '{"callbackJson":"已领取任务\n等待完成\n已打开 App"}'
```

## 记录与异常

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待手机领取，受窗口或有效期限制。 |
| `delivered` | 已在服务器登记领取，等待手机回报；响应在网络中丢失时也可能出现。 |
| `completed` | 收到关联任务的完成回报，按约定记录为已打开 App。 |
| `failed` | 领取后 1 分钟未回报，或再次发起打卡终止了旧任务的回报等待；不再接受该任务回报。 |
| `unknown` | 旧版本保存的未收到回报记录，保留兼容。 |
| `skipped` | 未领取即超过窗口或立即待办的 5 分钟有效期。 |

领取记录先持久化再返回响应，避免刷新、并发查询或重启后重复下发。同一时刻只发出一个任务，普通手机查询在已有 `delivered` 任务时暂不发出下一个任务；重新发起立即打卡则将旧任务置为 `failed`，新任务可在下一次查询时领取。立即待办优先于定时待办；尚未领取的立即待办不能通过连点重复登记。新任务登记失败时，旧任务的回报等待不会被取消。

服务不自动重发已领取但未回报的任务。满 60 秒的超时会在后台调度、手机查询、回报及网页手动刷新读取状态时检查，与页面是否打开无关。仅含 `callbackJson` 的回报按最近一次下发关联；带 `jobId`、`ackToken` 的回报定位对应任务，失败任务的旧凭据回报返回 HTTP 409。失败状态只表示服务器已结束等待，不会撤回手机上已启动的快捷指令。旧版本的 `unknown` 记录仍兼容有效回报。

## 本地运行与验证

安装 Node.js 24 或更高版本并填写 `.env` 后：

```sh
npm start
npm test
```

没有依赖需要安装。本地默认数据库路径为 `./data/state.sqlite`；Docker 使用前述命名卷。自动化测试覆盖服务与调度逻辑，不代替 iPhone 真机验证。

建议先完成一次最小联调：网页登记“立即打卡”→5 分钟内在手机手动运行“查询打卡”→确认 App 打开，并在领取后 1 分钟内回报→手动刷新网页查看结果；随后设置几分钟后的固定计划，在锁屏状态下验证个人自动化。最后再增加随机窗口和所需的查询时刻。
