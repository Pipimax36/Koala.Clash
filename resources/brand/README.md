# Koala Clash 品牌图标

唯一标志设计源是 [`src/renderer/src/assets/brand-mark.svg`](../../src/renderer/src/assets/brand-mark.svg)：森林绿考拉，中央以钥匙孔形成负形。侧栏直接使用该 SVG。生成脚本为桌面应用图标添加暖白圆角底板、轻微边缘层次和内部留白；应用、Dock、悬浮窗、托盘弹窗和安装包使用这一版本。

执行 `pnpm icons:build`，即可在 macOS、Windows 或 Linux 上从 SVG 重新生成全部格式。三个平台的打包命令也会自动执行这一步，更新以下文件：

- `resources/brand/mark.png`：从 SVG 生成的 1024px 考拉标志预览，不含底板。
- `resources/brand/app-icon.svg`、`app-icon.png`：带暖白圆角底板的桌面应用图标预览，由脚本生成。
- `resources/brand/tray-active.png`：代理启用时的实心考拉模板；`tray-inactive.png`：代理停用时的轮廓模板。脚本会合并相接的轮廓，避免描边重叠。
- `resources/icon.png`、`icon.ico`、`icon_off.png`、`icon_off.ico`：运行时应用、窗口和非 macOS 托盘图标。
- `resources/icon_{on,off}_mac.png` 和 `icon_{on,off}_mac@2x.png`：macOS 菜单栏 20pt 的 1×、2× 图标。
- `build/icon.png`、`icon.ico`、`icon.icns`、`installerIcon.ico`：electron-builder 使用的 Linux、Windows、macOS 应用图标及 Windows 安装器图标。

macOS 菜单栏图标作为 Template Image 使用，系统会根据菜单栏外观设置前景色；实心与轮廓分别表达代理启用和停用状态。应用和安装包使用森林绿考拉与暖白底板。

`koala.png` 和 `blocks.png` 是历史素材，仅保留归档，不参与生产图标生成或新版预览。
