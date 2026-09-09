#!/usr/bin/env node
// OVL-005 retranslation v6: fix remaining 5 byte errors + 13 placeholder errors

function countContentBytes(text) {
  let cleaned = text.replace(/\[.*?\]/g, '');
  cleaned = cleaned.replace(/\{\{C\d+\}\}/g, '');
  let bytes = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) bytes += 3;
    else if (code >= 0x3400 && code <= 0x4DBF) bytes += 3;
    else if (code >= 0xF900 && code <= 0xFAFF) bytes += 3;
    else if (code >= 0x2E80 && code <= 0x2FDF) bytes += 3;
    else if (code >= 0x3000 && code <= 0x303F) bytes += 3;
    else if (code >= 0xFF01 && code <= 0xFF5E) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

function getBudget(task) {
  const m = task.hint.match(/≤(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 999;
}

const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./translation-er/report/batches/ovl-005.json', 'utf8'));

const translations = {};

// ===== ALL 140 TRANSLATIONS (v6) =====
// Fixed: 5 byte errors + 13 placeholder count mismatches

translations["00EA6342"] = "稍作休息,治愈状态{{C0}}并恢复体力.";
translations["00EA679B"] = "发出流星般的拳击{{C0}}可能提升攻击.";
translations["00EAC2CE"] = "对异常状态的对手{{C0}}造成双倍伤害.";
translations["00EAEB8E"] = "提升毒属性并伤害宝可梦{{C0}}8回合.";
translations["00EB4C3E"] = "治愈状态并恢复{{C0}}自身25%HP.";
// 00EFCAE4: en=3, codes: C0→[buffer1], C1→[/n], C2→[/c]
translations["00EFCAE4"] = "最多派{{C0}}只宝可梦{{C1}}进入{{C2}}";
translations["00F02EB0"] = "对方训练家已有{{C0}}相同的奖章.";
// 00F03330: en=2, codes: C0→[/n], C1→[buffer2]
translations["00F03330"] = "删除旧招式{{C0}}来为{{C1}}腾位吗?";
translations["0100E2F7"] = "随机展开青草{{C0}}或精神强念场地.";
translations["01012725"] = "接触或攻击时30%{{C0}}几率使对手出血.";
translations["002CA0A4"] = "在宝可导航登录了{{C0}}道馆馆主亚莎.";
// 002D935C: en=5, codes: C0→[PO] C1→[Ke] C2→[BL] C3→[OC] C4→[K]
translations["002D935C"] = "蛋不能吃{{C0}}{{C1}}{{C2}}{{C3}}{{C4}}!";
translations["0034286B"] = "喷射星形光线{{C0}}必定命中{{C1}}";
translations["0035E629"] = "大家对{{C0}}{{C1}}的表演充满期待.";
translations["009D0B7A"] = "印有精灵球{{C0}}图案的小海报{{C1}}";
translations["00AAEDAF"] = "提高宝可梦速度{{C0}}个体值8点{{C1}}";
translations["00EA7709"] = "设置撒菱{{C0}}使换上场的对手中毒.";
translations["00EA9F97"] = "吐出炽热火焰{{C0}}可能降低特攻.";
translations["00EAA70B"] = "使对手攻击被{{C0}}聚光照射的宝可梦.";
translations["00EC656F"] = "领养中心购买{{C0}}波士可多拉进化石.";
translations["00F02F0C"] = "无法向这位训练家{{C0}}发送神秘礼物.";
// 00F0332F: en=2, codes: C0→[/n], C1→[buffer2]
translations["00F0332F"] = "删除旧招式{{C0}}来为{{C1}}腾位吗?";
translations["00F353F0"] = "这只宝可梦攻击{{C0}}翻倍,持续一回合.";
translations["00F355C0"] = "这只宝可梦精神强念招式全部未命中.";
translations["0100F855"] = "雾天暴怒{{C0}}受到的伤害减半.";
translations["01011B46"] = "青草场地上草属性{{C0}}招式+50%.";
translations["01012BDD"] = "迷人之躯对魅惑目标{{C0}}伤害恢复25%HP";
translations["01013E8F"] = "格斗招式后速度+1{{C0}}并清除场地陷阱";
// 01015397: fix byte error (46>44)
translations["01015397"] = "水属性招式获本系加成{{C0}}不会浸湿.";
translations["01015C33"] = "自身和同伴钢系{{C0}}招式+1.3倍.";
translations["0101706D"] = "被击中时攻击者{{C0}}特性变为木乃伊.";
translations["003426E1"] = "全力撞击{{C0}}可能使对手{{C1}}麻痹.";
translations["00519BCA"] = "{{C0}}数据已{{C1}}添加到宝可图鉴{{C2}}";
// 0051FA24: en=6, fix byte error (11>8)
translations["0051FA24"] = "{{C0}}{{C1}}派出{{C2}}[fd07]{{C3}}{{C4}}{{C5}}";
// 00AAF7A9: fix byte error (46>38)
translations["00AAF7A9"] = "持道具时{{C0}}受一般招式{{C1}}减伤";
translations["00EA55C1"] = "上一招未命中时{{C0}}造成双倍伤害.";
translations["00EA664B"] = "用带刺手臂攻击{{C0}}可能使对手畏缩.";
translations["00EA7F62"] = "速度慢的宝可梦{{C0}}5回合内先制攻击.";
translations["00EAC9B3"] = "造成伤害并设置{{C0}}隐形岩.";
// 00EC7868: en=4, fix placeholder count
translations["00EC7868"] = "选择替换招式{{C0}}{{C1}}{{C2}}{{C3}}";
// 00EFD058: en=4, fix placeholder count
translations["00EFD058"] = "{{C0}}喜爱你{{C1}}基础{{C2}}降了{{C3}}";
translations["00F353EF"] = "这只宝可梦攻击{{C0}}翻倍持续一回合.";
// 00FAD185: en=3, fix placeholder count
translations["00FAD185"] = "{{C0}}联系了你{{C1}}要分享{{C2}}吗?";
translations["0100F2BA"] = "免疫异常状态{{C0}}受到的毒伤害减半.";
translations["0100F4BB"] = "声音类招式变为{{C0}}舞蹈类反之亦然.";
translations["010116FA"] = "在雾中濒死后{{C0}}一次恢复25%HP复活.";
translations["010125CB"] = "自身和队友{{C0}}飞行属性招式+1.3倍.";
translations["01016336"] = "保护自身和队友{{C0}}免受优先度招式.";
translations["005199B7"] = "所有受影响宝可梦{{C0}}三回合后倒下!";
translations["009D137F"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D13AB"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D13D7"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D1403"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D142F"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D145B"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D1487"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D14B3"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D14DF"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["009D150B"] = "大玩偶可放在{{C0}}坐垫或桌上{{C1}}.";
translations["00AAED56"] = "提升宝可梦{{C0}}攻击个体值8点{{C1}}";
translations["00EA41BB"] = "承受攻击2回合后{{C0}}以双倍威力反击.";
translations["00EA45F3"] = "对飞行系效果绝佳{{C0}}可能使对手中毒.";
translations["00EA5A79"] = "以锐牙咬住{{C0}}可能降低对手防御.";
translations["00EA961B"] = "用古代歌曲攻击{{C0}}可能使对手睡眠.";
translations["00EAE232"] = "可怕的头锤{{C0}}可能使对手流血或恐惧.";
// 00EC7867: en=4
translations["00EC7867"] = "选择替换招式{{C0}}{{C1}}{{C2}}{{C3}}";
translations["00F02F0A"] = "无法向这位训练家{{C0}}发送神秘礼物.";
translations["0100DDAF"] = "强力角+所有钻头类{{C0}}招式+30%.";
translations["01011601"] = "防御和特防随HP{{C0}}降低提升最高1.6倍";
translations["010135DE"] = "受到地面招式时{{C0}}恢复最大HP的25%.";
translations["010139FE"] = "替换上场时自动{{C0}}使用守住仅一次";
// 002D1E13: en=2
translations["002D1E13"] = "可惜你似乎不是{{C0}}那个训练家呢{{C1}}";
translations["002F4272"] = "即使冒生命危险{{C0}}也要赢得这场对战!";
translations["009D052A"] = "大蓝色帐篷{{C0}}可躲在里面{{C1}}.";
translations["009D0D0E"] = "皮丘玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["009D0EDE"] = "百变怪玩偶{{C0}}可放在坐垫或桌上{{C1}}.";
translations["009D115F"] = "橡实果玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["00AAED82"] = "提升宝可梦{{C0}}防御个体值8点{{C1}}";
translations["00AAEE5A"] = "提升宝可梦{{C0}}特防个体值8点{{C1}}";
translations["00EA3129"] = "无视特性与能力变化{{C0}}击中要害率高.";
translations["00EA3992"] = "用锐叶斩击双方{{C0}}必定击中要害.";
translations["00EA3EC3"] = "复制对手在战斗中{{C0}}使用过的招式.";
translations["00EA606E"] = "祈愿恢复体力{{C0}}需等待一段时间.";
translations["00EAA0FF"] = "提升正电或负电{{C0}}特性宝可梦防御.";
translations["00EAEBF3"] = "发射能量棱镜{{C0}}降低命中率可能混乱.";
// 00FAED24: en=3
translations["00FAED24"] = "Bx{{C0}}Ë:x{{C1}}Ë交易被拒绝了{{C2}}";
translations["0100F309"] = "使用招式后{{C0}}追加20威力毒瓦斯.";
translations["01012A21"] = "被攻击时特防+1{{C0}}要害时特防升满.";
translations["0101572F"] = "岩石招式变为冰属性{{C0}}获1.1倍加成";
translations["003428C4"] = "承受任何攻击{{C0}}1回合{{C1}}留下1点HP.";
translations["0051E4DB"] = "队伍中部分成员{{C0}}{{C1}}的影响.";
// 009D0D3B: en=2
translations["009D0D3B"] = "皮卡丘玩偶{{C0}}可放在地毯或桌上{{C1}}.";
// 009D10AE: en=2
translations["009D10AE"] = "向尾喵玩偶{{C0}}可放在地毯或桌上{{C1}}.";
// 009D3DAC: en=3
translations["009D3DAC"] = "欢迎图鉴领航{{C0}}{{C1}}Â 搜索 {{C2}}À 退出";
// 00AAE69F: en=2
translations["00AAE69F"] = "对钓上来的宝可梦{{C0}}效果好的球{{C1}}";
translations["00AAEDD9"] = "提升宝可梦{{C0}}特攻个体值8点{{C1}}";
translations["00AB10CF"] = "提升精神强念{{C0}}招式威力的道具{{C1}}";
translations["00AB5B83"] = "鬃岩狼人尖石攻击{{C0}}升级为Z招式{{C1}}";
translations["00AB5C12"] = "将谜拟丘嬉闹{{C0}}升级为Z招式{{C1}}";
translations["00EA558E"] = "狡猾的攻击伤害{{C0}}对手并回复己方体力";
translations["00EA5853"] = "用坚硬尾巴攻击{{C0}}可能降低防御.";
translations["00EA9A1F"] = "使对手变为{{C0}}幽灵属性.";
translations["00EAA7A1"] = "提升正电或负电{{C0}}特性宝可梦攻击.";
translations["00EAAB75"] = "削弱所有攻击{{C0}}但仅冰雹天气下可用";
translations["00EAAC36"] = "愤怒地践踏{{C0}}未命中时威力增强.";
translations["00EADFD5"] = "用甲虫般锤子攻击{{C0}}可能使对手混乱";
translations["00EAE703"] = "掷出充满毒素的蛋{{C0}}命中使对手中毒";
translations["010079DA"] = "脉冲光束弹丸和{{C0}}气场类招式+30%.";
translations["0100FCE5"] = "受到水或冰属性{{C0}}攻击时攻防提升.";
translations["0100FDBF"] = "中毒对手失去所有{{C0}}能力变化无法恢复";
translations["01011ED7"] = "上场时召唤晴天{{C0}}晴天下攻击+1.33倍";
translations["01012E13"] = "所有招式获得本系加成{{C0}}效果绝佳+10%";
translations["01013AA1"] = "吸取类招式恢复{{C0}}+50%HP并附加寄生种子";
translations["01016BEF"] = "一般招式变为冰属性{{C0}}冰招式增强.";
translations["00342620"] = "造成与使用者{{C0}}等级{{C1}}相同伤害.";
translations["0035F7B6"] = "最精彩的宝可梦:{{C0}}{{C1}}的{{C2}}{{C3}}";
translations["009D0D69"] = "玛力露玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["009D0E23"] = "小锯鳄玩偶{{C0}}可放在坐垫或桌上{{C1}}.";
translations["009D0F0B"] = "迷唇娃玩偶{{C0}}可放在坐垫或桌上{{C1}}.";
translations["009D0F3A"] = "木守宫玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["009D0F99"] = "水跃鱼玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["009D0FF5"] = "小果然玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["00AB291A"] = "盖诺赛克特高科技{{C0}}光炮变冰属性{{C1}}";
translations["00AB5CDA"] = "将卡比兽终极冲击{{C0}}升级为Z招式{{C1}}";
translations["00F02E48"] = "对方训练家已有{{C0}}相同的神秘卡片.";
translations["00F02E7C"] = "对方训练家已有{{C0}}相同的神秘新闻.";
translations["0100D9C3"] = "使用反冲招式后{{C0}}攻击+1反冲伤害50%";
translations["0101126D"] = "对换下场对手{{C0}}使用威力20的追打.";
translations["01013B9A"] = "啃咬类招式攻击两次{{C0}}第二击威力0.4倍";
// 010141FA: fix byte error (51>49)
translations["010141FA"] = "普通招式变幽灵并增强{{C0}}30%几率剧毒";
translations["01014ADA"] = "效果绝佳的招式{{C0}}从不偏失且必定暴击.";
translations["002FC1C6"] = "如果你想我用{{C0}}稀有宝可梦对战.";
translations["0034294A"] = "带电一击{{C0}}可能使对手{{C1}}麻痹.";
translations["009D0DF3"] = "菊草叶玩偶{{C0}}可放在坐垫或桌上{{C1}}.";
translations["009D0F69"] = "火稚鸡玩偶{{C0}}可放在地毯或桌上{{C1}}.";
translations["00AB2887"] = "盖诺赛克特高科技{{C0}}光炮变水属性{{C1}}";
translations["00AB28EA"] = "盖诺赛克特高科技{{C0}}光炮变火属性{{C1}}";
// 00EA2BAE: fix byte error (52>50)
translations["00EA2BAE"] = "连续拍打对手至少两次{{C0}}可能混乱.";
translations["00EA381E"] = "被物理攻击命中后{{C0}}下一招威力变两倍";
// 00EFD030: en=4
translations["00EFD030"] = "{{C0}}友善了{{C1}}基础{{C2}}降了{{C3}}";

// ===== VALIDATION =====
const output = [];
let allOk = true;
let byteErrors = [];
let phErrors = [];

for (const task of data.tasks) {
  const zh = translations[task.id];
  if (!zh) {
    byteErrors.push(`Missing: ${task.id}`);
    allOk = false;
    continue;
  }
  
  const budget = getBudget(task);
  const bytes = countContentBytes(zh);
  if (bytes > budget) {
    byteErrors.push(`${task.id}: ${bytes}B > ${budget}B. zh="${zh}"`);
    allOk = false;
  }
  
  const enPh = (task.en.match(/\{\{C\d+\}\}/g) || []).length;
  const zhPh = (zh.match(/\{\{C\d+\}\}/g) || []).length;
  if (enPh !== zhPh) {
    phErrors.push(`${task.id}: en=${enPh} zh=${zhPh}`);
    allOk = false;
  }
  
  output.push({ id: task.id, zh: zh });
}

const outDir = './translation-er/report/out';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outDir + '/ovl-005.json', JSON.stringify(output, null, 2));

console.log(`Total: ${data.tasks.length}, Output: ${output.length}, AllOK: ${allOk}`);
if (byteErrors.length > 0) {
  console.log(`\nByte errors (${byteErrors.length}):`);
  for (const e of byteErrors) console.log(`  ${e}`);
}
if (phErrors.length > 0) {
  console.log(`\nPlaceholder errors (${phErrors.length}):`);
  for (const e of phErrors) console.log(`  ${e}`);
}
if (byteErrors.length === 0 && phErrors.length === 0) {
  console.log('All validations passed!');
}

let forbidden = 0;
for (const t of output) {
  const clean = t.zh.replace(/\{\{C\d+\}\}/g, '');
  if (/[，。！？；：""''【】（）、…—]/.test(clean)) {
    console.log(`FORBIDDEN: ${t.id}`);
    forbidden++;
  }
}
console.log(`Forbidden chars: ${forbidden === 0 ? 'ALL OK' : forbidden + ' found'}`);
