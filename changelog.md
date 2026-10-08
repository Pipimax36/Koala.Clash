## 1.4.4

### 账号与订阅

- 新增 COOLGO 网站账号登录，在系统浏览器完成授权后自动返回 Koala。
- 账号窗口展示当前账号的可用服务，每次打开时从 WHMCS 刷新，支持直接导入订阅。
- 导入订阅后自动启用；已导入的订阅可再次启用，并显示当前使用状态。
- 改善订阅切换失败后的恢复，保留原有订阅及设置，避免退出登录或切换账号时误导入。
- 精简账号窗口，集中展示账号、订阅、到期时间和操作，统一浅色、深色及窄窗口布局。

### 更新与集成

- 在“关于”中新增“检查更新”，保留设置中的原有入口。
- 随版本提供 Koala Services 1.0.4 WHMCS 插件，支持 WHMCS 9+ 与 Remnawave 3.4+；按服务 domain 字段中的 Remnawave 用户 ID 获取订阅。
- 完善登录、服务查询及导入诊断，日志不记录登录令牌、密钥或完整订阅地址。

## 1.4.3

### macOS 安装与更新修复

- 修复无发布证书构建启动即崩溃的问题：为临时签名的 Electron 程序补全动态库加载权限，并统一 Intel／Apple Silicon 构建的签名方式。
- 修复安装器提示成功，但“应用程序”中找不到应用的问题：固定安装到 `/Applications/Koala Clash.app`，禁止重定位到本地构建目录或其他副本。
- 安装后找不到应用或内核权限设置失败时明确报错，避免误报安装成功。
- 应用内更新完成后校验安装位置、应用标识、版本和可执行文件，再从“应用程序”目录重启。
- 修复更新窗口一直转圈、取消按钮无法关闭的问题；安装失败会显示错误。
- GitHub Actions 对 macOS 安装包增加安装路径、重定位、签名和动态库启动检查。

从 1.4.1／1.4.2 升级：如果旧版更新窗口卡住，或此前安装后找不到应用，请直接下载此版本的 PKG 安装，完成后从“应用程序”打开 Koala Clash。

macOS 安装包仍未公证；本次修复解决安装位置与更新流程问题。

## 1.4.2

Koala 首个正式 Release。

### 界面与品牌

- 重构概览、节点、订阅、连接、规则、日志、内核及设置页面，统一紧凑布局、控件比例与浅色／深色主题。
- 使用全新的考拉钥匙孔标志，统一应用、Dock、托盘、关于页面与安装包图标。
- 优化设置及内核页面的「更多设置」，减少重复卡片层级，改善留白和窄窗口布局。
- 修复内核运行状态指示，并改善运行状态与错误反馈。

### 订阅与代理

- 改进 Xboard 订阅请求的客户端标识，正确获取包含 AnyTLS 的 Mihomo 配置。
- 新增订阅默认每 24 小时自动更新，支持不自动更新及 12、24、48、72 小时周期。
- 将订阅主操作调整为「使用此订阅」，突出激活入口。
- 节点页面及托盘菜单在全局模式下仅显示 GLOBAL，规则模式显示分流策略组。
- 改善代理切换、内核授权及更新失败后的恢复与诊断。

### 更新与安装

- 应用更新统一从本仓库的正式 Release 获取，核对版本和安装包完整性。
- 通过 GitHub Actions 构建 Windows、macOS 与 Linux 的 x64／ARM64 安装包。
- macOS 安装包未公证；未配置发布证书时生成未签名安装包。

## 1.4.1

- hotfix

## 1.4.0

- fixed bug with proxy providers
- added new headers: expand-proxy-groups, profile-web-page-name
- minor ui fixes
- added alert about expiring subscription
- new bugs :)

## 1.3.1

- fixed system proxy
- fixed bug from issue #89

## 1.3.0

- new update notifier
- improved ui on proxies page
- added default values for route-exclude-address
- added headers for hiding global mode and downloading custom css
- added yaml view in rules editor
- improved hwid (for Remnawave v2.8.0)
- fix setup public dns on macos
- added translations in monaco editor
- fixed ui for overrided GLOBAL selector



## 1.2.0

- reduced memory usage
- fix problem with deeplink alert after restart with autostart enabled
- implement hot reloading config
- fix bug with adding a rule at the end
- fixed an issue with retrieving data via a proxy
- fixed an issue with profile updates (please test)
- ui fixes
- other optimizations
