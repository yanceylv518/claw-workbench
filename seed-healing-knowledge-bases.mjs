import fs from 'fs';

const configPath = 'D:/openclaw/notion-ai-intel.config.json';
const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
const cfg = JSON.parse(raw);
const token = cfg.notion.token;
const notionVersion = '2022-06-28';
const parentPageId = '3484ee2a-722a-8014-8a11-ceaaa6881f63';

async function notion(path, method = 'GET', body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function searchDatabases() {
  const data = await notion('/search', 'POST', {
    filter: { property: 'object', value: 'database' },
    page_size: 100,
  });
  return data.results;
}

function titleProp() {
  return { title: {} };
}

function richTextProp() {
  return { rich_text: {} };
}

function selectProp(options) {
  return { select: { options: options.map((name) => ({ name })) } };
}

function multiSelectProp(options) {
  return { multi_select: { options: options.map((name) => ({ name })) } };
}

function checkboxProp() {
  return { checkbox: {} };
}

function urlProp() {
  return { url: {} };
}

async function ensureDatabase(name, description, properties) {
  const existing = (await searchDatabases()).find((db) => (db.title?.[0]?.plain_text || '') === name);
  if (existing) return existing;

  return notion('/databases', 'POST', {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: name } }],
    description: [{ type: 'text', text: { content: description } }],
    properties,
  });
}

async function ensurePage(databaseId, titleName, titleValue, properties) {
  const query = await notion(`/databases/${databaseId}/query`, 'POST', {
    filter: { property: titleName, title: { equals: titleValue } },
    page_size: 1,
  });
  if (query.results.length > 0) return query.results[0];

  return notion('/pages', 'POST', {
    parent: { database_id: databaseId },
    properties: {
      [titleName]: { title: [{ type: 'text', text: { content: titleValue } }] },
      ...properties,
    },
  });
}

function rt(value) {
  return { rich_text: [{ type: 'text', text: { content: value } }] };
}

function sel(value) {
  return { select: value ? { name: value } : null };
}

function msel(values) {
  return { multi_select: values.map((name) => ({ name })) };
}

function chk(value) {
  return { checkbox: !!value };
}

function url(value) {
  return { url: value || null };
}

const themeOptions = ['疗愈', '成长', '关系', '职场', '科技', '生活'];
const platformOptions = ['小红书', '短视频', '公众号'];
const formatOptions = ['图文', '口播', '视频', '清单', '故事'];
const priorityOptions = ['高', '中', '低'];
const statusOptions = ['长期做', '观察中', '暂停'];
const knowledgeTypeOptions = ['用户痛点', '表达角度', '禁忌表达', '关键词', '意象', '案例', '内容结构', '选题', '金句'];
const sceneOptions = ['小红书图文', '短视频口播', '视频脚本', '陪伴向内容', '共鸣向内容', '干货向内容'];
const toneOptions = ['温柔', '平静', '陪伴', '治愈', '坚定', '专业'];
const sampleTypeOptions = ['标题', '开头', '正文段落', '结尾', '整篇', '口播稿'];
const styleTagOptions = ['温柔', '陪伴感', '共鸣', '收藏感', '干练', '口语化', '故事感'];
const ruleTypeOptions = ['必须遵守', '尽量遵守', '禁止出现', '优化建议'];
const ruleSceneOptions = ['小红书图文', '短视频口播', '视频脚本', '标题', '开头', '结尾'];

const themes = [
  {
    title: '焦虑疗愈',
    props: {
      主题: sel('疗愈'),
      主题说明: rt('围绕焦虑、紧绷、睡不着、内耗等状态，产出能被用户接住的疗愈内容。'),
      目标人群: rt('容易焦虑、常常内耗、晚上睡不着、想被理解的年轻用户。'),
      适合平台: msel(['小红书', '短视频']),
      适合形式: msel(['图文', '口播', '故事']),
      优先级: sel('高'),
      状态: sel('长期做'),
    },
  },
  {
    title: '睡前疗愈',
    props: {
      主题: sel('疗愈'),
      主题说明: rt('适合夜晚浏览和睡前反复看的温柔安抚型内容。'),
      目标人群: rt('晚上容易情绪翻涌、睡前需要安静陪伴的人。'),
      适合平台: msel(['小红书', '短视频']),
      适合形式: msel(['图文', '口播']),
      优先级: sel('高'),
      状态: sel('长期做'),
    },
  },
  {
    title: '情绪稳定',
    props: {
      主题: sel('疗愈'),
      主题说明: rt('帮助用户从情绪波动走向慢慢稳定的内容方向。'),
      目标人群: rt('容易情绪起伏、想学会稳定自己的人。'),
      适合平台: msel(['小红书', '短视频']),
      适合形式: msel(['图文', '口播', '清单']),
      优先级: sel('高'),
      状态: sel('长期做'),
    },
  },
  {
    title: '低能量恢复',
    props: {
      主题: sel('疗愈'),
      主题说明: rt('围绕疲惫、耗竭、提不起劲的状态，给出温和恢复路径。'),
      目标人群: rt('长期消耗、感觉自己被榨干的人。'),
      适合平台: msel(['小红书', '短视频']),
      适合形式: msel(['图文', '口播', '清单']),
      优先级: sel('高'),
      状态: sel('长期做'),
    },
  },
  {
    title: '自我接纳',
    props: {
      主题: sel('疗愈'),
      主题说明: rt('围绕不够好、自我怀疑、无法接纳自己展开的疗愈主题。'),
      目标人群: rt('总觉得自己不够好、容易自责的人。'),
      适合平台: msel(['小红书', '公众号']),
      适合形式: msel(['图文', '故事']),
      优先级: sel('中'),
      状态: sel('长期做'),
    },
  },
];

const knowledgeItems = [
  ['焦虑时最常见的3种状态', '用户痛点', '明明很累却停不下来；脑子一直转，晚上睡不着；表面正常，心里已经很乱。', ['小红书图文', '短视频口播', '共鸣向内容'], '陪伴', true, '内容观察', '适合做开头或共鸣段'],
  ['低能量的人最怕被说“你想开点”', '禁忌表达', '不要用“振作起来”“别想太多”“你要积极一点”这类命令式表达。', ['小红书图文', '短视频口播'], '温柔', true, '写作规则提炼', '适合疗愈类所有主题'],
  ['疗愈类内容更适合陪伴式表达', '表达角度', '少说大道理，多说“我知道你现在很难”“先别急着变好”。', ['小红书图文', '陪伴向内容'], '陪伴', true, '写作经验', '核心方法论'],
  ['睡前疗愈最有效的内容意象', '意象', '灯光、窗帘、晚风、热水、枕边、夜色、呼吸、安静的房间。', ['小红书图文', '视频脚本'], '平静', true, '主题素材', '适合配图和旁白'],
  ['睡前疗愈内容不适合太强刺激', '禁忌表达', '避免使用太强烈的冲突、过多惊叹号、太快节奏的指令感语气。', ['小红书图文', '短视频口播'], '平静', true, '写作规则提炼', '尤其适合夜间内容'],
  ['自我接纳类内容的核心痛点', '用户痛点', '总觉得自己不够好、慢别人一步、配不上被喜欢。', ['小红书图文', '共鸣向内容'], '温柔', true, '主题素材', '可做女性成长和疗愈内容'],
  ['自我和解更适合“慢慢来”的表达', '表达角度', '用“允许自己”“慢一点也没关系”“先把心收回来”这类句式。', ['小红书图文', '短视频口播'], '治愈', true, '写作经验', '适合结尾和过渡'],
  ['职场情绪的典型感受也可归入疗愈', '案例', '被消耗、被催促、长期紧绷却不敢停下来，这类内容虽然是职场场景，但疗愈表达依然有效。', ['小红书图文', '短视频口播', '干货向内容'], '坚定', false, '跨主题案例', '先留作扩展接口'],
  ['疗愈内容高频关键词', '关键词', '慢下来、接住自己、把心收回来、允许、呼吸、缓一缓、先别急。', ['小红书图文', '视频脚本'], '陪伴', true, '主题素材', '适合标题和正文'],
  ['适合疗愈内容的开头方式', '金句', '如果你最近总觉得很累，但又说不上来哪里累，这段话想留给你。', ['小红书图文', '短视频口播'], '陪伴', true, '优秀表达', '高频使用'],
  ['疗愈类内容适合收藏的结尾方式', '金句', '今晚先别逼自己变好，先让自己安静下来。', ['小红书图文', '短视频口播'], '治愈', true, '优秀表达', '适合结尾'],
  ['疗愈类小红书推荐结构', '内容结构', '1. 共鸣开头；2. 说出真实感受；3. 给一个轻量动作；4. 温柔收尾。', ['小红书图文'], '陪伴', true, '内容方法论', '适合生成前参考'],
  ['焦虑疗愈的好选题方向', '选题', '总觉得自己慢别人一步的人，怎么把心收回来。', ['小红书图文', '短视频口播'], '陪伴', true, '选题积累', '可直接生成'],
  ['睡前疗愈的好选题方向', '选题', '适合睡前反复读的5句话，让情绪慢慢落下来。', ['小红书图文', '短视频口播'], '平静', true, '选题积累', '可直接生成'],
  ['低能量恢复的轻动作案例', '案例', '深呼吸、关掉强光、喝口温水、把手机放远一点、把注意力放回身体。', ['小红书图文', '短视频口播', '干货向内容'], '平静', true, '恢复动作清单', '适合清单内容'],
];

const styleItems = [
  ['疗愈类高共鸣开头1', '开头', '如果你最近总觉得很累，但又说不上来哪里累，这段话想留给你。', '它不解释道理，先说出用户已经在经历的感受。', ['温柔', '陪伴感', '共鸣'], ['小红书'], true, '适合焦虑疗愈'],
  ['疗愈类高共鸣开头2', '开头', '不是你不努力，是你已经撑太久了。', '短、准、直接点中被消耗感。', ['共鸣', '收藏感'], ['小红书'], true, '适合职场情绪和低能量'],
  ['睡前疗愈结尾1', '结尾', '今晚先别逼自己变好，先让自己安静下来。', '收束感强，适合睡前内容收藏。', ['温柔', '陪伴感', '收藏感'], ['小红书'], true, '适合睡前疗愈'],
  ['疗愈标题样例1', '标题', '总觉得自己慢别人一步的人，先别急着追。', '有画面感，也有暂停感。', ['温柔', '共鸣', '收藏感'], ['小红书'], true, '适合焦虑疗愈'],
  ['疗愈标题样例2', '标题', '适合情绪很乱时，反复读的5句话', '明确场景，天然适合收藏。', ['收藏感', '口语化'], ['小红书'], true, '适合睡前和情绪稳定'],
  ['疗愈正文段落样例', '正文段落', '你不是突然脆弱了，你只是太久没有被好好接住。', '像人在说话，不像在讲课。', ['温柔', '陪伴感', '故事感'], ['小红书'], true, '适合正文中段'],
  ['疗愈口播样例', '口播稿', '如果你最近白天还撑得住，一到晚上就整个人往下掉，这条想留给你。', '有口播节奏，适合视频开场。', ['口语化', '陪伴感', '共鸣'], ['短视频'], true, '适合视频开场'],
  ['疗愈类整篇节奏样例', '整篇', '先共鸣，再说感受，然后给一个很小的动作，最后温柔收住。', '这是疗愈内容最稳的节奏。', ['温柔', '收藏感'], ['小红书'], true, '作为整篇风格提示'],
];

const rules = [
  ['不要说教', '必须遵守', '不要用“你应该”“你必须”“你要振作”这种高位口吻。', ['小红书图文', '短视频口播', '正文'], '差：你要想开点；好：先别急着逼自己振作。', '高', true, '疗愈内容底线'],
  ['不要过度鸡汤', '必须遵守', '避免空泛的“都会好起来的”“宇宙会奖励你”这类无支撑句子。', ['小红书图文', '短视频口播', '正文'], '差：一切都会变好；好：先让自己慢慢稳下来。', '高', true, '避免AI味'],
  ['开头前三句必须有情绪抓手', '必须遵守', '开头要先说出现实感受，而不是先下定义或讲道理。', ['小红书图文', '短视频口播', '开头'], '先说“你是不是最近…”而不是“焦虑是一种常见情绪”。', '高', true, '直接决定停留率'],
  ['多用生活画面', '尽量遵守', '优先使用灯光、窗边、夜里、热水、呼吸、地板、手心这类具体画面。', ['小红书图文', '视频脚本', '正文'], '让读者能看到场景，而不是只看到概念。', '中', true, '提升可视化和共鸣'],
  ['结尾不要硬互动', '尽量遵守', '少用“点赞收藏关注我”，优先用可反复阅读、可停留的收束句。', ['小红书图文', '结尾'], '好结尾：今晚先让自己安静下来。', '高', true, '更适合疗愈内容'],
  ['疗愈内容优先陪伴感', '优化建议', '能用“我知道你很难”就不要用“你需要做到”。', ['小红书图文', '短视频口播', '正文'], '把指导感降下来，把陪伴感提上去。', '高', true, '风格核心'],
  ['睡前内容要降低刺激度', '必须遵守', '睡前疗愈内容避免太强情绪、太快节奏和过多感叹。', ['小红书图文', '短视频口播'], '文字和节奏都要更慢。', '高', false, '针对睡前内容'],
  ['允许留白', '优化建议', '疗愈内容不用每一段都解释透，适当留一句能让人自己停一下的话。', ['小红书图文', '正文'], '有时候少一句比多一句更有力量。', '中', true, '减少说满说尽'],
];

async function main() {
  const themeDb = await ensureDatabase('主题库', '管理长期要做的主题方向', {
    主题名: titleProp(),
    主题: selectProp(themeOptions),
    主题说明: richTextProp(),
    目标人群: richTextProp(),
    适合平台: multiSelectProp(platformOptions),
    适合形式: multiSelectProp(formatOptions),
    优先级: selectProp(priorityOptions),
    状态: selectProp(statusOptions),
  });

  const knowledgeDb = await ensureDatabase('知识点库', '写内容时可直接调用的知识点', {
    标题: titleProp(),
    主题: selectProp(themeOptions),
    知识类型: selectProp(knowledgeTypeOptions),
    核心内容: richTextProp(),
    适用场景: multiSelectProp(sceneOptions),
    情绪基调: selectProp(toneOptions),
    优先使用: checkboxProp(),
    来源: richTextProp(),
    备注: richTextProp(),
  });

  const styleDb = await ensureDatabase('风格样例库', '沉淀值得复用的表达风格和写法', {
    样例标题: titleProp(),
    主题: selectProp(themeOptions),
    样例类型: selectProp(sampleTypeOptions),
    样例内容: richTextProp(),
    为什么好: richTextProp(),
    风格标签: multiSelectProp(styleTagOptions),
    适合平台: multiSelectProp(platformOptions),
    优先参考: checkboxProp(),
    来源链接: urlProp(),
    备注: richTextProp(),
  });

  const ruleDb = await ensureDatabase('写作规则库', '约束内容生成质量和边界的规则集', {
    规则名: titleProp(),
    主题: selectProp(themeOptions),
    规则类型: selectProp(ruleTypeOptions),
    规则内容: richTextProp(),
    适用场景: multiSelectProp(ruleSceneOptions),
    示例: richTextProp(),
    优先级: selectProp(priorityOptions),
    是否通用规则: checkboxProp(),
    备注: richTextProp(),
  });

  for (const item of themes) {
    await ensurePage(themeDb.id, '主题名', item.title, item.props);
  }

  for (const [title, type, core, scenes, tone, priority, source, note] of knowledgeItems) {
    await ensurePage(knowledgeDb.id, '标题', title, {
      主题: sel('疗愈'),
      知识类型: sel(type),
      核心内容: rt(core),
      适用场景: msel(scenes),
      情绪基调: sel(tone),
      优先使用: chk(priority),
      来源: rt(source),
      备注: rt(note),
    });
  }

  for (const [title, type, content, why, tags, platforms, priority, note] of styleItems) {
    await ensurePage(styleDb.id, '样例标题', title, {
      主题: sel('疗愈'),
      样例类型: sel(type),
      样例内容: rt(content),
      为什么好: rt(why),
      风格标签: msel(tags),
      适合平台: msel(platforms),
      优先参考: chk(priority),
      来源链接: url(null),
      备注: rt(note),
    });
  }

  for (const [title, type, content, scenes, example, priority, common, note] of rules) {
    await ensurePage(ruleDb.id, '规则名', title, {
      主题: sel('疗愈'),
      规则类型: sel(type),
      规则内容: rt(content),
      适用场景: msel(scenes),
      示例: rt(example),
      优先级: sel(priority),
      是否通用规则: chk(common),
      备注: rt(note),
    });
  }

  console.log(
    JSON.stringify(
      {
        databases: {
          theme: { id: themeDb.id, name: themeDb.title?.[0]?.plain_text || '主题库' },
          knowledge: { id: knowledgeDb.id, name: knowledgeDb.title?.[0]?.plain_text || '知识点库' },
          style: { id: styleDb.id, name: styleDb.title?.[0]?.plain_text || '风格样例库' },
          rules: { id: ruleDb.id, name: ruleDb.title?.[0]?.plain_text || '写作规则库' },
        },
        seeded: {
          themes: themes.length,
          knowledge: knowledgeItems.length,
          styles: styleItems.length,
          rules: rules.length,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
