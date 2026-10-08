# Koala Services

WHMCS Addon：让已登录 Koala 的用户在账号弹窗中查询本人可用服务，并手动导入对应的 Remnawave 订阅。

安装、配置、身份映射兼容性与联调步骤见 [安装说明](../../docs/whmcs-services-addon.md)。打包执行：

```sh
node scripts/package-whmcs-services.mjs
```

输出 `output/whmcs-services/koala-services-1.0.4.zip`，其中 `modules/` 对应 WHMCS 根目录中的同名目录。Remnawave Token 只在安装后的 WHMCS 后台配置，不放进源码或客户端。1.0.4 从已授权服务的 `tblhosting.domain` 读取 Remnawave 数字用户 ID，不再假定它等于 WHMCS 服务 ID。
