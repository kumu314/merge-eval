---
license: MIT
name: runtime-resolution-and-abi
description: '"到底哪个解释器/可执行文件在跑我的代码"——Windows 上多版本运行时并存时的定位与钉死手法。命令存在但退出码奇怪、零输出、装了却找不到、原生模块报 NODE_MODULE_VERSION 不匹配、pip 装了 import 不到、"我本地能跑"之前读。触发词：which python、where node、py -0p、python3 打不开、退出码 49、9009、App Execution Alias、WindowsApps、MODULE_NOT_FOUND、better-sqlite3、ABI、PATH 顺序、venv。'
agent_created: true
---

# 哪个运行时真的在跑

一句话原则：**"命令能找到"和"命令能跑"是两件事；"能跑"和"跑的是我以为的那个"又是第三件事**。Windows 上三层都经常不一致，判定必须逐层做。

## 1. `python3` 之类的命令"存在"，其实是 0 字节壳

- **现象**（本机实测）：`python3 --version` **零输出、退出码 49**，stdout/stderr 都干净；`which python3` 却有结果。
- **根因**：那是 Microsoft Store 的 App Execution Alias，文件本身 `Length: 0`、`Attributes: Archive, ReparsePoint`。交互式桌面环境下它会去拉起商店页；在自动化/无商店环境里就静默失败，不给任何解释。
- **对策**：把这类"存根"当独立失效类处理——**判据不是"有没有输出"，是退出码 + 文件属性**：
  ```powershell
  Get-Item -LiteralPath "$env:LOCALAPPDATA\Microsoft\WindowsApps\python3.exe" -Force |
    Select-Object Length, Attributes
  ```
  `Length=0` 且带 `ReparsePoint` = 壳，不是解释器。真正的解释器用完整路径调（或在"应用执行别名"里关掉这两个开关）。
- **退出码随"谁在读"变，不随壳变**（2026-09-18 同一份 `python3.exe` 壳、各启动器都带真解释器做对照，对照一律 0）：

  | 谁执行 / 谁读 | 读到的退出码 |
  |---|---|
  | Git Bash 直跑该绝对路径，或 `MSYS_NO_PATHCONV=1 cmd /c "<路径> --version"` 由 bash 读回 | **49**（各连测 3 次一致） |
  | `.bat` 里跑完用 `setlocal enabledelayedexpansion` + `echo !ERRORLEVEL!`（**必须在调用之前设**，`setlocal` 自身会把 ERRORLEVEL 清成 0——我第一版就是这么测出假 0 的） | **9009** |
  | PowerShell `& "<路径>"; $LASTEXITCODE` | **9009** |
  | Node `spawnSync(路径, ['--version']).status`（stderr 空、`error` 为 none，所以不是没启动） | **9009** |

  同一个壳在同一个 cmd 里都能给出两个数（`.bat` 内 9009、父进程读回 49），所以**别拿某个固定退出码当"是不是壳"的判据**，只能拿它当"这里出事了"的信号，真判据是下面那条文件属性断言。
- **形态描述也随客户端变**：同一文件 PowerShell 侧 `Length=0` + `ReparsePoint`（`LinkType` 为空），Git Bash `stat -c '%s · %F'` 却给 **`121 bytes · symbolic link`**，`ls -l` 还能指到 `/c/Program Files/WindowsApps/…/AppInstallerPythonRedirector.exe`。两个都对——MSYS 解析了 alias 并报出链接路径长度，Win32 侧报的是那个 0 字节壳本体。所以"0 字节"是**特定客户端的读数**，不是文件属性；跨客户端核对时先固定用哪个读法（同族见 `shell-quoting-and-path-forms §12`「junction 的是链接每个工具答得不一样」与 `shell-quoting-and-path-forms §13`「测量工具会静默消解被测对象的语义」）。
- **判定顺序**：`文件属性` → 再取退出码（**并且记下是哪一层读到的**）→ 最后才看输出了什么。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · Git Bash 5.2.37(1)-release(x86_64-pc-msys)（`stat`/`ls -l` 读数）· Windows PowerShell 5.1.26100.9444（`Get-Item -Force` / `$LASTEXITCODE`）· cmd（`.bat` + `setlocal enabledelayedexpansion`）· Node v24.18.0（`spawnSync`，路径用正斜杠形式）· 2026-09-18。**注意本节原有两个数字是特定客户端读数**：`Length=0` 出自 PowerShell 侧、MSYS 侧报 `121 bytes symbolic link`；`49` 出自 bash/cmd 父进程读回、另三种读法报 `9009`。

## 2. `py` 启动器会把已卸载的版本继续列给你

- **现象**（本机实测）：`py -0p` 第一行列出 `-V:3.13  C:\<某个早已卸载的目录>\python.exe`，但那个文件**根本不存在**；于是 `py -3` 报
  `Unable to create process using 'C:\...\python.exe -c print(1)': ???????????`（后面那串问号是被控制台代码页毁掉的中文错误消息，见 windows-text-encoding §3），**退出码 101**。
  同机器上 `py -3.12` 正常，退出码 0。
- **根因**：启动器读注册表里的版本登记，卸载不干净的残留项照样列出。
- **对策**：`py -0p` 只当线索；**要跑就用绝对路径**，或明确指到带 `*`（默认）的那一项。脚本、批处理、计划任务里一律写绝对路径解释器，理由见 §4。
- **判定**：`"<列出来的路径>" -c "print(1)"` 的退出码才是结论。注册表项在不在、`py -0p` 说什么，都不算。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · `py` 启动器（随 Python 3.12.10 安装） · Git Bash · 2026-09-21。本轮 `py -0p` 列 3 项：第 1 项（默认带 `*` 的那项之外的 3.13）指向 `<盘符>:\<早已卸载的残留目录>\python.exe`，`os.path.exists` = **False**，直接调它 = `FileNotFoundError: [WinError 2]`；另两项 listed 路径存在且 `-c "print(1)"` 退出码 0。`py -3`（跟着默认登记走）退出码 **101**、消息尾部仍是问号串；`py -3.12` 退出码 0。**"退出码才是结论"这条判据成立。** 问号串本轮是在**管道捕获**下取到的，与 `windows-text-encoding §3` 修订后的口径一致（原生启动器按代码页/replacement 写字节，不是 CPython 的 print 路径）。

## 3. 原生模块的 ABI 是按 Node 版本编译的

- **现象**：同一个 CLI，`node dist/cli.js` 报
  `... NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127 ... better_sqlite3.node`
  而换另一个 Node 二进制跑同一条命令就正常。
- **根因**：`better-sqlite3` 这类原生插件按编译时的 **模块 ABI**（Node 24 → 137，Node 22 → 127）产出 `.node`，二进制不向后兼容。机器上并存多个 Node（安装版、nvm/volta/fnm 的 shim、IDE 自带）时，`node` 解析到哪个决定成败。
- **对策**：**先用匹配 ABI 的那个二进制跑，别急着重编**。
- **判定**：
  ```bash
  node -p "process.versions.modules"      # 当前解释器的 ABI
  where node                              # PATH 里谁在前
  ```
  报错里的两个数字直接告诉你缺哪一边：`137`（模块需要）vs `127`（当前运行时）。只有确认全机器只有一个 Node 且确实需要更新插件时才 `npm rebuild`——那会改共享依赖，影响别的调用方。
- **附带**：同一份 `node_modules` 被两个 Node 版本共用时，**任何一方 rebuild 都会让另一方坏掉**。所以多 Node 环境里"共享 node_modules"本身就是坑，各自装各自的。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · Node v24.18.0（安装版，本机唯一，`where node` 与 `process.execPath` 同指一处） · Git Bash · 2026-09-21。**范围要划清**：本轮只复测了"判定"那两条命令——`node -p process.versions.modules` = **137**、`where node` 与 `process.execPath` 都只指同一个二进制。**`NODE_MODULE_VERSION 137 vs 127` 那条报错本身没有复现条件**（本机单 Node，且第二台 Node 要装到系统里才能测），所以 §3 的现象段与"127 = Node 22"那一对数字仍出自原始事故记录，**未验证**；本节可复用的只有"先读 `process.versions.modules` 再决定要不要 rebuild"这条判据。

## 4. PATH 顺序随 shell 变，同一命令在不同会话解析到不同二进制

- **现象**：Git Bash 里 `node --version` 是 A，PowerShell 里是 B；用户终端能跑，自动化环境报"找不到/版本过低"；计划任务里连命令都找不到。
- **根因**：Machine PATH 与 User PATH 拼接顺序不同、各 shell 的 profile 追加不同目录、Windows 存根目录排在真实安装之后（或之前）。
- **对策**：任何要交付/复用的脚本，**内部写绝对路径**（`D:\<node 安装路径>\node.exe`、`C:\<python 安装目录>\python.exe`），别依赖 PATH 解析；`.bat`/`.ps1` 里同理。给非技术用户的东西要"找不到就明确提示改这一行"，否则他们会卡在看不懂的 9009。
- **判定**：
  ```bash
  which -a python python3 node npm        # 列出所有候选与优先级
  ```
  多行输出 = 存在解析歧义，必须钉死。**长任务里把实际用的解释器路径打出来**（`sys.executable` / `process.execPath`），这样日志本身能证明跑的是哪个。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · Git Bash 5.2.37（`which -a`） · cmd（`where`） · Windows PowerShell 5.1.26100.9444（`Get-Command`） · 2026-09-21。本轮歧义复现在 **python** 上不在 node 上，这点按实数写：bash `which -a python python3 node npm` 给 **6 行**（`python` 2 个安装位置 + `python3` 只有 WindowsApps 那个壳 + `node` 1 个 + `npm` 2 个）；cmd `where python`/`where node` 给 **3 行**（python 2 个——它不含 `python3` 那次查询，所以列出的集合与 bash 不同，比较时**得先确认两边问的是同一批名字**）；PowerShell `Get-Command` 里 `python` 与 `python3` 解析到**不同目录**（前者真解释器、后者 §1 那个壳），bash 里 `python3 -c` 直接 **9009**。node 三个 shell 都解析到同一个二进制——**原文"Git Bash 是 A、PowerShell 是 B"这一路本轮未复现**，成立的是"同一类命令在不同 shell 解析结果不同（含'这里根本没有'）"这个更弱的版本 + "多行输出 = 必须钉死"这条判据。

## 5. `MODULE_NOT_FOUND` 常常不是没装，是解析根不对

- **现象**：`require('playwright')` 报 `MODULE_NOT_FOUND`，可项目里明明装了；同一份代码 `cd` 到别的目录跑就好了。
- **根因**：Node 的模块解析从**脚本所在目录**逐级向上找 `node_modules`，不是从当前工作目录；Python 的 `import` 则受 `sys.path[0]`（脚本目录）影响。把脚本放到临时目录、或从别处调用，就换了搜索根。
- **对策**：脚本要引用项目依赖时用**绝对路径 require**（或从项目根用相对路径起脚本），或显式设 `NODE_PATH`；Python 侧 `sys.path.insert(0, str(Path(__file__).parent))` 而不是靠 cwd。
- **判定**：报错信息里会写明它查过哪几个路径——先看那份列表，再决定装不装。缺的是"搜索根"时，重复安装只会掩盖问题，且换个调用方式又复发。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · Node v24.18.0 + Python 3.12.10 · Git Bash · 2026-09-21。**两侧都测，且各带一个反向对照**：
  - Node：包放在 `A\node_modules\tinypkg`、脚本放 A → **cwd 换到别处仍解析成功**（证明根是脚本目录）；脚本放 B（B 及其上级无 `node_modules`）→ `Error: Cannot find module 'tinypkg'` + `code: 'MODULE_NOT_FOUND'`，`requireStack` 明写起点是 `<B>\probe.js`；同一句设 `NODE_PATH=<A>\node_modules` 后恢复解析（`对策` 那条实测有效）。
  - Python：模块与脚本同目录、cwd 在别处 → import 成功；模块放在 **cwd**、脚本在别处 → `ModuleNotFoundError`。这两条一起才是"搜索根是脚本目录、cwd 不参与"的完整证据，只测第一条不能排除"cwd 也管用"。另注：`python -c` 那侧 `sys.path[0]` 实测是空串 `''`（含义 = cwd），与脚本路径模式不同，**别拿 `-c` 的读数给脚本下结论**。

## 6. venv 激活脚本在各 shell 里不一样，未激活不等于安全

- **现象**：`pip install` 装到了全局；或者激活了 venv 但 `python` 仍是系统解释器（PowerShell 执行策略挡了 `Activate.ps1`，命令照样"执行成功"）。
- **对策**：**不依赖激活状态**，直接用 venv 里的解释器绝对路径 `<venv>\Scripts\python.exe -m pip install ...`、`<venv>\Scripts\python.exe script.py`。同理安装依赖永远走 `python -m pip`，让 pip 和 python 必然同前缀。
- **判定**：`python -c "import sys; print(sys.prefix, sys.base_prefix)"` —— 两者不同才是 venv 里；相同就是系统解释器，装了也白装到项目环境。
- **验证于**：Windows 11 家庭中文版 10.0.26200.9457 · Python 3.12.10（`-m venv` 新建，未激活） · 2026-09-21。判定命令两侧各取一次：系统解释器 `sys.prefix == sys.base_prefix`（同一目录）；新建 venv 内的 `<venv>\Scripts\python.exe` 两值不同（`sys.prefix` = venv 根、`sys.base_prefix` = 系统安装目录）。`<venv>\Scripts\python.exe -m pip --version` 报出的 pip 就在 `<venv>\Lib\site-packages\pip`，即"用 venv 解释器走 `-m pip` 必然同前缀"这条对策成立——**全程没有执行任何 Activate 脚本**。**未复测**：`Activate.ps1` 被执行策略拦掉那一岔（属 §7 的范围，本轮没取新读数），以及"激活了但 `python` 仍是系统解释器"的具体现场。

## 7. PowerShell 执行策略：脚本"根本没跑起来"的四岔定位

- **现象**（本机实测）：脚本明明在、路径也对，`powershell -File x.ps1` 却报
  `File <盘符>:\<项目>\x.ps1 cannot be loaded because running scripts is disabled on this system.`（`SecurityError`，退出码 1）；
  或同一个 `.ps1` 在终端能跑、换到计划任务/别的宿主就报同样错；或 Git Bash 里 `./x.ps1` 直接 `line 1: Write-Output: command not found`（退出码 127）。
- **根因**：执行策略有五档，生效档取**优先级最高的"已定义"档**，不是最严也不是最松。
  **读下面这张表之前先确认它是怎么来的**：`Process` 档由"谁启动了当前这个 PowerShell"决定，换宿主就换值，**它不是这台机器的属性**。本会话这份读数出自一个带 `-ExecutionPolicy Bypass` 启动的宿主；同一个库里裸启动得到的是另一份（见下面的对照表）。

  ```
  Scope          ExecutionPolicy
  MachinePolicy  Undefined
  UserPolicy     Undefined
  Process        Bypass         ← 只在"父进程已设 Bypass"的宿主里成立，裸启动这行是 Undefined
  CurrentUser    RemoteSigned
  LocalMachine   Undefined
  ```

  三种启动方式实测（2026-09-18 复跑：`inner.ps1` 内自打印 `Get-ExecutionPolicy -Scope Process` 与 `Get-ExecutionPolicy`，由三种父调法各起一次，除标注外不加参数）：

  | 启动方式 | Process 档读到 | 生效档 `Get-ExecutionPolicy` 读到 |
  |---|---|---|
  | 裸启动 `powershell -NoProfile -File inner.ps1` | `Undefined` | **`RemoteSigned`**（跳过 Undefined 档，回落到 CurrentUser） |
  | `-ExecutionPolicy Bypass -File inner.ps1` | `Bypass` | `Bypass` |
  | `-ExecutionPolicy Restricted -File inner.ps1` | `Restricted` | `Restricted`；未签名脚本被拒：`cannot be loaded because running scripts is disabled on this system`（`SecurityError` / `UnauthorizedAccess`），退出码 1 |

  上面那份 `-List` 的优先级是 `MachinePolicy > UserPolicy > Process > CurrentUser > LocalMachine`，所以**在被 Bypass 抬起来的宿主里**生效的是 Process=Bypass（第一个非 Undefined 档）。三个反直觉点（全部实测）：
  1. **Process 档会传给子进程**：把父会话 `Set-ExecutionPolicy -Scope Process Restricted` 后，子 `powershell -Command 'Get-ExecutionPolicy'` 读到 `Restricted`；父是 Bypass 时子也 Bypass。所以"终端里明明能跑"往往因为交互 shell 本身带 `-ExecutionPolicy Bypass` 启动（不少自动化宿主/IDE 如此），**计划任务/独立进程没继承这个 Process 档，回落到 CurrentUser=RemoteSigned，未签名脚本立刻被拦**。
  2. **Git Bash 的 `./x.ps1` 不归 PowerShell 管**：无 shebang 的 `.ps1` 被 bash 当 bash 脚本执行，`Write-Output` 不是 bash 命令 → 127；带 `#!/usr/bin/env pwsh` 但 pwsh 没装 → `/usr/bin/env: 'pwsh': No such file or directory`，同样 127。`Bypass` 在这里救不了——这不是执行策略问题。
  3. **编码是另一种"Bypass 救不了"**：无 BOM 的 UTF-8 被 PS51 按 GBK 静默换码（见下，与 windows-text-encoding §1 一致）。

  Restricted 下四种调法逐一实测（同一 `ok.ps1`，内容 `Write-Output ok`）：

  | 调法 | Restricted 下 | Bypass 下 |
  |---|---|---|
  | ① `powershell -ExecutionPolicy Restricted -File ok.ps1` | 挡：`cannot be loaded because running scripts is disabled on this system`，退出码 1 | `ok`，退出码 0 |
  | ② `powershell -ExecutionPolicy Restricted -Command "& 'ok.ps1'"` | 同样挡（`&` 载入脚本文件照查政策），`PSSecurityException`，退出码 1 | `ok`，退出码 0 |
  | ③ Git Bash `./ok.ps1`（无 shebang） | `Write-Output: command not found`，退出码 127 | 同样 127（Bypass 无关） |
  | ④ `pwsh -File ok.ps1` | 未测到（本机未装 pwsh） | 未测到 |

  反直觉结论（本机实测）：**真 Restricted 下 ①② 都被挡，没有哪种 PowerShell 调法"其实能跑"**；真正"没设策略却跑起来"的是**继承了父进程 Process=Bypass 的子会话**——判定别看 CurrentUser 档，看 `Get-ExecutionPolicy` 的实际返回值。**但取这个返回值时要按上面三种调法各读一次**：在被 Bypass 抬起来的会话里读，拿到的是继承值 `Bypass`，它既不等于机器默认档、也不代表下一个宿主能跑；只在裸启动里读到 `RemoteSigned`，同样不代表"这台机器没被放行过"。
- **编码交叉**（`-File` 在 Bypass 下实测，控制台代码页 936/GBK）：
  - UTF-8 带 BOM（首三字节 `efbbbf`）：**读入**正常，`ok`，退出码 0——但这只修好了读入方向，写出见下面第二组。
  - UTF-8 无 BOM：**首三字节取决于脚本第一行写了什么，不取决于内容编码**。真实 `.ps1` 首行常是 `# 中文注释`，实测首三字节 `2320e4`（`#` + 空格 + `中` 的 UTF-8 首字节），既不是 `efbbbf` 也不是 `e4b8…`；只有以中文直接开头才是 `e4b8ad…`。两种都跑通、退出码 0，注释被按 GBK 静默解成乱码（**不可见**）。
  - GBK（首三字节 `d6d0ce…`）：注释正常，`ok`，退出码 0。
  - 中文字符串 `Write-Output '中文'`：**退出码恒 0**，但"损坏"分三层，别只按终端看到的样子下结论。同一个脚本只差开头 3 字节 BOM，原始 stdout 字节逐个取回（2026-09-18）：

    | 观测层 | 无 BOM 版 | 带 BOM 版 |
    |---|---|---|
    | 进程内部（`.Length` 与码点，纯 ASCII 输出） | `LEN=3`，`6d93,e15f,6783` | `LEN=2`，`4e2d,6587`（正确） |
    | stdout **原始字节** | `e4 b8 ad e6 96 87` = 恰好还原成原始 UTF-8 | `d6 d0 ce c4` = GBK |
    | 936 终端显示 | 看着是 `涓枃`（中间那个 U+E15F 在私用区，根本显示不出来） | 正常 |

    由此两条：**① 字节往返保真**——错解出来的 mojibake 再按 GBK 编回，字节恰好还原（误读与回编走同一张表），所以**按字节消费的下游拿到的是正确 UTF-8**，"数据静默损坏"只在**进程内部**成立（长度、`Substring`、正则、字符串比较全错），按字节 diff 看不出来；**② 补 BOM 只修读入**——带 BOM 那版写出的是 GBK 字节，一个按 UTF-8 解码的下游**反而在这版**看到乱码。要稳定的 UTF-8 输出得另设 `[Console]::OutputEncoding`（或 `chcp 65001`，但它只动显示层，见 windows-text-encoding §3）。写读两个方向要各自断言，不能给一个 BOM 就宣布两头都好。
    为什么同一份字节 PowerShell 不报错而 Python 报：`.NET` 的 `Encoding.Default` 在本机是 `gb2312`/CodePage 936，`DecoderFallback=InternalDecoderBestFitFallback`，非法字节对 `ade6` **折不报错、映射进私用区 U+E15F**；Python 的 `gbk` 编解码器严格，同一份字节抛 `UnicodeDecodeError: 'gbk' codec can't decode byte 0xad in position 2`（退出码 1）。所以"有没有抛异常"是**运行时容错设置的差异，不是数据好坏的差异**——判据只能取字节 + 码点，取退出码会得出完全相反的结论（同 `windows-text-encoding §8`）。
  "中文注释吃掉第一行"在本机（cp936）**未测到**：注释始终是注释、行不吞；真正危险的是**字符串/参数里的中文**被静默换码。与 windows-text-encoding §1 的"PS 5.1 把无 BOM 的 UTF-8 按系统 ANSI(GBK) 解码"**一致**，不另立版本；补充一点差异：注释场景乱码不可见且照常跑，只有字符串/输出才会暴露。
- **对策**：
  - 交付/调度脚本一律绝对路径 + 进程级放行：`powershell -NoProfile -ExecutionPolicy Bypass -File "<盘符>:\<项目>\x.ps1"`（`.bat` 里固定这么起，见 windows-text-encoding §1）。
  - 含中文的 `.ps1` 存 **UTF-8 with BOM**；无 BOM 的 UTF-8 在本机会被 GBK 静默换码，字符串场景直接出脏数据且退出码 0。
  - 从 Git Bash 调 powershell：**用单引号包住 `-Command` 整段**，或干脆走 `-File` 传绝对路径，别把 `$` 交给 bash 展开（细节见 shell-quoting-and-path-forms §1）。实测坏写法 `bash -c "powershell -Command \"Write-Output $env:USERPROFILE\""`：bash 把 `$env:USERPROFILE` 展开成空，PS 收到无参 `Write-Output` 报 `Cannot process command because of one or more missing mandatory parameters: InputObject`；单引号版正常输出用户目录。
  - `-ExecutionPolicy Bypass` 只管**这一条命令**（实测：子进程读回 Bypass 的同时父进程仍 Restricted）；`Set-ExecutionPolicy -Scope Process` 会留在当前会话，**用完必须恢复**（红线：不改机器/用户级策略）。
- **判定**（30 秒四岔，每岔一条命令）：
  1. **政策？** `powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1` —— 能跑=政策挡的（含"继承丢档"）；仍报 `cannot be loaded` 才看 2)。
  2. **编码？** 两步，且**第二步必须跳过行首 ASCII**——真实 `.ps1` 首行往往是 `# 中文注释`，直接 `read(3)` 得到的是 `2320e4`（`#`+空格+`中` 的 UTF-8 首字节），三条规则一条都不匹配，会被误判成"未知编码"：
     ```bash
     python -c "b=open('x.ps1','rb').read();print('BOM' if b[:3]==b'\xef\xbb\xbf' else 'no-BOM')"
     python -c "b=open('x.ps1','rb').read();n=next((i for i,c in enumerate(b) if c>0x7f),None);print('ALL-ASCII' if n is None else b[n:n+3].hex())"
     ```
     本机实测四组取值：带 BOM 的 `# 中文注释` → `BOM` + `efbbbf`；无 BOM 同内容 → `no-BOM` + `e4b8ad`（UTF-8）；GBK 存的首行中文注释 → `no-BOM` + `d6d0ce`；纯 ASCII 脚本 → `no-BOM` + `ALL-ASCII`（**不可能被换码坏，这一岔直接跳过**）。含中文且无 BOM → 转 UTF-8+BOM，但记住那只修读入方向（见上）。字节层要穷尽判定走 `windows-text-encoding §8` 的岔 5 阶梯。
  3. **调法？** 对照上表：bash 里报 `command not found`/`No such file or directory`=不是 PowerShell 在跑；PowerShell 里 ①② 同错同码=政策或编码，不是调法。
  4. **解释器不存在？** `Get-Command pwsh, powershell` —— 谁空谁没装；bash shebang 报 `env: 'pwsh': No such file` 同义。
  一句话：**先 Bypass 重跑排除政策 → 跳过行首 ASCII 再取三字节排除编码 → 对照调法表 → 最后查解释器**。恢复证明（Process 档会话内可读回）：`Set-ExecutionPolicy -Scope Process Bypass -Force; (Get-ExecutionPolicy) -eq 'Bypass'` 返回 True 即已复原。

- **验证于**：Windows 11（10.0.26200）· Windows PowerShell 5.1.26100.9444 / Git Bash bash 5.2.37（git 2.53.0.windows.2）· pwsh 未安装 · 2026-09-17 首发；2026-09-18 第二次独立重跑，本节三处结论重取且全部一致或收敛：三种启动方式的 `Process`/生效档矩阵、无 BOM 与带 BOM 两版的 stdout 原始字节 + 进程内码点、四种 `.ps1` 的首三字节取值。**同日据重跑结果改了两处**：`Process Bypass` 那张表原本按机器属性陈述（裸启动其实是 `Undefined`/`RemoteSigned`），以及首三字节规则原本没排除行首 ASCII（会漏判 `# 中文注释` 开头的脚本）。

## 复用信号

"命令存在但什么都不输出""退出码 49/9009/101""我本地能跑""换 shell 就不行""装了却 import 不到""NODE_MODULE_VERSION 对不上" → 一律先测三件事：**真实退出码、`which -a` 的全部候选、以及运行时自己报出的身份**（`sys.executable` / `process.execPath` / `process.versions.modules`）。
