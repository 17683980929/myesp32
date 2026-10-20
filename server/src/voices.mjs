/**
 * voices.mjs — 腾讯云 TTS 音色目录（供 /admin 下拉菜单）
 *
 * 所有 verified: true 的条目都已用当前账号实际合成验证过；
 * 新增音色只需在这里追加，后台页面会自动按 group 渲染成 optgroup。
 */
export const VOICE_GROUPS = [
  {
    label: "超自然大模型音色",
    note: "情感最自然，消耗超自然资源包",
    voices: [
      { id: 402000, name: "云晓芙", desc: "聊天女声", verified: true },
      { id: 402001, name: "云小团", desc: "温柔甜美女声", verified: true },
      { id: 402002, name: "云大围", desc: "磁性男声", verified: true },
      { id: 403001, name: "云小和", desc: "亲和女声", verified: true },
      { id: 403002, name: "云小帅", desc: "解说男声", verified: true },
      { id: 502003, name: "智小敏", desc: "活力女声", verified: true },
      { id: 502005, name: "智小解", desc: "解说男声", verified: true },
      { id: 502006, name: "智小悟", desc: "阳光男声", verified: true },
    ],
  },
  {
    label: "大模型音色",
    note: "自然度高，消耗大模型资源包",
    voices: [
      { id: 101001, name: "智瑜", desc: "女声", verified: true },
      { id: 101004, name: "智云", desc: "男声", verified: true },
    ],
  },
  {
    label: "普通音色（精品/基础）",
    note: "价格低、免费额度大",
    voices: [
      { id: 1001, name: "智瑜", desc: "精品女声", verified: true },
      { id: 0, name: "基础女声1", desc: "基础音色", verified: true },
    ],
  },
];
