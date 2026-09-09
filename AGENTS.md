# GBA字体自动破解技术方案

## 项目概述

本项目通过Hook GBA模拟器的文本渲染函数，实现自动捕获游戏运行时的字符显示，并破解中文字库。基于Pokemon GBA Font Patch的Hook机制，结合现有的码表和字库文件，实现完整的自动化破解流程。

## 文件说明

### 1. 码表文件：`fonts/wholewords.txt`

- **文件大小**：6974行
- **编码格式**：行格式为 `hex=character`
- **字符分布**：
  - 2位十六进制（单字节）：159个字符（ASCII、符号、数字）
  - 4位十六进制（双字节）：约6768个汉字

**关键码表范围**：
- `0x00`：空格
- `0x01-0x7F`：扩展ASCII和符号
- `0xA1-0xAA`：数字0-9
- `0x0100-0x1FF6`：汉字（约7600个）

### 2. 字库文件：`fonts/绿宝石字库.bin`

- **文件大小**：950KB
- **格式**：原始二进制字模数据
- **推测结构**：
  - 每个字符：128字节（16×16像素，4bpp = 2字节/像素行 × 16行）
  - 理论容量：950KB / 128B ≈ 7600字符

## 技术架构

### Hook点定义

基于Pokemon GBA Font Patch项目，确定以下Hook点：

| 函数名 | ROM地址 | Hook偏移 | 功能说明 |
|--------|---------|----------|----------|
| GetGlyphWidth | 0x080048EA | +2 | 单字符宽度计算 |
| GetStringWidth | 0x08004CCC | +0x100 | 字符串宽度计算 |
| DrawGlyphTiles | 0x08006876 | +2 | 字符绘制渲染 |

### Hook实现机制

```javascript
// Hook伪代码
function hookGetGlyphWidth() {
    const window = cpu.r[0];      // 窗口结构体指针
    const glyph = cpu.r[1] & 0xFF; // 字符编码（低8位）
    
    // 检查是否为中文字符（双字节）
    if (isChineseFirstByte(glyph)) {
        const secondByte = readNextByte();
        const charCode = (glyph << 8) | secondByte;
        return getChineseWidth(charCode);
    }
    
    // 原始英文字符处理
    return originalGetGlyphWidth(window, glyph);
}
```

## "NEW GAME"自动破解方案

### 目标分析

**"NEW GAME"是游戏启动后第一个渲染的文本**，具有以下特点：
- 位置固定：主菜单界面
- 字符明确：N, E, W, G, A, M, E
- 时间明确：游戏启动后的前几秒钟
- 易于识别：ASCII字符，编码确定

### 破解流程

```
┌─────────────────────────────────────────────────────────────┐
│  步骤1: 加载ROM并初始化模拟器                                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤2: 在关键函数地址设置断点/Hook                          │
│  - 0x080048EA: GetGlyphWidth                                │
│  - 0x08004CCC: GetStringWidth                               │
│  - 0x08006876: DrawGlyphTiles                               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤3: 运行ROM，捕获字符渲染                                │
│  - 记录每个字符的编码、地址、调用栈                           │
│  - 持续捕获直到找到"NEW GAME"序列                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤4: 分析捕获数据                                         │
│  - 建立字符编码映射表                                        │
│  - 推断文本渲染流程                                          │
│  - 确定中文字符范围                                          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤5: 扩展至中文破解                                       │
│  - 基于英文Hook结果配置中文Hook                              │
│  - 捕获汉字渲染数据                                          │
│  - 生成完整字库映射                                          │
└─────────────────────────────────────────────────────────────┘
```

### 核心Hook代码

```javascript
class TitleScreenHook {
    constructor(gba) {
        this.gba = gba;
        this.capturedSequence = [];
        this.targetText = "NEW GAME";
        this.titleScreenDetected = false;
        this.minCharactersToCapture = 20;
    }

    // Hook GetGlyphWidth函数
    hookGetGlyphWidth(pc) {
        const cpu = this.gba.cpu;
        const glyph = cpu.gprs[1] & 0xFF;  // 字符编码
        
        // 只记录ASCII可打印字符
        if (glyph >= 0x20 && glyph <= 0x7E) {
            const char = String.fromCharCode(glyph);
            this.capturedSequence.push({
                char: char,
                code: glyph,
                pc: pc,
                timestamp: Date.now()
            });
            
            console.log(`捕获: '${char}' (0x${glyph.toString(16)})`);
            
            // 检查是否捕获到"NEW GAME"
            if (this.checkSequence()) {
                this.titleScreenDetected = true;
                console.log('✓ 成功捕获标题界面！');
                return { stop: true };
            }
        }
        
        return null;
    }

    // 检查是否包含"NEW GAME"
    checkSequence() {
        const recent = this.capturedSequence.slice(-20).map(c => c.char).join('');
        return recent.includes(this.targetText);
    }
}
```

## 实施计划

### Phase 1: 基础Hook实现（已完成分析）
- [x] 分析Pokemon GBA Font Patch的Hook机制
- [x] 确定三个关键Hook点
- [x] 理解汉字识别逻辑

### Phase 2: "NEW GAME"自动破解
- [ ] 实现TitleScreenHook类
- [ ] 集成到GBA.js模拟器
- [ ] 捕获并分析"NEW GAME"序列
- [ ] 生成字符编码映射表

### Phase 3: 中文破解扩展
- [ ] 基于英文Hook配置中文Hook
- [ ] 捕获汉字渲染数据
- [ ] 匹配现有码表和字库
- [ ] 生成完整的字库映射

### Phase 4: 可视化界面
- [ ] 创建HTML界面
- [ ] 实时显示捕获过程
- [ ] 可视化字符渲染
- [ ] 导出报告和字库文件

## 相关文件路径

- **码表文件**: `d:\vibecoding\gba-font-cracker-js\fonts\wholewords.txt` (6974行，6763个双字节字符)
- **字库文件**: `d:\vibecoding\gba-font-cracker-js\fonts\绿宝石字库.bin` (950KB，约7600字符)
- **参考项目**: `d:\vibecoding\Pokemon_GBA_Font_Patch-main`
- **分析报告**: `d:\vibecoding\gba-font-cracker-js\gbajs2\分析报告.md`

## 附录：关键Hook点地址

| 版本 | GetGlyphWidth | GetStringWidth | DrawGlyphTiles |
|------|--------------|----------------|----------------|
| Ruby/Sapphire | 0x080048EA | 0x08004CCC | 0x08006876 |
| FireRed/LeafGreen | 0x080048EA | 0x08004CCC | 0x08006876 |
| Emerald | 0x080048EA | 0x08004CCC | 0x08006876 |

注：Pokemon GBA系列游戏的文本渲染函数地址基本一致，便于跨版本兼容。
