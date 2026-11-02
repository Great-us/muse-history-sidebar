# Muse History Sidebar

Unofficial community VS Code extension for browsing and managing local Muse conversation history by workspace folder. This project is independently maintained and is not an official extension from the engine vendor.

- Workspace folders, parent/child conversations, title/path search and paginated read-only previews.
- Archive management and recoverable removal; see the Chinese guide below for the different recovery behavior of each engine.
- Resume a main conversation in its original working directory and switch back to its verified terminal.
- Windows x64; VS Code 1.144.0 or later. Validated with Muse Code 1.4.14. The engine must be installed separately.
- Preview does not fetch remote transcript images or links. No conversation data, account credentials, or recovery backups are included in this repository.

Install the Windows VSIX from [GitHub Releases](https://github.com/Great-us/muse-history-sidebar/releases). The publisher IDs in local packages are `AlexWonton`; Marketplace packages use the AlexWonton publisher identity.

MIT licensed; upstream attribution is retained in `LICENSE`.

---

# Muse 历史记录 · VS Code 侧边栏

按原工作文件夹管理这台电脑上的 Muse Code 对话。独立扩展 `AlexWonton.muse-history-sidebar`，适用于 Windows x64、VS Code 1.144.0 及以上；已用 Muse Code 1.4.14 验证。原 Muse Desktop 可继续使用。

## 使用

安装 VSIX 后，点击 VS Code 左侧的 **Muse 历史记录** 图标。

- 展开文件夹，点击主对话，在其原工作目录打开 Muse 集成终端。再次点击会切回该终端；点击其他主对话会打开或切到另一终端。
- 内部子智能体记录点击后只读预览；右键可明确选择“打开父主会话终端”。当前 Muse 引擎不支持直接恢复这些内部记录。
- 右键对话可预览、归档、取消独立归档，或移到 Windows 回收站。回收一个父记录会包含其磁盘目录内的子记录；界面会确认范围。打开中的对应终端需先关闭。
- 顶部按钮提供刷新、标题/文件夹搜索、归档筛选和引擎选择。每次启动、重新显示侧边栏、切回可见的 VS Code 窗口时重新读取当前历史；也可手动刷新。预览按页加载，可一直加载至末尾。

归档是本扩展自己的视图状态，独立于 Muse Desktop。移到回收站会移动真实的本机会话目录，可通过 Windows 回收站恢复；本扩展不会永久删除或清空回收站。恢复后刷新侧边栏即可重新发现。

原目录已不存在时，会明确提示，避免在错误目录启动会话。若同一会话正在其他 Muse 窗口使用，由 Muse CLI 显示占用提示；“终端已打开”不代表 CLI 已成功获得该会话。扩展不向真实对话自动发送提示词，不关闭其他终端。终端恢复沿用 Muse 原有的登录、提供方、沙箱和信任设置。

0.1.1：Muse 运行中可能暂时不提供会话目录。仅当本扩展能确认自己打开的原生终端仍存活时，侧栏才沿用其已验证的历史启动目录，并标注“目录来自本扩展终端启动记录”；子记录随父主会话分组。该目录只用于显示及切回原终端，不用于另开未知或过期会话。无可信启动记录时明确显示目录未知。

## 安装

在 VS Code 扩展菜单选择 **Install from VSIX… / 从 VSIX 安装…**，选中交付的 `.vsix`。也可使用官方 CLI：

```powershell
code --install-extension .\muse-history-sidebar-0.1.1-win32-x64.vsix
```

引擎默认从本机 Muse 安装和 PATH 中发现。找不到时，点击侧边栏齿轮，选择 Muse 原生 `.exe`。设置项为 `museHistory.enginePath`，仅作用于本机。远程 VS Code 窗口不启动本机 Muse 会话；在本机受信任工作区使用终端功能。

## 从源码构建

需要 Windows x64、Node.js 24+ 和 npm。源码附带 Windows 回收助手的已构建文件；普通扩展构建不需要 Rust。

```powershell
npm ci
npm test
npm run package
```

产物为 `muse-history-sidebar-0.1.1-win32-x64.vsix`。依赖版本由 `package-lock.json` 锁定。`src/backend` 使用 Muse 官方 MSP 接口和文件元数据，`src/ui` 提供树、预览和终端，`native-recycle` 是 Windows 回收助手源码。

如需重新构建助手，先安装 Rust MSVC 工具链和 Visual Studio C++ Build Tools，再运行：

```powershell
.\scripts\build-native-recycle.ps1
```

## 验证

`npm test` 包含普通单元测试；真实引擎和实际回收测试显式启用，默认跳过。真实引擎验收在临时合成 HOME 中创建本地 echo 会话，不修改用户对话：

```powershell
$env:MUSE_TEST_ENGINE = 'C:\path\to\native-muse.exe'
npm test
npm run test:extension
```

`test:extension` 使用本机 VS Code 的隔离配置、扩展目录和合成 Muse HOME，验证真实集成终端、A→B→A 切换、归档持久化及窗口重载。它不会向用户真实对话发送测试消息。可用 `MUSE_HISTORY_TEST_PHASES=reload` 仅运行重载阶段。实际回收测试另需 `MUSE_TEST_RECYCLE=1`，会将明确生成的合成目录送入系统回收站；恢复方式与普通文件相同。

本项目基于 Etienne Lescot 的开源 [Muse Desktop](https://github.com/EtienneLescot/muse-desktop) 中适用的纯历史转换与分组逻辑加工，保留 MIT 授权及署名；具体许可见 `LICENSE`。

## 从本地构建切换

商店版本使用 AlexWonton 发布者，与此前 local-muse-tools 本地构建是不同扩展 ID。本地视图归档标记和终端认回记录不会自动迁移；切换前请保留旧版，并关闭其对应终端后再使用商店版。引擎中的对话文件仍在原处。
