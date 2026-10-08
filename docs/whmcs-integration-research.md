# Koala 对接 WHMCS：可行性分析

> 2026-10-06 实施决定：用户明确要求 Koala 直接对接 WHMCS。下文保留为初始可行性研究；其中的中间认证服务建议已不再采用。当前登录流程、实测地址、密钥配置与验证边界见 [WHMCS 直连登录](./whmcs-direct-login.md)。

研究日期：2026-10-05。范围：登录、商品目录、已购服务、购买入口和订阅交付；仅研究，没有连接用户的 WHMCS 实例或修改应用实现。用户尚未提供 WHMCS 版本、部署形态及代理订阅模块，以下结论区分官方能力与建议设计；实际兼容性仍需测试实例验证。

## 结论

**可行。商品与已购服务展示有官方 API；主要工作在可信登录、用户与客户账户的映射，以及 WHMCS 服务到可用代理订阅的映射。** 建议由自有服务端对接 WHMCS，Koala 调用面向当前用户的业务接口。第一阶段使用系统浏览器登录和 WHMCS 购物车结账，避免同步实现账户、账单和支付系统。

“商品”“服务”“代理订阅配置”应分开：商品是待购买的套餐，服务是客户购买后的实例，代理订阅配置是该实例实际交付的 Clash/Mihomo 内容。WHMCS 前两者有标准能力，最后一项取决于现有 provisioning module 或节点面板。

## 官方能力与边界

| 需求 | 官方能力 | 实施边界 |
| --- | --- | --- |
| 套餐列表 | `GetProducts` 按 `pid`、`gid`、`module` 筛选，提供名称、描述、币种/周期价格、配置选项 | 服务端配置可销售商品白名单；处理币种、周期、配置选项及商品变更。只展示适合 Koala 的商品，不把所有 WHMCS 商品直接透出 |
| 已购服务 | `GetClientsProducts` 按 `clientid`、`serviceid`、`pid` 查询，并分页；响应含服务 ID、状态、续费金额、下次到期日、自定义字段 | 身份验证后由服务端确定客户账户；仅返回 UI 必需字段，不能把原始响应中的密码、内部备注等字段整体交给客户端 |
| 用户与客户账户 | WHMCS 区分登录身份 User 和持有产品、账单的 Client Account；一个 User 可以关联多个账户 | `user_id` 不能当 `client_id`。根据关联关系和权限选择账户；多账户场景应选择账户或明确 MVP 仅支持账户所有者 |
| 账户权限 | `GetUserPermissions(user_id, client_id)` 提供针对客户账户的权限查询，未关联会报错 | 官方示例没有完整展示权限 payload，具体字段及服务查看权限须在目标版本验证 |

对应来源：[GetProducts](https://developers.whmcs.com/api-reference/getproducts)、[GetClientsProducts](https://developers.whmcs.com/api-reference/getclientsproducts)、[Users and Client Accounts](https://docs.whmcs.com/8-10/clients/users-and-client-accounts/)、[GetUserPermissions](https://developers.whmcs.com/api-reference/getuserpermissions)。

建议页面决策顺序为：先确认登录状态，再读取当前账户的目标服务。未登录展示商品及登录入口；已登录且没有相关服务展示商品；已有服务优先展示服务卡片，并保留购买入口。待开通、暂停、已终止等状态仍应展示相应说明，不能因为当前没有可用服务就误称“从未购买”。请求失败应显示错误/重试，也不能降级为空列表。

## 登录方案

WHMCS 官方提供 OpenID Connect 身份提供方能力。其流程通过授权码返回至服务端回调，再由服务端携带 `client_secret` 换取 token。官方要求 HTTPS、校验 `state`，并说明应校验身份 token。OIDC 的 `sub` 是不透明身份标识，不能直接当成数字客户账户 ID。文档列出 `profile`、`email` claims，但未给出直接将 `sub` 解析成有权限的客户账户列表的通用协议。来源：[OpenID Connect Development](https://docs.whmcs.com/8-11/system/authentication/openid-connect-development/)。

**建议架构：Koala → 自有认证服务 → 系统浏览器中的 WHMCS 登录 → 服务端验证身份与账户关联 → Koala 短期会话。** 可将认证服务实现为独立服务加小型 WHMCS addon，或在已有后端中加入 WHMCS adapter；前提是部署允许此扩展。账户映射以受信任的服务端身份与账户关联为依据，不能根据客户端提交的邮箱或 `clientid` 自动绑定。首次绑定以及多账户授权应作为原型重点验证。

桌面应用无法可靠保守随安装包分发的共享密钥，原生 OAuth 最佳实践是使用外部浏览器并防止授权码被截获。来源：[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)。因此建议把 WHMCS 的 OAuth secret 和管理 API secret 都留在服务端；桌面回传使用一次性、短时、绑定原登录尝试的 code，再交换应用会话，避免把长期 token 放在回调 URL 中。**未在本次查阅的 WHMCS 官方 OIDC 文档中找到 PKCE 支持说明，不能宣称其原生支持纯桌面公共客户端 PKCE；应按目标版本实测，或采用服务端桥接。**

不建议将 `ValidateLogin` 成功直接视为完成全部登录。官方说明它验证邮箱和密码，`passwordhash` 只在账户不要求 2FA 时返回，并另有 `twoFactorEnabled`。该接口文档还明确推荐用 OIDC 完成认证服务，未来可能废弃此接口。采用密码直连方案意味着必须自行补齐完整的 2FA、会话和风控流程。来源：[ValidateLogin](https://developers.whmcs.com/api-reference/validatelogin)。

`CreateSsoToken` 的方向是**已经被外部系统认证的用户进入 WHMCS**，适合从 Koala 打开账单或服务详情；它不能充当 Koala 的初始身份验证。token 单次使用、最长有效 60 秒，兑换端不会再次执行常规登录页的 CAPTCHA/2FA。调用前必须完成身份与账户所有权验证，且多用户场景须显式选择正确 `user_id`，避免默认成为账户所有者。来源：[CreateSsoToken](https://developers.whmcs.com/api-reference/createssotoken)。

WHMCS 管理 API 支持按 action 授权的 API Roles。建议建立专用最小权限凭据，服务端分别提供 `/catalog`、`/me/services` 等业务接口，并自行检查当前会话对 `client_id`、`service_id` 的访问权；这些接口不应成为客户端可任意指定 action/客户 ID 的通用代理。来源：[API Credentials](https://docs.whmcs.com/9-1/system/authentication/api-credentials/)。

## 购买和服务生命周期

首期可直接在系统浏览器打开 WHMCS 商品购物车链接，例如 `https://billing.example.com/cart.php?a=add&pid=123&billingcycle=monthly`；也可使用后台商品 Links 页面提供的地址。WHMCS 官方支持商品、商品组、周期、币种及配置选项链接。价格展示可以来自目录，但最终结账金额应由 WHMCS 计算。来源：[Linking to WHMCS](https://docs.whmcs.com/8-10/clients/the-client-area/linking-to-whmcs/)。

支付页面返回应用，只能触发刷新，不能作为开通依据。WHMCS provisioning modules 提供创建、暂停、恢复、终止等服务动作；hooks 中的 `AfterModuleCreate`、`AfterModuleSuspend`、`AfterModuleUnsuspend`、`AfterModuleTerminate` 分别代表对应模块动作成功。来源：[Supported Functions](https://developers.whmcs.com/provisioning-modules/supported-functions)、[Module Hooks](https://developers.whmcs.com/hooks-reference/module)。

建议 MVP 在登录、回到应用、手动刷新时查询服务状态；后续增加 hook 驱动的服务端同步、重试与定期核对。服务端最终授权应同时考虑计费状态与实际订阅交付状态，尤其是付款成功但模块开通失败、暂停后恢复、退款和手工修改状态等情况。hooks 是可编程事件点，不能据此假设 WHMCS 已为你的集成提供可靠的外部 webhook 投递队列。

## 最大未知：代理订阅从哪里来

`GetClientsProducts` 的标准响应没有定义 Clash/Mihomo 订阅 URL；其中虽然有 `customfields`，但这不保证当前模块把订阅地址存放在该字段。不能把 `subscriptionid` 字段解释成 Clash 配置地址，也不能把 WHMCS 通用带宽字段默认视为代理面板的实时流量。此结论来自其公开响应契约的范围，而不是声称 WHMCS 无法经扩展提供这些信息。来源：[GetClientsProducts](https://developers.whmcs.com/api-reference/getclientsproducts)。

需要核实既有模块能否将 `WHMCS service_id` 映射为实际面板账号/订阅，返回兼容 Koala 的 YAML、使用量和到期信息，并在暂停/终止后撤销节点访问。若已有可靠接口，新增一层 adapter 即可；若只有后台页面显示链接，需要给模块增加受鉴权的交付接口；若尚无订阅交付模块，工作范围将扩展为计费、账号开通和节点授权集成，不能仅按“加登录和两个列表”估算。

开源客户端的页面登录无法强制保护服务：使用权限制必须由订阅服务器和节点服务端执行。即使禁止下载新配置，已下载的节点凭据仍可能继续使用，因此暂停/终止是否实际撤销访问应进入验收。

## 建议先验证的条件

1. WHMCS 确切版本、是否自托管、是否允许 addon/hooks、OIDC 配置和实际启用的 2FA 方式。
2. 要展示的商品/商品组、币种和售卖周期；服务是否以标准 products/services 存储。
3. 当前订阅模块和节点面板名称、API 能力、服务 ID 映射、订阅格式、流量/过期字段以及停机撤权方式。
4. 用测试账户走通“浏览器登录 → 取得可信身份和有权访问的客户账户 → 列表 → 订阅导入”；另外测试无购买、多账户、待开通、暂停和跨账户请求。
5. 用测试订单验证“支付成功但开通失败”与“正常开通后刷新”，明确计费成功、服务开通成功、节点可用这三种状态。

目前没有目标实例或测试凭据，尚未验证 OIDC claim 到数字 User/Client 的具体映射、2FA 端到端兼容性、当前模块订阅交付以及服务暂停时的实际节点行为。它们是实施前的验证项，不影响商品目录与服务列表 API 层面的可行性结论。

## Koala 当前代码与改造落点

以下为当前工作区源码核查结果；工作区存在用户已有的未提交改动，本次没有修改业务代码。图索引部分位置过期，相关结论已结合当前文件核对。

| 位置 | 已有能力 | 建议改造 |
| --- | --- | --- |
| [`src/renderer/src/pages/profiles.tsx`](../src/renderer/src/pages/profiles.tsx) | 本地/远程配置列表、导入、更新和选择配置 | 增加套餐目录和我的服务展示，单独维护会话及服务请求状态；本地配置数量不作为购买判断 |
| [`src/main/config/profile.ts`](../src/main/config/profile.ts) | `createProfile` 获取远程配置，校验 Mihomo YAML，解析 `subscription-userinfo`；`addProfileItem` 保存并切换配置 | 复用配置导入链路；若交付接口要求 bearer header，现有下载函数需增加受控鉴权能力 |
| [`src/shared/types/app.d.ts`](../src/shared/types/app.d.ts) | `ProfileItem` 保存本地配置 ID、URL、流量等信息，没有 WHMCS 归属 | 独立建模商品、服务与会话；以稳定的账户/服务 ID 关联本地配置，订阅 URL 轮换不应生成重复服务 |
| [`src/main/index.ts`](../src/main/index.ts) 与 [`src/main/utils/ipc.ts`](../src/main/utils/ipc.ts) | deep-link 当前处理 `install-config`，已有 IPC 注册入口 | 增加独立登录回调和有限的账户业务 IPC；回调只传一次性 code，验证登录尝试绑定关系 |
| [`src/main/utils/encrypt.ts`](../src/main/utils/encrypt.ts) | 使用 Electron safeStorage，但不可用或异常时退回明文 | 新会话存储不能继承此明文降级策略；加密不可用时仅在内存保存会话，不把令牌放入普通配置或日志 |

现有代理认证及本地特权服务签名认证不等于业务用户登录。未发现可直接复用的 WHMCS 会话层。Electron 主进程仍属于用户设备，不能保存随应用分发的 WHMCS 管理密钥。切换账号时还需隔离服务缓存、管理订阅及当前连接，避免上一个账号的资料出现在新账号下。

## 页面状态建议

以下为待确认的产品建议：默认允许未登录用户浏览套餐；是否要求登录后才能使用整个应用，需要另行确定。

| 状态 | 页面默认内容 |
| --- | --- |
| 未登录 | 套餐列表、登录入口；购买进入 WHMCS 流程 |
| 已登录，相关服务确认为零 | 套餐列表及购买入口 |
| 已登录，有可用服务 | 我的服务，展示状态与可用的使用/续费操作，保留选购更多入口 |
| 只有待付款或开通中服务 | 订单/服务进度及付款或刷新入口；不得显示为从未购买 |
| 已购服务暂停或终止 | 历史服务、原因说明及按业务规则提供的续费/重新购买入口；不自动视为可连接 |
| 会话或服务正在加载、查询失败 | 加载、重试或重新登录提示；不能将错误当作空服务列表 |

## 实施顺序与工作量判断

1. **验证闭环**：选择一个测试商品和测试账号，走通可信登录、客户账户授权、服务查询、订阅交付及导入。这一步用于暴露版本和模块限制。
2. **完成首期**：实现服务端接入层、Koala 会话、套餐/服务页面、浏览器购买/续费入口及返回刷新。商品以 WHMCS 为来源，服务状态以服务端为依据。
3. **补齐上线条件**：验证 2FA、多账户权限、注销/切换账号、订阅 URL 轮换、支付后延迟开通和停机撤权；按需要增加 hooks 同步与定期核对。

若当前 WHMCS 已能稳定交付 Mihomo 订阅，整体属于中等规模的应用与后端集成，主要成本在认证及服务适配；商品列表和页面切换成本较低。若尚无订阅模块，则需要额外建设服务开通与节点授权链路。由于部署版本、模块和账号规则未知，本次不作确定工期承诺。

## 开源发布边界

当前仓库的 [`LICENSE`](../LICENSE) 为 GNU GPL v3 文本。对外分发修改版时，需要按该许可处理许可证保留和对应源代码提供等要求（第 5、6 节）。商业服务的账户和使用权校验应在服务端执行，客户端的代码公开与否不能成为收费服务的授权依据。此处仅指出当前仓库许可及相关发布事项，没有核查所有依赖、商标或第三方模块的授权。
