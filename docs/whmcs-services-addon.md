# Koala Services：WHMCS 插件安装与联调

版本：1.0.4。客户端保留浏览器 OIDC 登录；点击“已登录”后，在账号弹窗中实时读取服务，逐项点击“导入并启用”。不新增套餐菜单。插件运行在现有 WHMCS 的 PHP 环境里。

## 安装包

- 从 [Koala 1.4.5 Release](https://github.com/Pipimax36/Koala.Clash/releases/tag/v1.4.5) 下载客户端和 `koala-services-1.0.4.zip`，ZIP 的 SHA-256 校验文件一并提供。
- 本地生成插件包：`node scripts/package-whmcs-services.mjs`，输出至 `output/whmcs-services/`。

客户端 1.4.4 支持导入后自动启用订阅。macOS 包使用临时签名，尚未进行 Apple 公证。

插件 ZIP 里面的 `modules` 目录对应 WHMCS 根目录下的 `modules`，不是放进 Koala。按当前服务器目录，安装完成后应存在：

```text
/opt/whmcs/modules/addons/koala_services/
├── koala_services.php
├── api.php
└── lib/
    ├── ServiceApi.php
    ├── WhmcsAdapter.php
    └── OidcProof.php
```

1. 解压 ZIP，把 `modules/addons/koala_services` 上传到上述位置。
2. 在 WHMCS 后台的 **Configuration → System Settings → Addon Modules** 中找到 **Koala Services**，点击 **Activate**。
3. 点击 **Configure**，在 **Access Control** 中勾选可管理插件的管理员角色，保存。
4. 打开 **Addons → Koala Services**，完成下表设置，勾选“开启 Koala 服务接口”，保存。
5. 安装新版 Koala，完全退出旧进程，从 `/Applications` 启动。退出账号后重新进行一次浏览器登录，使插件获得这次授权的应用身份凭证。

安装方式遵循 [WHMCS Addon Modules 文档](https://docs.whmcs.com/9-0/addon-modules/addon-modules/)；标准流程是上传文件后在后台激活，不依赖后台 ZIP 导入按钮。

现有 Caddy 的 `root * /opt/whmcs` 与 `php_fastcgi` 可处理该真实 PHP 文件，插件无需新建 `/auth/desktop` 路由。此次交付没有修改 Caddy 配置或 WHMCS 原生登录代码。

## 插件设置

从 1.0.0 / 1.0.1 / 1.0.2 / 1.0.3 更新到 1.0.4：覆盖上传插件目录内的文件即可，不需要停用、重新激活或重新填写设置。此次映射修复只需更新 WHMCS 插件，现有客户端无需重装。

1.0.4 更正订阅映射：WHMCS 服务 `2330` 的 `domain` 为 `3079` 时，查询 Remnawave 用户 `3079`。旧版把 WHMCS 服务 ID 当成面板用户 ID，可能返回 404 或指向错误的用户。现在只读取已授权服务的 `domain`；缺失、非法或查询期间发生变化均拒绝导入，不再回退到服务 ID。

1.0.3 增加导入失败诊断和空列表筛选计数。按当前部署要求，仅对接 Remnawave 3.4+。客户端日志记录每次绑定、列表查询及导入的结果，可用请求编号对照 WHMCS 活动日志。

1.0.2 修复了把 Inactive 客户账户一律拒绝的问题。按 [WHMCS 9 客户状态说明](https://docs.whmcs.com/9-0/clients/client-profile/profile-tab/)，Active 和 Inactive 均允许登录，Closed 不允许。插件现在允许已验证身份对应的 Active / Inactive 客户查询本人的 Active 服务，没有符合条件的服务则返回空列表。Closed 和无法识别的账户状态仍被拒绝；身份验证、owner 权限、商品范围和服务状态检查继续生效。

### 已登录但提示无法访问服务

1. 覆盖上传 1.0.4 后，在 Addons → Koala Services 确认页面显示版本 **1.0.4**。
2. 在 Koala 关闭并重新打开“已登录”弹窗，触发一次新的服务查询。
3. 在 WHMCS **Configuration → System Logs → Activity Log** 搜索 `Koala Services`，读取最新的 `code=...` 和 `request=...`。位置依据 [WHMCS 日志文档](https://docs.whmcs.com/9-0/troubleshooting/logs-in-whmcs/)。

| 诊断码                                           | 意义                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `client-uuid-not-found`                          | 身份令牌已经验证，但 sub 没有匹配到客户 UUID，需要核实映射                            |
| `client-uuid-matches-user`                       | 没有匹配到客户 UUID，但唯一匹配到了用户 UUID；核实后改为 User 映射                    |
| `client-closed`                                  | 匹配到了客户，但客户账户已关闭（Closed）                                              |
| `client-status-unknown`                          | 匹配到了客户，但读取到的账户状态不是 Active / Inactive / Closed；需核实状态读取兼容性 |
| `client-uuid-ambiguous` / `client-uuid-mismatch` | UUID 匹配存在重复或不完全一致，需要检查数据库身份数据                                 |
| `no-owned-accessible-client`                     | User 映射下没有当前用户作为 owner 拥有的 Active / Inactive 客户                       |
| `service-owner-mismatch` / `service-not-active`  | 服务查询结果被归属或状态防线拒绝                                                      |

日志只含固定诊断码、固定说明及服务端生成的请求编号，不记录 token、sub、邮箱或订阅链接。无效访问令牌不会写入这些身份映射日志。只有安装实例上的真实失败请求才能确认根因；若后台没有记录，需进一步核对请求是否被反向代理拦截或日志写入失败。

旧版 `client-inactive` 实际表示“读取到的状态不严格等于 Active”，无法区分 Inactive、Closed 或状态读取异常，不能仅凭此码认定后台账户就是 Inactive。请核对客户 **Profile → Status**；此更新不会修改 WHMCS 的账户或服务数据。

### Koala 客户端诊断日志

安装本次客户端包后，重新打开账号弹窗并点击一次导入，然后通过应用菜单 **工具 → 打开目录 → 日志目录** 找到 `whmcs-services.log`。这是主进程的独立 JSONL 日志，开发者工具的控制台不是读取入口。无需开启额外开关。

每行包含时间、客户端版本、`action`（`bind` / `list` / `resolve`）、`event`、本地 `operationId`；收到响应后还会记录 HTTP 状态、内容类型、插件版本和服务端 `requestId`。操作结束记录耗时、受控错误码、列表数量或导入结果。向支持人员提供失败操作的 `failed` 行，以及同 `operationId` 的 `response` 行即可。

日志只输出白名单字段，不记录 access token、ID token、Client Secret、原始请求/响应、邮箱、OIDC sub、用户姓名、面板 Token 或订阅链接。文件最多约 1 MiB，另保留上一份 `whmcs-services.log.1`；文件写入失败不会阻止查询或导入。

当 1.0.3 及以上插件返回空列表时，`query` 字段还会提供：

| 字段                | 含义                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `clientCount`       | 当前已验证身份可访问的客户账户数                                                                                 |
| `ownedServices`     | 这些客户名下的服务总数                                                                                           |
| `activeServices`    | 上述服务中 Active 的数量                                                                                         |
| `allowedServices`   | Active 且属于允许商品范围的数量                                                                                  |
| `allowedProductIds` | 插件配置的商品 ID（pid）范围                                                                                     |
| `reason`            | `no-owned-services`、`no-active-services`、`product-not-enabled`、`account-or-product-filtered` 或 `unavailable` |

计数只查询当前已验证客户的服务，不提供其他客户数据。诊断失败不改变正常的空列表响应；老插件没有此字段时，客户端不会猜测原因。`account-or-product-filtered` 也可能表示诊断期间数据发生变化，需结合后台数据核实。

导入失败时，客户端 `diagnostic` 与 WHMCS 活动日志的 `code` 使用相同含义：

| 诊断码                                                              | 含义                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `whmcs-service-unavailable`                                         | 导入前未找到仍符合归属、商品与状态要求的服务               |
| `whmcs-service-changed`                                             | 面板查询后复查 WHMCS 服务不再可用，或 domain 映射发生变化  |
| `whmcs-remnawave-mapping-missing`                                   | 已授权服务的 domain 为空，尚无面板用户映射                 |
| `whmcs-remnawave-mapping-invalid`                                   | domain 不是有效的正整数面板用户 ID                         |
| `remnawave-user-not-found`                                          | domain 中的数字 ID 查询返回 404；核对面板是否存在该数字 id |
| `remnawave-id-mismatch`                                             | 面板返回的数字 id 与该服务 domain 中的数字 ID 不相同       |
| `remnawave-user-inactive`                                           | 面板用户状态不是 ACTIVE                                    |
| `remnawave-user-expired` / `remnawave-expiry-invalid`               | 面板用户已过期或到期时间字段无法解析                       |
| `remnawave-access-denied`                                           | 面板返回 401 / 403，检查服务器端配置的 Token 权限          |
| `remnawave-subscription-missing` / `remnawave-subscription-invalid` | 订阅地址缺失或不符合 HTTPS 地址要求                        |
| `remnawave-response-invalid`                                        | 面板响应结构不符合用户查询契约                             |
| `remnawave-request-failed` / `remnawave-configuration-error`        | 面板请求失败，或地址 / Token 配置不可用                    |

客户端 `stage=import` 才表示已经取得地址，进入 Koala 的订阅下载与导入阶段。不能把所有 `service-unavailable` 都归因于 WHMCS 服务未开通。

旧客户端可能尚未识别 1.0.4 新增的两项映射诊断码；按 `requestId` 在 WHMCS 活动日志查看完整固定诊断即可，不影响正常导入。

### 配置字段

| 设置                     | 填写内容                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| Remnawave 面板地址       | 例如 `https://panel.example.com`，不加 `/api`，必须支持 HTTPS               |
| Remnawave API Token      | 在 WHMCS 后台填写有查询用户权限的 Token；后续留空保留原值                   |
| 允许导入的 WHMCS 商品 ID | 商品定义的 `pid`，多个以逗号分隔，例如 `12,15`；不是客户服务 ID `2326`      |
| OIDC 身份映射            | 根据当前实例核实后选择 `Client.uuid` 或 `User.uuid`，见下一节               |
| Koala OIDC Client ID     | 已预填 `COOLGO-NETWORK.e1e6af03fe1090cd698d47a3b3096701`，与 Koala 构建一致 |
| OIDC Issuer              | 已预填 `https://www.coolgo.network`，须与发现文档完全一致                   |

Token 经 WHMCS `encrypt()` 加密保存于插件设置表；后台不回显，也不发送给 Koala。这里无需 WHMCS 管理 API 密钥或 OIDC Client Secret。

## 必须核实的身份兼容性

WHMCS 的 [OIDC 文档](https://docs.whmcs.com/9-0/system/authentication/openid-connect-development/) 将 `sub` 定义为不透明身份标识，没有保证它等于客户或用户的 UUID。插件因此不把 `sub` 当作数字客户 ID，也不按邮箱猜测服务归属。

本版支持两种经过管理员确认的对应方式：

- `sub = Client.uuid`：返回该客户账户的可用服务。客户 UUID 字段在 [GetClientsDetails](https://developers.whmcs.com/api-reference/getclientsdetails) 中有记录。
- `sub = User.uuid`：仅当此实例的 `tblusers` 确实存在 UUID 字段且对应 OIDC subject 时可用；仅返回该用户作为 owner 拥有的客户账户，不向受邀用户开放订阅凭据。

**首次部署须以测试账号的已验证 OIDC `sub`，核对服务器上的 UUID 对应关系，再选择设置。** 不要根据邮箱、截图中的服务 ID 或客户端的哈希用户 ID 选择。不要把 access token、ID token 或订阅链接复制进工单。若本实例的 `sub` 不对应上述任一字段，这一身份适配器仍需依据该实例的认证实现调整；现有选项会拒绝访问，不能宣称支持任意 WHMCS 9.x 安装。

仓库内没有 WHMCS 商业运行时、服务器数据库或真实账号凭据，因此本地回归不能替代这一步。管理员选择映射时，插件会先检查相应数据库字段是否存在。

## 服务与订阅映射

当前部署使用 **WHMCS 服务的 `domain` 字段保存 Remnawave 数字用户 ID**。例如服务 `2330` 的 `tblhosting.domain` 为 `3079`，插件先验证当前登录客户拥有服务 `2330`，再查询面板 `GET /api/users/3079`。客户端展示、导入请求和本地订阅归属仍使用 WHMCS 服务 ID `2330`。

WHMCS 官方分别定义 `serviceid` 对应 `tblhosting.id`、`domain` 对应 `tblhosting.domain`、`serverid` 对应 `tblservers.id`，见 [Module Parameters](https://developers.whmcs.com/provisioning-modules/module-parameters)。服务 ID、商品 `pid`、服务器配置 `serverid` 和面板用户 ID 不能互换。将 domain 用作面板用户映射是当前开通模块的业务约定，并非 WHMCS 通用约定。

此字段必须由开通模块或管理员写入并维护，不能让客户自行指定任意面板用户 ID；WHMCS 默认将 domain 定义为下单输入字段，部署模块需确保开通时写入实际创建的面板用户 ID。Koala 和本插件不会修改 domain，也不接受客户端提交映射。只允许无空格、无前导零的正整数字符串，最大为 `9007199254740991`；字段为空或非法会给出固定诊断，不会尝试其他 ID。

Remnawave 响应须符合官方数字用户 API：`response.id` 与 domain 中的数字 ID 相同（上例为 `3079`），`response.status` 为 `ACTIVE`，`response.expireAt` 未过期，`response.subscriptionUrl` 是 HTTPS 地址。依据 [Remnawave 3.x 用户查询契约](https://github.com/remnawave/backend/blob/010b365ab1fabea01192b5e6ade4e98e66ee1dbd/libs/contract/commands/users/get-user-by-id.command.ts)。

插件只查询 Remnawave 3.4+ 的 `/api/users/{id}`，依据 [官方路由定义](https://github.com/remnawave/backend/blob/010b365ab1fabea01192b5e6ade4e98e66ee1dbd/libs/contract/api/controllers/users.ts)。严格验证返回的数字 id，不按用户名或 UUID 猜测另一个用户，也不尝试旧版本路由。domain 为 `3079` 时需要面板用户对象中的数字 `id: 3079`，仅用户名为 `3079` 并不满足映射。

服务列表只显示允许商品范围内、所属客户状态 Active / Inactive 且服务状态 Active 的项目；列表不依赖 domain 是否已填写，也不批量查询面板。点击导入时才读取已授权服务的 domain 并查询 Remnawave，随后再次检查 WHMCS 客户状态、服务归属、商品范围、服务状态及 domain 映射是否仍相同，全部通过才返回订阅地址。

新版客户端在用户点击“激活订阅”后生成 Koala 远程订阅，切换为当前订阅并热重载内核（按客户端设置也可重启内核），成功后显示“使用中”。已有但未启用的订阅显示“启用”，点击时仍会重新验证 WHMCS 服务并复用已有订阅，不重复新增、不覆盖其他账号的订阅。仅打开弹窗或登录不会改变当前订阅，也不会自动打开系统代理或 TUN。

启用失败时保留已导入订阅，恢复之前的选择并尝试恢复内核配置，显示“订阅已导入，但未能启用，请重试。”；再次点击可重试。退出或切换账号会取消尚未生效的激活，激活期间失效则执行恢复。已导入的本地订阅在退出账号后仍保留。此行为由客户端实现，WHMCS 插件保持 1.0.4，无需重复更新。

## 身份验证与接口

固定入口：

```text
POST https://whmcs.coolgo.network/modules/addons/koala_services/api.php
```

主进程在 Authorization 头发送 bearer access token，并在 POST JSON 的 `identityToken` 字段发送 ID token，不向渲染进程公开它们。身份凭证不放在 URL 或容易被访问日志记录的自定义请求头中。除 `identityToken` 字段外，请求体只支持：

```json
{"action":"bind"}
{"action":"list"}
{"action":"resolve","serviceId":2330}
```

每次请求都通过当前 WHMCS `SystemURL` 下的 `/oauth/userinfo.php` 验证访问令牌。首次绑定还使用固定 `/oauth/certs.php` 的公钥验证 ID token 的 RS256 签名、issuer、Koala audience、时间及 subject 一致性。不会接受其他 OIDC 应用的身份凭证。

WHMCS 的 ID token 可能很快过期，所以 Koala 在登录完成后立即尝试 `bind`。插件保存访问令牌哈希对应的应用身份校验结果，最长 24 小时；后续仍逐次在线验证 access token。数据库不保存原始令牌。绑定过期、原令牌失效或首次绑定未成功时，退出后重新登录。插件未安装/配置时，绑定失败不影响原有 OIDC 登录。

安装会创建 `mod_koala_services_settings` 和 `mod_koala_services_bindings`。停用会关闭接口并清除绑定，保留加密设置以便重新启用。插件不创建订单、不修改服务状态、不创建 Remnawave 用户。

## 验收

本地检查命令：

```sh
php tests/whmcs-services.test.php
php tests/whmcs-oidc-proof.test.php
php tests/whmcs-bindings.test.php
node --import tsx --test tests/auth-*.test.ts tests/services-*.test.ts tests/account-services.test.ts
pnpm typecheck
node scripts/package-whmcs-services.mjs
```

部署后至少用两个测试账号进行联调：

1. 登录账号 A，打开弹窗：只列出 A 的 Active 服务，服务 ID 与 WHMCS 一致。
2. 关闭弹窗，在 WHMCS 更改测试服务状态，再打开：列表反映最新状态。
3. 核对服务 `2330` 的 domain 为 `3079`，导入时应读取面板数字用户 `3079` 的订阅。确认内容可被 Mihomo 使用，导入后它应成为当前订阅并显示“使用中”；已有订阅可点击“启用”。
4. A 不能通过修改 serviceId 导入账号 B 的服务；停用、过期和没有映射的服务导入应失败。
5. 下载期间退出账号，不应写入已退出账号的结果。
6. Inactive 客户可查询本人服务；没有符合条件的服务时显示空列表。Closed 客户被拒绝，即使客户端仍持有此前的登录会话。

排查对照：

| 表现                  | 检查项                                                                                |
| --------------------- | ------------------------------------------------------------------------------------- |
| `plugin-unavailable`  | 文件位置是否正确，API 是否返回 HTML 404                                               |
| `configuration-error` | 插件是否启用、商品和身份设置、服务 domain 映射、面板地址与 Token、数据表/扩展是否可用 |
| `not-signed-in`       | 安装启用插件后退出再登录；Client ID/issuer、公钥及服务器时间是否匹配                  |
| `access-denied`       | 经验证的 sub 与配置 UUID 的实际对应关系、客户状态、owner 权限                         |
| 空列表                | 该客户是否有允许商品下的 Active 服务                                                  |
| `service-unavailable` | 服务归属/状态是否变化，Remnawave 数字 ID、状态或到期时间是否匹配                      |
| `network-error`       | WHMCS PHP 是否能以 HTTPS 访问自己的 OIDC 地址与 Remnawave；PHP cURL/CA/网络超时       |
| `import-failed`       | 订阅链接是否可从用户电脑访问、是否返回 Clash/Mihomo YAML、是否有本地同 URL 冲突       |
| `activation-failed`   | 文件已导入，但内核加载或配置切换失败；检查内核日志并重试启用                          |

本次交付只确认本地代码、契约、权限及文件写入回归；尚未部署到你的 WHMCS，也未用你的 Remnawave Token 完成端到端联调。
