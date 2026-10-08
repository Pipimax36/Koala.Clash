# WHMCS 直连登录

当前登录实现为 **Koala → WHMCS**，不部署中间认证服务，也不需要修改 Caddy 路由。可用服务查询及订阅导入由安装在 WHMCS 内的 [Koala Services 插件](whmcs-services-addon.md) 提供。

## 实际端点

2026-10-08 已重新读取目标站点的发现文档，确认授权端点返回 WHMCS 登录页，且页面的登录表单与授权入口同域。

| 用途       | 地址                                                          |
| ---------- | ------------------------------------------------------------- |
| 发现文档   | `https://whmcs.coolgo.network/oauth/openid-configuration.php` |
| 浏览器授权 | `https://www.coolgo.network/oauth/authorize.php`              |
| 授权码交换 | `https://whmcs.coolgo.network/oauth/token.php`                |
| 用户资料   | `https://whmcs.coolgo.network/oauth/userinfo.php`             |
| 签名公钥   | `https://whmcs.coolgo.network/oauth/certs.php`                |
| 返回 Koala | `koala-clash://auth/callback`                                 |

发现文档中的 issuer 与浏览器授权域名目前都是 `https://www.coolgo.network`。实测从 `whmcs.coolgo.network` 打开的授权页，其登录表单仍提交到 `www.coolgo.network/dologin.php`，但会话 Cookie 未设置 Domain，无法在两个主机间共享。浏览器授权必须使用 WHMCS 公布的 `www` 入口以保持表单与 Cookie 同域；令牌、用户信息和公钥接口继续使用 `whmcs.coolgo.network`。两个域名公布的 OIDC 公钥也已核对一致。

浏览器请求携带公开的 Client ID、`response_type=code`、`scope=openid profile email`、回调地址和每次独立生成的 state/nonce/S256 challenge。收到回调后，主进程校验本地 state、期限和参数，再以表单 POST 请求 token.php，验证 ID token 签名、issuer、audience、时间和 nonce，最后校验 userinfo 的 subject。

## 打包时内置 Client Secret

由应用发布者配置一次，安装用户直接点击登录即可，无需创建文件或设置环境变量。

1. 将从 WHMCS 输入框完整复制的 Client Secret 保存到项目根目录的 `.secrets/whmcs-client-secret.txt`，文件内容只有密钥本身。截图可能截断输入框中的内容，不应靠截图猜测密钥。
2. macOS/Linux 将文件权限设为 `0600`。该目录已加入 `.gitignore`，原始文件也被安装包规则排除。
3. 在项目根目录运行打包命令，例如 macOS：

```sh
chmod 600 .secrets/whmcs-client-secret.txt
KOALA_REQUIRE_WHMCS_LOGIN=1 pnpm build:mac
```

`KOALA_REQUIRE_WHMCS_LOGIN=1` 会在缺少密钥时直接阻止构建，避免交付一个无法登录的安装包。普通开发构建允许没有密钥，以便开源代码仍能独立编译；不含密钥时点击登录会提示配置未完成。

构建只向 Electron **主进程**注入 `__KOALA_WHMCS_CLIENT_SECRET__`，不会将它注入 renderer/preload，也不会把原始密钥文件一起复制给用户。主进程使用内置值直接向 WHMCS 交换令牌，无需依赖本机缓存或系统加密可用性。更换内置密钥需要重新打包发布；新版内置值优先于旧版遗留的加密密钥缓存。

CI 或其他打包环境也可设置以下变量，优先于默认文件：

- `KOALA_WHMCS_CLIENT_SECRET`：完整密钥值，优先级最高。
- `KOALA_WHMCS_CLIENT_SECRET_FILE`：密钥文件路径；构建时相对路径以项目根目录为基准。

GitHub Actions 发布使用仓库 Secret `KOALA_WHMCS_CLIENT_SECRET`。工作流仅在构建步骤注入该值，并强制要求登录配置完整；发布前须在目标仓库配置这个 Secret。

源码和 Git 中不保存实际值，构建异常不会输出密钥。**内置后的值仍可从安装包提取**；主进程隔离、压缩和本机加密都不能把已分发的共享密钥变成服务器秘密。

## 开发者运行时覆盖

这是开发调试入口，安装用户不需要操作。上述两个变量也可在启动应用时传入，用于临时覆盖内置值。运行时文件路径必须是绝对路径，文件必须仅本人可读。例如：

```sh
KOALA_WHMCS_CLIENT_SECRET_FILE=/absolute/private/whmcs-secret.txt \
  "/Applications/Koala Clash.app/Contents/MacOS/Koala Clash"
```

先完全退出已运行的 Koala，再启动新进程。读取顺序是：运行时直接值 → 运行时指定文件 → 打包内置值 → 历史加密缓存。显式提供但无效的覆盖值会报错，不会默默换用别的密钥。

运行时导入的值会使用系统加密保存到 `app.getPath('userData')/auth/client-secret.enc`，原始文件仍由用户管理。内置值直接使用，不需要另外保存到该缓存。系统加密不可用时，显式提供的值仅在内存中使用。

环境变量会从 Koala 后续子进程继承的环境中移除。macOS/Linux 的浏览器回调需要已安装并注册协议的应用；`pnpm dev` 的裸 Electron 进程不会自动成为 `koala-clash://` 的处理程序。

macOS 打开浏览器前还会核对协议实际指向的应用路径。若同时存在 `/Applications` 和项目构建目录中的两份 Koala，系统可能把回调交给另一份应用。请退出旧进程，安装新版到 `/Applications`，并从该位置启动；应用检测到路径不一致时会提示处理，而不会继续发起无法返回当前进程的登录。

原生回调会按顺序等待应用初始化；主窗口关闭或重新加载时会唤醒窗口，并在页面加载完成后继续处理。

## 会话行为

- 登录状态只来自验证过的 WHMCS ID token 和 userinfo；浏览器返回一个 code 不代表登录成功。
- WHMCS 返回的访问令牌与到期时间保存在系统加密的 `auth/whmcs-session.enc`。Renderer IPC 只接收用户展示信息，不接收令牌、密钥或 verifier。
- 重启时重新请求 userinfo 并核对身份，然后恢复已登录状态。过期、身份不符或验证失败会退出本机会话。
- 不假设 WHMCS 提供 refresh token；到期需再次登录，不调用自建 refresh 接口。
- “退出登录”清除 Koala 本地凭据，不注销系统浏览器中的 WHMCS 会话，也不声称撤销服务器令牌。
- 服务插件使用签名 ID token 校验授权确实签发给 Koala。原始 ID token 同访问令牌一起只保存在主进程加密缓存；登录成功后尝试插件绑定，不影响插件尚未安装时的原有登录。
- 旧桥接流程的 `auth/session.enc` 不会用于 WHMCS 直连；需要重新登录。

## 验证

```sh
node --import tsx --test tests/auth-*.test.ts
pnpm typecheck
node --import tsx scripts/check-whmcs-oidc.mjs
```

最后一项检查公开发现文档、公钥、**由实际客户端生成的授权 URL**以及登录表单是否同域，不输入密码、不授权、不交换真实令牌。它不能替代实际账户完成“登录 → 同意授权 → 返回应用”的测试。

当前实例未公布 PKCE 支持信息，代码发送 PKCE 参数但不会把它视为已经确认的服务端保护。nonce 缺失或不符时，验证会失败，不会静默放宽。真实账户验收仍需确认目标版本返回正确 nonce。

直连意味着运行应用的用户能够取得其使用的共享 Client Secret，本机加密不能把桌面应用变为可保密的服务器。本实现按当前要求完成直连能力，不把这一点描述成可安全保守发布密钥的商业方案。

接口依据：[WHMCS OpenID Connect Development](https://docs.whmcs.com/8-11/system/authentication/openid-connect-development/)。原生应用共享密钥限制：[RFC 8252 §8.5](https://www.rfc-editor.org/rfc/rfc8252#section-8.5)。
