import { type PostSpec, photo, post, video } from "../post-spec.ts";

export const LIFE: PostSpec[] = [
  post(
    "notebook",
    'Interview advice from the other side of the table: we remember the candidate who said "I do not know, and here is how I would find out". We remember none of the perfect answers.',
    "life",
    "tip",
    ["career"],
  ),
  post(
    "skeptic",
    "Bought the expensive chair. My back hurts the same. What helped was a timer that makes me stand up every 40 minutes, which was free.",
    "life",
    "discussion",
  ),
  post(
    "notebook",
    'CV tip: open each line with what changed because of you, and then how. "Cut the build from 14 minutes to 3 by caching the dependency step" beats "Responsible for the build system".',
    "life",
    "tip",
    ["career"],
  ),
  post(
    "zeynep",
    "Özgeçmişte en sık yapılan hata görev listesi yazmak. Ne yaptığınızı değil, yaptığınız şeyin neyi değiştirdiğini yazın. Rakam varsa rakamla.",
    "life",
    "tip",
    ["career"],
    { lang: "tr" },
  ),
  post(
    "skeptic",
    "Watched six hours of documentary about container shipping instead of fixing my side project. No regrets. Logistics is the real distributed system.",
    "life",
    "discussion",
  ),
  post(
    "notebook",
    "How I learn a new codebase in a week: run it, break it on purpose, read the tests, then read the oldest file that is still in use. https://mid-career.example/first-week",
    "life",
    "guide",
    ["career"],
    {
      card: {
        title: "The first week in a codebase",
        description:
          "Five days, one thing to do on each, and the questions worth asking before the week is out.",
      },
    },
  ),
  post(
    "skeptic",
    "The sleep tracker says I slept badly. I felt fine until it told me. Uninstalled.",
    "life",
    "discussion",
  ),
  post(
    "notebook",
    "Negotiating, in one sentence: the first number you say should make you slightly uncomfortable, and then you stop talking.",
    "life",
    "tip",
    ["career"],
  ),
  post(
    "kaan",
    "Took a month off after shipping. The product did not collapse. Three customers asked where the updates were, which is the kindest thing anyone has said about it.",
    "life",
    "discussion",
  ),
  post(
    "skeptic",
    "Books that changed how I work, none of them about software: one on checklists in surgery, one on how buildings change after they are built, one on the history of the shipping container.",
    "life",
    "resource-list",
  ),
  post(
    "notebook",
    "Senior does not mean you know more answers. It means your questions arrive earlier, before the thing is built.",
    "life",
    "discussion",
    ["career"],
  ),
  post(
    "emir",
    "Yeni bir dil öğrenirken bende işe yarayan tek yöntem: her gün yirmi dakika, hep aynı saatte. Haftada bir gün üç saat çalışmaktan çok daha fazla yol aldım.",
    "life",
    "tip",
    [],
    { lang: "tr" },
  ),
];

/**
 * Filed under "other", for both of its reasons: a post that says too little
 * to tell, and a post that says enough and fits no category. The second kind
 * is here on purpose about one subject, hardware, which is how a missing
 * category shows up in a real library.
 */
export const OTHER: PostSpec[] = [
  post("kaan", "this 👇", "other", "unclear", [], {
    tooLittleText: true,
    quoteWithheld: true,
  }),
  post("selin", "https://selin-builds.example/x9", "other", "unclear", [], {
    tooLittleText: true,
    lang: "und",
  }),
  post("noor", "wow", "other", "unclear", [], {
    tooLittleText: true,
    media: [photo()],
  }),
  post("radar", "Big if true.", "other", "unclear", [], {
    tooLittleText: true,
  }),
  post("deniz", "saving this for later", "other", "unclear", [], {
    tooLittleText: true,
    media: [video(95)],
  }),
  post("elif", "Bunu kaydediyorum.", "other", "unclear", [], {
    tooLittleText: true,
    lang: "tr",
  }),
  post("tiny", "👀 https://tinytools.example/soon", "other", "unclear", [], {
    tooLittleText: true,
    lang: "und",
  }),
  post(
    "solder",
    "Reflow soldering on a hot plate from a kitchen shop: 180 seconds up to 150 °C, 60 seconds up to 230 °C, lift the board off. Twelve boards, one bridged pin.",
    "other",
    "showcase",
    [],
    { proposed: ["electronics"] },
  ),
  post(
    "solder",
    "The ESP32 that resets when Wi-Fi starts has a power problem, not a code problem. A 470 µF capacitor across the supply and it never reset again.",
    "other",
    "tip",
    [],
    { proposed: ["esp32"] },
  ),
  post(
    "solder",
    "Finished the e-paper weather display: an ESP32, a 4.2 inch panel, one update an hour, and a battery I last charged in March.",
    "other",
    "showcase",
    [],
    {
      proposed: ["esp32"],
      media: [
        photo(
          "A small grey screen in a wooden frame showing a temperature, a cloud and a three-day forecast.",
        ),
      ],
    },
  ),
  post(
    "homelab",
    'Measured how my sourdough starter rises with a time-lapse and a ruler, because I do not trust a recipe that says "until doubled". At 24 °C it peaks at 5 hours 40.',
    "other",
    "discussion",
  ),
  post(
    "skeptic",
    "The night sky app says the bright thing is Jupiter. With binoculars braced against a fence post you can see four of its moons as a row of dots. I am 41 and found this out today.",
    "other",
    "discussion",
  ),
  post(
    "solder",
    "Circuit board tip: assign every footprint before you route anything, print the board at full size on paper, and set the real parts on the printout.",
    "other",
    "tip",
    [],
    { proposed: ["electronics"] },
  ),
];
