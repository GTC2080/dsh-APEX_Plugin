# APEX 项目封存

封存日期：2026-10-17（Australia/Sydney）。最终插件版本为 `dsh-apex@1.0.1`，预设 ID 为 `apex-v1`，最后兼容基线为 DeepSeek Harness `0.2.0-rc.2`。

项目开发已经结束。本仓库保存最终源码，完整本地项目作为[同一仓库的 Release 附件](https://github.com/GTC2080/dsh-APEX_Plugin/releases/tag/archive-2026-10-17)保存。仓库归档后只读；需要恢复时下载附件或克隆源码。

## 完整档案

- `apex-complete-archive-2026-10-17.tar.gz`：研究资料、原始记录、模型作品、文献、插件工作文件及安装依赖。
- `APEX-ARCHIVE-MANIFEST.json`：逐文件大小、权限、SHA-256 与符号链接目标。
- `SHA256SUMS`：下载附件后核对其完整性。
- `ARCHIVE-VERIFICATION.json`：本次封存的实际检查结果。

压缩包内 `APEX/` 与 `DSH-Plugin/` 保持原来的相对位置，保留研究资料中的去重映射与冻结清单。插件 Git 数据以 `META/plugin-history.bundle` 单独保存，包含封存时全部本地分支和标签可达的历史；常规 `.git` 缓存、钩子和 reflog 不作为项目资料分发。

## 恢复

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf apex-complete-archive-2026-10-17.tar.gz
git clone META/plugin-history.bundle restored-apex-history
```

完整压缩包已包含最终插件工作文件；Git bundle 用于恢复历史。安装和复测需使用匹配的历史 Harness，遵循[使用说明](docs/APEX-1.0.md)。原始研究中的绝对路径属于当时环境，迁移后按包内相对位置和既有去重映射查找。

## 研究与验证边界

封存保留真实失败、负结果、评分校正和未完成的独立验证。50 次 APEX/PTC 对照没有证明稳定的整体能力增益；高难度作品仍有确认缺陷和未验证项目。历史测试结果继续绑定各自的源码、环境和日期。

封存检查用于确认文件被完整保存、源码可分发和附件可复核。它不代表在当前 Harness 上重新通过了历史运行集成，也不代表完成了未做的物理、装配或 GPU 性能测量。

插件源码遵循 MIT；第三方文献、模型作品中的资源和依赖继续遵循各自的权利与许可说明，不能将仓库许可证套用于全部研究附件。
