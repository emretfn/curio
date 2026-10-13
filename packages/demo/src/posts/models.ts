import { type PostSpec, photo, post, video } from "../post-spec.ts";

export const MODELS: PostSpec[] = [
  post(
    "radar",
    "Small models are now good enough to classify text at a fraction of a cent an item. If your pipeline sends everything to the largest model, measure the small one first.",
    "ai-models",
    "discussion",
    ["ai-pricing"],
  ),
  post(
    "okan",
    'Görsel üretiminde en işe yarar alışkanlık: her seferinde tek değişiklik istemek. "Arka planı değiştir" deyin, bakın, sonra "ışığı yumuşat" deyin. Uzun isteklerin sonucu rastgele oluyor.',
    "ai-models",
    "tip",
    ["image-generation", "prompts"],
    { lang: "tr" },
  ),
  post(
    "radar",
    "Prompt caching is the most ignored line on the pricing page. A long system prompt read from the cache costs about a tenth of the input price. Put what never changes first.",
    "ai-models",
    "tip",
    ["ai-pricing", "prompts"],
  ),
  post(
    "drawer",
    "A dinner prompt that works with any chat assistant: paste what is in the fridge, ask for three dinners, say which one, then ask for the shopping list of what is missing.",
    "ai-models",
    "guide",
    ["prompts", "chatgpt"],
    { key: "corrected-tags" },
  ),
  post(
    "radar",
    "I keep a table of which model I use for what this quarter: drafting, long documents, code review, images, transcripts. It changes every three months, which is the point. https://release-radar.example/table",
    "ai-models",
    "resource-list",
    ["chatgpt", "gemini"],
    {
      card: {
        title: "Which model for what, this quarter",
        description:
          "One table, five kinds of work, and a column for why last quarter's choice was replaced.",
      },
    },
  ),
  post(
    "okan",
    "Aynı istek, üç farklı model. En büyük fark hâlâ ışıkta ve dokuda çıkıyor.",
    "ai-models",
    "showcase",
    ["image-generation", "gemini"],
    {
      lang: "tr",
      media: [
        photo("Ahşap bir masada seramik fincan; ışık soldan ve sert."),
        photo("Aynı fincan; ışık yumuşak, gölgeler neredeyse yok."),
        photo("Aynı fincan; sırın dokusu belirgin, arka plan bulanık."),
      ],
    },
  ),
  post(
    "radar",
    "Benchmarks saturate, so everyone invents a new one. The only evaluation that matters to you is twenty examples from your own work, scored by you.",
    "ai-models",
    "discussion",
  ),
  post(
    "skeptic",
    "Used a chat assistant to prepare for a difficult conversation: it played the other person and I practised. It is embarrassing how much that helped.",
    "ai-models",
    "discussion",
    ["chatgpt"],
  ),
  post(
    "radar",
    "Structured outputs are now dependable enough to delete your JSON repair code. Give the schema, get the schema. The retry loop I kept alive for a year is gone.",
    "ai-models",
    "discussion",
    ["prompts"],
  ),
  post(
    "okan",
    "Thirty seconds of generated video from a single still. The camera move is convincing. The hands are not.",
    "ai-models",
    "showcase",
    ["image-generation"],
    {
      proposed: ["video-generation"],
      media: [
        video(
          30,
          "A slow camera move around a potter at a wheel. The clay and the light look real; the fingers merge and separate.",
        ),
      ],
    },
  ),
  post(
    "drawer",
    "A trick for long documents: ask for the summary last. Ask first for the claims, then for the evidence behind each, then for what is missing. The summary written after that is a different document.",
    "ai-models",
    "tip",
    ["prompts"],
  ),
  post(
    "radar",
    "Context windows grew. Attention did not grow with them. A million tokens in means you can paste the whole repository; it does not mean line 40,000 is weighed like line 40.",
    "ai-models",
    "discussion",
  ),
  post(
    "zeynep",
    "Toplantı notlarını yapay zekâya özetletirken tek kuralım: her karar ve sorumlusu ayrı bir satırda yazılsın. Özetin geri kalanını zaten kimse okumuyor.",
    "ai-models",
    "tip",
    ["prompts"],
    { lang: "tr" },
  ),
  post(
    "radar",
    "Embeddings are not search. They are one signal. The setups that work put keyword search beside the vectors and let a reranker decide between them.",
    "ai-models",
    "discussion",
    [],
    { proposed: ["embeddings"] },
  ),
  post(
    "okan",
    "The prompt that stopped my product photos looking generated: name the lens, the time of day and the surface the object stands on. Leave out every adjective.",
    "ai-models",
    "tip",
    ["image-generation", "prompts"],
  ),
  post(
    "skeptic",
    'Asked three assistants the same medical question. All three said "see a doctor", which was correct, and which I had known before asking. Progress.',
    "ai-models",
    "discussion",
    ["chatgpt", "gemini"],
    { key: "removed-on-x" },
  ),
];
