# DSH Plugins

这是 DeepSeek Harness 插件的集合目录。每个子目录都是可以独立安装、测试和发布的
DSH bundle；不要把本目录本身当作插件安装。

## 插件

- [`minimal-max`](./minimal-max/README.md)：先以官方 Minimal 请求锚定，再通过持久晋级
  和按需发现解锁 Standard 工具的跨平台实验 preset；当前版本为 v0.2。

安装某个插件时，请指向对应子目录。例如：

```sh
dsh plugin --profile web add /path/to/DSH-Plugin/minimal-max
```
