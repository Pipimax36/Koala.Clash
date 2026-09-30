# 应用与内核更新

## 应用更新

- 更新仓库统一配置在 `src/shared/release-source.json`：`Pipimax36/Koalamo`。
- 默认启动时检查，此后每 10 分钟检查；设置中可关闭自动检查或手动检查。
- 读取 GitHub 最新正式 Release 的版本和说明。仓库尚无 Release 时视为没有可用更新；网络错误和限流会保留错误状态。
- 按语义版本比较，仅提示更高版本；保留完整发布标签，兼容带 `v` 和不带 `v` 的已有 Release。
- 用户点击更新才下载，按平台选择 Release 附件，校验 GitHub 提供的 SHA-256 后安装。安装缓存按版本隔离。
- Windows 支持安装版、便携版；macOS 使用 PKG。Linux 从发布页面下载安装包，不支持应用内自动安装。
- macOS 固定安装到 `/Applications/Koala Clash.app`，禁用按 bundle ID 搜索其他目录并重定位。安装后校验该目录中的应用标识、目标版本和可执行文件，再从安装目录重启；安装失败会显示错误，更新弹窗会解除忙碌状态。

## 发布步骤

1. 审批并提交本地修改后，在本仓库 Actions 中手动运行 **Build**，选择要发布的分支。
2. 填写正式版本，如 `1.4.2` 或 `v1.4.2`。两种输入均生成应用版本 `1.4.2`、发布标签 `v1.4.2`；版本应高于已发布版本。
3. 留空则只生成预览版，发布到 `pre-release`，不会推送给正式版更新检查。
4. 所有平台构建成功后，工作流上传安装包和 `latest.yml`；更新客户端以 GitHub Release 的真实标签和附件为准。

当前修复版本为 `v1.4.3`，源码 `package.json` 与更新日志已同步为 `1.4.3`。在合并后的 `main` 分支运行 **Build**，版本输入 `v1.4.3`。工作流只在构建目录设置发布版本，不自动提交回分支；后续发布也应同步更新源码版本与更新日志。

macOS 签名仍使用仓库原有 Apple 证书配置；未配置证书时生成未签名安装包，当前 `notarize: false`，安装包未公证。Telegram 通知与 AUR 发布默认关闭，需配置相应凭据，并分别将仓库变量 `TELEGRAM_NOTIFICATIONS_ENABLED`、`AUR_PUBLISH_ENABLED` 设为 `true`。AUR 还需要该包的维护权限。

## 内核更新

- 使用 Mihomo 官方仓库 `MetaCubeX/mihomo`，与应用仓库独立。
- “内核”页面的更新按钮手动触发；稳定版跟随正式 Release，预览版跟随 `Prerelease-Alpha`。系统内核由用户自己的包管理方式更新。
- macOS：下载并验证压缩包 SHA-256，解压检查实际版本，必要时请求管理员授权，再切换并重启。更新文件保存在应用数据目录的 `cores/`，应用包内的内核不被改写。
- 授权副本仍按文件 SHA-256 绑定；更新时最多保留一个已授权的旧版本供回退，下次授权清理更旧副本。
- 取消授权或校验失败不会切换当前内核；新版启动或版本确认失败，会恢复原来的选择并重启。恢复也失败时保留备份、记录日志并明确报错。
- Windows/Linux 保留 Mihomo 原生更新接口，等待超时延长至 120 秒。

## 本地验证

```sh
node --import tsx --test tests/app-updater.test.ts tests/core-updater.test.ts tests/core-permissions.test.ts tests/release-workflow.test.ts
pnpm run typecheck
pnpm exec electron-vite build
```

测试使用临时目录和模拟的网络、管理员授权及安装器边界，覆盖仓库选择、版本比较、发布标签、安装包完整性、安装后应用校验、内核授权持久化和失败恢复，不更新正在使用的应用或内核。真实安装和重启仍需在 macOS 上单独验收。

macOS 构建后运行 `python3 scripts/verify-pkg-install-location.py dist/Koala.Clash_arm64.pkg`（Intel 包使用 `x64`）。验证器解包读取真实 `PackageInfo`，要求安装到 `/Applications` 且没有启用 bundle 重定位；仅检查 `relocatable="false"` 属性不足以发现此问题。GitHub Actions 在上传安装包前执行相同检查。

### 1.4.2 安装位置问题

1.4.2 的 PKG 仍启用了 bundle 重定位。如果系统已登记其他目录下的同名应用（例如本地构建目录），安装器可能更新那份副本，而没有在“应用程序”中创建应用。安装日志中可见 `relocated to`，即使系统安装器最后提示成功。此问题与应用的公证状态是两个独立问题。

1.4.3 关闭重定位，并在安装后脚本找不到目标应用或内核授权失败时返回非零状态。已发布的 1.4.2 附件不会因源码修复自动改变。旧版更新界面卡住时，可手动安装 1.4.3 PKG，完成后从“应用程序”打开。

如果旧版安装器曾将应用装进项目构建目录，该目录可能留下 `root` 拥有的文件，后续本地打包会报 `permission denied`。确认没有应用从该目录运行后，将自己拥有的 `dist/mac-arm64` 整体重命名保留，再重新构建即可；不要用 `sudo pnpm build:mac` 继续扩大权限问题。
